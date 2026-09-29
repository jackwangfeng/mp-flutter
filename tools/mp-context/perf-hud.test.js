'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// perf-hud.js 不碰任何小程序专属全局(wx/window/self),纯函数式包装逻辑,
// 直接 require 即可单测,不需要 createMpContext 的 vm 沙箱。
const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');
const { createBootTimer, createPerfHud, createFrameProf, programDigest, glMethodNames, sfntWeight } = require(path.join(RT, 'perf-hud.js'));

/** 可控时钟:调用方手动推进 nowValue 模拟耗时。 */
function makeClock(start = 0) {
  let v = start;
  return { now: () => v, advance: (ms) => { v += ms; }, get value() { return v; } };
}

/** 假 canvas 节点:模拟小程序 canvas.requestAnimationFrame 的"下一帧回调排队"语义。 */
function makeFakeCanvas() {
  let pending = null;
  return {
    requestAnimationFrame(cb) { pending = cb; return 1; },
    cancelAnimationFrame() { pending = null; },
    fire(ts) {
      const cb = pending;
      pending = null;
      if (cb) cb(ts == null ? 0 : ts);
    },
  };
}

test('createBootTimer:mark() 打印阶段名 + 距 t0 偏移 + 本阶段耗时,finish() 打印 total', () => {
  const clock = makeClock(1000);
  const logs = [];
  const timer = createBootTimer({ t0: 1000, now: clock.now, log: (m) => logs.push(m) });

  clock.advance(50);
  const a = timer.mark('onLoad');
  assert.strictEqual(a.offset, 50);
  assert.strictEqual(a.dur, 50);

  clock.advance(120);
  const b = timer.mark('subpackage:pkg-wasm');
  assert.strictEqual(b.offset, 170);
  assert.strictEqual(b.dur, 120);

  clock.advance(30);
  timer.finish();

  assert.strictEqual(logs.length, 3);
  assert.match(logs[0], /^\[mp-boot\] onLoad \+50ms \(50ms\)$/);
  assert.match(logs[1], /^\[mp-boot\] subpackage:pkg-wasm \+170ms \(120ms\)$/);
  assert.match(logs[2], /^\[mp-boot\] total \+200ms$/);
});

test('createBootTimer:log 失败(console 不可用)不应向上抛异常', () => {
  const timer = createBootTimer({ t0: 0, now: () => 1, log: () => { throw new Error('no console'); } });
  assert.doesNotThrow(() => timer.mark('x'));
  assert.doesNotThrow(() => timer.finish());
});

test('glMethodNames:收集自身与原型链上的函数属性,不含常量/非函数属性', () => {
  function GlProto() {}
  GlProto.prototype.drawArrays = function () {};
  GlProto.prototype.bindTexture = function () {};
  const gl = new GlProto();
  gl.VERSION = 0x1f02;        // 常量,不应出现
  gl.readPixels = function () {}; // 实例自身的方法也要收
  const names = glMethodNames(gl);
  assert.ok(names.includes('drawArrays'));
  assert.ok(names.includes('bindTexture'));
  assert.ok(names.includes('readPixels'));
  assert.ok(!names.includes('VERSION'));
});

test('createPerfHud.report():fps = 窗口内帧数,avg/p95/max 按真实分布计算', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const setDataCalls = [];
  const hud = createPerfHud({
    canvas, gl: null, CK: null,
    setData: (patch) => setDataCalls.push(patch),
    now: clock.now, log: () => {},
  });

  const durations = [10, 12, 11, 48, 9]; // 5 帧,一帧 48ms(超过 50ms? 不算长任务,边界测试见下一条)
  durations.forEach((d) => {
    canvas.requestAnimationFrame(() => { clock.advance(d); });
    canvas.fire();
  });

  const r = hud.report();
  assert.strictEqual(r.fps, 5);
  const sum = durations.reduce((a, b) => a + b, 0);
  assert.strictEqual(Math.round(r.avg * 100) / 100, Math.round((sum / 5) * 100) / 100);
  assert.strictEqual(r.max, 48);
  // p95 用"向上取整"的分位:5 个数排序后取第 ceil(5*0.95)=5 个,即最大值
  assert.strictEqual(r.p95, 48);

  // report() 汇总一次后应重置窗口:再 report() 一次(无新帧)应得到 fps=0
  const r2 = hud.report();
  assert.strictEqual(r2.fps, 0);
  hud.stop();
});

test('长任务:一帧耗时超过 50ms 计入 longTasks', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const hud = createPerfHud({ canvas, gl: null, CK: null, setData: () => {}, now: clock.now, log: () => {} });

  [10, 51, 60, 20].forEach((d) => {
    canvas.requestAnimationFrame(() => { clock.advance(d); });
    canvas.fire();
  });
  const r = hud.report();
  assert.strictEqual(r.longTasks, 2);
  hud.stop();
});

test('gl 调用:按采样(每 10 帧完整统计一帧)只在采样帧计数计时,其余帧只透传', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  let drawCalls = 0;
  const gl = {
    drawArrays() { drawCalls++; clock.advance(1); },
  };
  const hud = createPerfHud({ canvas, gl, CK: null, setData: () => {}, now: clock.now, log: () => {} });

  // 10 帧一个采样周期:第 0 帧(frameSeq=0)被采样,1..9 不被采样。
  for (let i = 0; i < 10; i++) {
    canvas.requestAnimationFrame(() => {
      gl.drawArrays(); gl.drawArrays(); gl.drawArrays(); // 每帧都真的调用 3 次
      clock.advance(2); // 帧内其余工作
    });
    canvas.fire();
  }
  assert.strictEqual(drawCalls, 30, '包装不应该改变真实调用次数(只多计数/计时)');

  const r = hud.report();
  // 本窗口只有 1 个采样点(第 0 帧),该帧 3 次 gl 调用
  assert.strictEqual(r.glCallsPerFrame, 3);
  assert.ok(r.glMsPerFrame > 0, 'gl 调用本身推进了时钟,采样帧应计到非零耗时');
  hud.stop();
});

test('gl 包装不改变返回值(计数/计时只是外挂,不拦截结果)', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const gl = { getParameter: (p) => 'v:' + p };
  const hud = createPerfHud({ canvas, gl, CK: null, setData: () => {}, now: clock.now, log: () => {} });
  canvas.requestAnimationFrame(() => {});
  canvas.fire();
  assert.strictEqual(gl.getParameter(7), 'v:7');
  hud.stop();
});

test('图片解码:统计 count/ms,不改变解码结果;不改变原始调用参数透传', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const fakeImg = { width: () => 100, height: () => 200 };
  let seenBytes = null;
  const CK = {
    MakeImageFromEncoded(bytes) { seenBytes = bytes; clock.advance(3); return fakeImg; },
  };
  const hud = createPerfHud({ canvas, gl: null, CK, setData: () => {}, now: clock.now, log: () => {} });

  const bytes = new Uint8Array(1234);
  const img = CK.MakeImageFromEncoded(bytes);
  assert.strictEqual(img, fakeImg, '包装不应该改变解码返回值');
  assert.strictEqual(seenBytes, bytes, '包装不应该改变透传给原始实现的参数');

  const r = hud.report();
  assert.strictEqual(r.decodeCount, 1);
  assert.strictEqual(r.decodeMs, 3);
  hud.stop();
});

test('图片解码:单次超过 8ms 额外打一行明细(图片尺寸/字节数/耗时)', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const fakeImg = { width: () => 64, height: () => 32 };
  const CK = {
    MakeImageFromEncoded(bytes) { clock.advance(9); return fakeImg; }, // > DECODE_DETAIL_MS(8ms)
  };
  const logs = [];
  const hud = createPerfHud({ canvas, gl: null, CK, setData: () => {}, now: clock.now, log: (m) => logs.push(m) });

  const bytes = new Uint8Array(555);
  CK.MakeImageFromEncoded(bytes);

  const detail = logs.find((l) => l.indexOf('decode-slow') >= 0);
  assert.ok(detail, '应该打出明细行');
  assert.match(detail, /^\[mp-perf\] decode-slow 9\.0ms size=64x32 bytes=555$/);
  hud.stop();
});

test('图片解码:未超过 8ms 不打明细行', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const CK = { MakeImageFromEncoded() { clock.advance(2); return { width: () => 1, height: () => 1 }; } };
  const logs = [];
  const hud = createPerfHud({ canvas, gl: null, CK, setData: () => {}, now: clock.now, log: (m) => logs.push(m) });
  CK.MakeImageFromEncoded(new Uint8Array(1));
  assert.strictEqual(logs.find((l) => l.indexOf('decode-slow') >= 0), undefined);
  hud.stop();
});

test('动图解码路径 MakeAnimatedImageFromEncoded 存在时也一并包装计数', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const CK = { MakeAnimatedImageFromEncoded() { clock.advance(1); return {}; } };
  const hud = createPerfHud({ canvas, gl: null, CK, setData: () => {}, now: clock.now, log: () => {} });
  CK.MakeAnimatedImageFromEncoded(new Uint8Array(1));
  const r = hud.report();
  assert.strictEqual(r.decodeCount, 1);
  hud.stop();
});

test('dart~=(估算)= 帧均耗时 - gl 均耗时 - 发生在 rAF 回调内的解码按帧均摊(帧外解码不减,不再出负值)', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const gl = { draw() { clock.advance(2); } };
  const CK = { MakeImageFromEncoded() { clock.advance(4); return { width: () => 1, height: () => 1 }; } };
  const hud = createPerfHud({ canvas, gl, CK, setData: () => {}, now: clock.now, log: () => {} });

  // 第一帧:gl 2ms + 帧内解码 4ms + 其余 5ms = 11ms;帧外再解码一次 4ms(不减)
  canvas.requestAnimationFrame(() => { gl.draw(); CK.MakeImageFromEncoded(new Uint8Array(1)); clock.advance(5); });
  canvas.fire();
  CK.MakeImageFromEncoded(new Uint8Array(1));

  const r = hud.report();
  assert.strictEqual(r.fps, 1);
  assert.strictEqual(r.avg, 11);
  assert.strictEqual(r.glMsPerFrame, 2);
  assert.strictEqual(r.decodeMs, 8);
  assert.strictEqual(Math.round(r.dartEst * 100) / 100, 5);
  hud.stop();
});

test('GL:引擎实际用的上下文(shim.glContext)与 acquireGlContext 不是同一对象时两个都包,并打诊断', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const engineGl = { drawArrays() { clock.advance(1); } };
  const loaderGl = { drawArrays() {} };
  const logs = [];
  const hud = createPerfHud({ canvas, gl: engineGl, glAlt: loaderGl, CK: null, setData: () => {}, now: clock.now, log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => /gl 包装:1 个方法 \+ 1 个方法;引擎上下文与 acquireGlContext 不是同一对象/.test(l)), logs.join('\n'));
  canvas.requestAnimationFrame(() => { engineGl.drawArrays(); engineGl.drawArrays(); });
  canvas.fire();
  const r = hud.report();
  assert.strictEqual(r.glCallsPerFrame, 2, '引擎那个上下文的调用被计到');
  hud.stop();
});

test('GL:方法赋值不生效(只读宿主对象)时如实报告包不上的数量', () => {
  const gl = {};
  Object.defineProperty(gl, 'drawArrays', { value: function () {}, writable: false, enumerable: true });
  const logs = [];
  const hud = createPerfHud({ canvas: makeFakeCanvas(), gl, CK: null, setData: () => {}, now: () => 0, log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => /0 个方法\(1 个包不上\)/.test(l)), logs.join('\n'));
  hud.stop();
});

test('着色器编译与纹理上传始终计时(不受采样影响),图片源上传单独计数', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const gl = {
    compileShader() { clock.advance(30); },
    linkProgram() { clock.advance(20); },
    texImage2D() { clock.advance(3); },
  };
  const logs = [];
  const hud = createPerfHud({ canvas, gl, CK: null, setData: () => {}, now: clock.now, log: (m) => logs.push(m) });
  canvas.requestAnimationFrame(() => {});   // 第 0 帧(采样帧)
  canvas.fire();
  canvas.requestAnimationFrame(() => {      // 第 1 帧:不采样,编译照样计时
    gl.compileShader(); gl.linkProgram();
    gl.texImage2D(0, 0, 0, 0, 0, { width: 640, height: 480 });   // 图片源
    gl.texImage2D(0, 0, 0, 4, 4, 0, 0, 0, new Uint8Array(64));   // 像素源
    clock.advance(10);
  });
  canvas.fire();
  const r = hud.report();
  assert.strictEqual(r.shaderCount, 2);
  assert.strictEqual(r.shaderMs, 50);
  assert.strictEqual(r.uploadCount, 2);
  assert.strictEqual(r.uploadMs, 6);
  assert.strictEqual(r.uploadImgCount, 1);
  const lf = logs.find((l) => l.indexOf('long-frame') >= 0);
  assert.ok(lf, '66ms 的帧打长帧明细');
  assert.match(lf, /long-frame 66\.0ms upload=6\.0 shader=50\.0 other=10\.0/);
  hud.stop();
});

test('文字:字体解析/注册、段落排版计时并进长帧明细;字体 fetch 记等待时间', async () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  function Provider() {}
  Provider.prototype.registerFont = function () { clock.advance(12); };
  function Para() {}
  Para.prototype.layout = function () { clock.advance(40); };
  function Builder() {}
  Builder.prototype.build = function () { clock.advance(5); return new Para(); };
  const CK = {
    Typeface: { MakeFreeTypeFaceFromData: () => { clock.advance(25); return {}; } },
    FontMgr: { FromData: () => { clock.advance(1); return {}; } },
    TypefaceFontProvider: Provider, ParagraphBuilder: Builder, Paragraph: Para,
  };
  const resolvers = [];
  const win = { fetch: (u) => new Promise((r) => { resolvers.push(r); }) };
  const logs = [];
  const hud = createPerfHud({ canvas, gl: null, CK, fetchHosts: [win], setData: () => {}, now: clock.now, log: (m) => logs.push(m) });
  const p = win.fetch('mp-fonts/notosanssc/v36/k3k.0.ttf');
  win.fetch('api/list');   // 非字体不计
  clock.advance(300);
  resolvers.forEach((r) => r({}));
  await p; await Promise.resolve();
  canvas.requestAnimationFrame(() => {
    CK.Typeface.MakeFreeTypeFaceFromData(new ArrayBuffer(10));
    new Provider().registerFont(new Uint8Array(3), 'Noto');
    new Builder().build().layout(300);
  });
  canvas.fire();
  const r = hud.report();
  assert.strictEqual(r.fontFetchCount, 1);
  assert.strictEqual(r.fontFetchMs, 300);
  assert.strictEqual(r.fontParseCount, 2);
  assert.strictEqual(r.fontParseMs, 37);
  assert.strictEqual(r.layoutCount, 2);
  assert.strictEqual(r.layoutMs, 45);
  assert.ok(logs.some((l) => /font-fetch 300ms mp-fonts\/notosanssc/.test(l)));
  assert.ok(logs.some((l) => /font-parse 25\.0ms Typeface\.MakeFreeTypeFaceFromData bytes=10/.test(l)));
  assert.ok(logs.some((l) => /long-frame 82\.0ms fontParse=37\.0 layout=45\.0 other=0\.0/.test(l)), logs.join('\n'));
  hud.stop();
});

test('帧间隔超过 100ms:打 gap 明细,列出帧外的分项(原生解码同步部分等)', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  let sink = null;
  const images = { setStatsSink: (fn) => { sink = fn; } };
  const logs = [];
  const hud = createPerfHud({ canvas, gl: null, CK: null, images, setData: () => {}, now: clock.now, log: (m) => logs.push(m) });
  canvas.requestAnimationFrame(() => { clock.advance(5); });
  canvas.fire();
  sink({ type: 'native-decode', syncMs: 3, waitMs: 40, bytes: 100, w: 640, h: 640 });
  sink({ type: 'native-2d', ms: 9, w: 320, h: 320 });
  sink({ type: 'native-decode', syncMs: 10, waitMs: 0, bytes: 1, w: 1, h: 1 });
  clock.advance(150);
  canvas.requestAnimationFrame(() => { clock.advance(5); });
  canvas.fire();
  assert.ok(logs.some((l) => /gap 150ms\(帧外\) blocked=0 native=13\.0 scale2d=9\.0 other=128\.0/.test(l)), logs.join('\n'));
  const r = hud.report();
  assert.strictEqual(r.nativeCount, 2);
  assert.strictEqual(r.nativeSyncMs, 13);
  assert.strictEqual(r.nativeWaitMs, 40);
  assert.strictEqual(r.scaleCount, 1);
  assert.ok(logs.some((l) => /scale2d-slow 9\.0ms 320x320/.test(l)));
  hud.stop();
  assert.strictEqual(sink, null, 'stop() 取消统计回调');
});

test('setVisible:只改 mpPerf.visible(dot-path),不应覆盖 report() 写入的 fps/avg', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const setDataCalls = [];
  const hud = createPerfHud({
    canvas, gl: null, CK: null,
    setData: (patch) => setDataCalls.push(patch),
    now: clock.now, log: () => {},
  });
  hud.setVisible(false);
  assert.deepStrictEqual(setDataCalls[setDataCalls.length - 1], { 'mpPerf.visible': false });
  hud.setVisible(true);
  assert.deepStrictEqual(setDataCalls[setDataCalls.length - 1], { 'mpPerf.visible': true });
  hud.stop();
});

test('report():浮层不可见(setVisible(false))时不再经 setData 刷新面板,节省 setData 预算', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const setDataCalls = [];
  const hud = createPerfHud({
    canvas, gl: null, CK: null,
    setData: (patch) => setDataCalls.push(patch),
    now: clock.now, log: () => {},
  });
  hud.setVisible(false);
  setDataCalls.length = 0; // 只看 report() 期间是否还调用 setData
  canvas.requestAnimationFrame(() => { clock.advance(16); });
  canvas.fire();
  hud.report();
  assert.strictEqual(setDataCalls.length, 0);
  hud.stop();
});

test('stop():还原 canvas.requestAnimationFrame,不再持续包装', () => {
  const canvas = makeFakeCanvas();
  const orig = canvas.requestAnimationFrame;
  const hud = createPerfHud({ canvas, gl: null, CK: null, setData: () => {}, now: () => 0, log: () => {} });
  const wrapped = canvas.requestAnimationFrame;
  assert.notStrictEqual(wrapped, orig, 'createPerfHud 应该替换成包装过的 rAF');
  hud.stop();
  assert.notStrictEqual(canvas.requestAnimationFrame, wrapped, 'stop() 之后不应再是包装过的 rAF');
  // 还原后的行为应与原始实现一致(bind 过的引用与原函数引用不相等,但行为等价)
  let called = false;
  canvas.requestAnimationFrame(() => { called = true; });
  canvas.fire();
  assert.strictEqual(called, true);
});

test('start()/stop():用注入的 setIntervalFn/clearIntervalFn,周期到点调用 report 等价逻辑(打点一次)', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const timers = new Map();
  let seq = 1;
  const logs = [];
  const hud = createPerfHud({
    canvas, gl: null, CK: null, setData: () => {}, now: clock.now, log: (m) => logs.push(m),
    setIntervalFn: (fn, ms) => { const id = seq++; timers.set(id, fn); return id; },
    clearIntervalFn: (id) => timers.delete(id),
  });
  canvas.requestAnimationFrame(() => { clock.advance(16); });
  canvas.fire();
  hud.start();
  assert.strictEqual(timers.size, 1);
  timers.forEach((fn) => fn()); // 手动触发一次周期回调,等价于 1 秒到了
  assert.ok(logs.some((l) => l.indexOf('[mp-perf] fps=1') === 0));
  hud.stop();
  assert.strictEqual(timers.size, 0);
});

test('同一 vsync 的多个 rAF 回调(ts 相同)归为一帧:耗时相加,GL 采样按帧而不是按回调', () => {
  const clock = makeClock();
  const pending = [];
  const canvas = { requestAnimationFrame(cb) { pending.push(cb); return 1; } };
  const vsync = (ts) => { const cbs = pending.splice(0); cbs.forEach((cb) => cb(ts)); };
  let calls = 0;
  const gl = { drawArrays() { calls++; clock.advance(1); } };
  const hud = createPerfHud({ canvas, gl, CK: null, setData: () => {}, now: clock.now, log: () => {} });
  for (let f = 1; f <= 20; f++) {
    canvas.requestAnimationFrame(() => { clock.advance(1); });            // 轮询回调(不画)
    canvas.requestAnimationFrame(() => { gl.drawArrays(); gl.drawArrays(); clock.advance(3); });   // 引擎一帧
    vsync(f * 16);
  }
  const r = hud.report();
  assert.strictEqual(r.fps, 20, '20 个 vsync = 20 帧(不是 40 个回调)');
  assert.strictEqual(r.avg, 6, '每帧 = 轮询 1 + gl 2 + 其余 3');
  assert.strictEqual(r.glCallsPerFrame, 2, '采样帧包含引擎回调');
  assert.strictEqual(calls, 40);
  hud.stop();
});

test('心跳:主线程被长任务占住(定时器迟到 >50ms)计入 blocked,并让空闲间隔之外的 gap 明细打出来', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const timeouts = [];
  const logs = [];
  const hud = createPerfHud({ canvas, gl: null, CK: null, setData: () => {}, now: clock.now, log: (m) => logs.push(m),
    setIntervalFn: () => 1, clearIntervalFn: () => {},
    setTimeoutFn: (fn) => { timeouts.push(fn); return timeouts.length; }, clearTimeoutFn: () => {} });
  hud.start();
  canvas.requestAnimationFrame(() => { clock.advance(2); });
  canvas.fire();
  // 空闲 300ms(心跳准时):下一帧不打 gap
  for (let i = 0; i < 6; i++) { clock.advance(50); timeouts.shift()(); }
  canvas.requestAnimationFrame(() => {});
  canvas.fire();
  assert.ok(!logs.some((l) => l.includes('gap ')), '空闲间隔不打 gap');
  // 一个 400ms 的帧外长任务:心跳迟到 400
  clock.advance(450); timeouts.shift()();
  canvas.requestAnimationFrame(() => {});
  canvas.fire();
  assert.ok(logs.some((l) => /gap 450ms\(帧外\) blocked=400/.test(l)), logs.join('\n'));
  const r = hud.report();
  assert.strictEqual(r.blockedMs, 400);
  assert.strictEqual(r.blockedMax, 400);
  hud.stop();
});

test('字体集重建计为 fontChange(累计),每秒行报解析去重的复用次数', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  function Provider() {}
  Provider.Make = () => new Provider();
  const CK = { TypefaceFontProvider: Provider };
  const memo = { stats: { parses: 3, hits: 5 } };
  const logs = [];
  const hud = createPerfHud({ canvas, gl: null, CK, typefaceMemo: memo, setData: () => {}, now: clock.now, log: (m) => logs.push(m) });
  assert.ok(CK.TypefaceFontProvider.Make() instanceof Provider);
  memo.stats.hits = 9;
  let r = hud.report();
  assert.strictEqual(r.fontChangeCount, 1);
  assert.strictEqual(r.fontReuse, 9);
  assert.ok(logs.some((l) => /font-change #1/.test(l)));
  assert.ok(logs.some((l) => /\(reuse 9\) fontChange=1/.test(l)), logs.join('\n'));
  CK.TypefaceFontProvider.Make();
  r = hud.report();
  assert.strictEqual(r.fontChangeCount, 2);
  assert.strictEqual(r.fontReuse, 0);
  hud.stop();
});

/** 最小 sfnt:表目录只有 OS/2 一项,usWeightClass = [w]。 */
function sfnt(w) {
  const b = new Uint8Array(12 + 16 + 8);
  b.set([0, 1, 0, 0, 0, 1]);
  b.set([0x4F, 0x53, 0x2F, 0x32], 12);          // 'OS/2'
  b.set([0, 0, 0, 28], 12 + 8);                 // offset
  b[28 + 4] = w >> 8; b[28 + 5] = w & 255;
  return b;
}

test('sfntWeight:读 TTF/OTF 的 OS/2 字重;woff2/垃圾数据返回 0', () => {
  assert.strictEqual(sfntWeight(sfnt(700)), 700);
  assert.strictEqual(sfntWeight(sfnt(400).buffer), 400);
  assert.strictEqual(sfntWeight(new Uint8Array([0x77, 0x4F, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0])), 0);
  assert.strictEqual(sfntWeight(new Uint8Array(3)), 0);
  assert.strictEqual(sfntWeight(null), 0);
});

test('合成加粗计数:w≥600 且字体列表里没有注册过粗体的家族 → 长帧明细 fakeBold=N;粗体注册后不再计', async () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  function Provider() {}
  Provider.prototype.registerFont = function () {};
  function Builder() {}
  Builder.prototype.build = function () { clock.advance(30); return {}; };
  Builder.prototype.pushStyle = function () {};
  Builder.prototype.pushPaintStyle = function () {};
  Builder.MakeFromFontCollection = () => new Builder();
  const CK = { TypefaceFontProvider: Provider, ParagraphBuilder: Builder };
  const logs = [];
  const manifest = [{ family: 'App', fonts: [{ asset: 'a.ttf' }, { asset: 'b.ttf', weight: 700 }] },
    { family: 'MpNotoSansSC', fonts: [{ asset: 'r.ttf' }, { asset: 'bold.ttf', weight: 700 }] }];
  const cjkBold = { family: 'MpNotoSansSC', state: { status: 'late' } };
  const hud = createPerfHud({ canvas, gl: null, CK, setData: () => {}, now: clock.now, log: (m) => logs.push(m),
    fontInfo: { cjkBold, fetch: () => Promise.resolve({ json: () => Promise.resolve(manifest) }) } });
  await new Promise((r) => setTimeout(r, 0));
  const para = (w, fams, push) => {
    const b = Builder.MakeFromFontCollection({ textStyle: { fontFamilies: ['Roboto'], fontStyle: { weight: { value: 400 } } } });
    if (push) b.pushPaintStyle({ fontFamilies: fams, fontStyle: { weight: { value: w } } }, null, null);
    else b.pushStyle({ fontFamilies: fams, fontStyle: { weight: { value: w } } });
    b.build();
  };
  canvas.requestAnimationFrame(() => {
    para(700, ['Roboto', 'MpNotoSansSC'], false);    // 计:MpNotoSansSC 粗体没注册上(晚到)
    para(600, ['X', 'MpNotoSansSC'], true);          // 计
    para(500, ['MpNotoSansSC'], false);              // 不计:w500 不合成
    para(700, ['App', 'MpNotoSansSC'], false);       // 不计:业务字体清单声明了 700
  });
  canvas.fire(16);
  assert.strictEqual(hud.report().fakeBoldCount, 2);
  assert.ok(logs.some((l) => /long-frame 120\.0ms layout=120\.0 fakeBold=2 /.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /layout=4\/120\.0\(fakeBold 2\)/.test(l)), logs.join('\n'));
  // 粗体补注册:引擎重建字体集时 registerFont 带上字重 700 的字节
  new Provider().registerFont(sfnt(700), 'MpNotoSansSC');
  canvas.requestAnimationFrame(() => { para(700, ['Roboto', 'MpNotoSansSC'], false); clock.advance(40); });
  canvas.fire(48);
  assert.strictEqual(hud.report().fakeBoldCount, 0);
  hud.stop();
});

test('programDigest:顶点 attribute 名 + 片元 uniform 名(去掉 _S0/_c0 后缀)+ 源码哈希', () => {
  const vs = 'attribute highp vec2 inPosition;\nin mediump vec4 inColor;\nvoid main(){ gl_Position = vec4(0.0); }';
  const fs = 'uniform highp vec4 uinnerRect_S1_c0;\nuniform mediump vec2 uradiusPlusHalf_S1_c0;\nuniform sampler2D uTextureSampler_0_S0;\nvoid main(){}';
  const d = programDigest(vs, fs);
  assert.deepStrictEqual(d.attrs, ['inPosition', 'inColor']);
  assert.deepStrictEqual(d.unis, ['uinnerRect', 'uradiusPlusHalf', 'uTextureSampler_0']);
  assert.match(d.hash, /^[0-9a-f]{8}$/);
  assert.notStrictEqual(programDigest(vs, fs + ' ').hash, d.hash);
});

test('program 日志:每个 program 一行(编译总耗时 + 摘要),report 行带累计 programs=', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  let id = 0;
  const gl = {
    createShader() { return { id: ++id }; },
    shaderSource() {},
    compileShader() { clock.advance(10); },
    attachShader() {},
    linkProgram() { clock.advance(5); },
    getProgramParameter() { clock.advance(1); return true; },
  };
  const logs = [];
  const hud = createPerfHud({ canvas, gl, CK: null, setData: () => {}, now: clock.now, log: (m) => logs.push(m) });
  canvas.requestAnimationFrame(() => {
    const prog = {};
    const v = gl.createShader(); gl.shaderSource(v, 'attribute vec2 inPosition; void main(){gl_Position=vec4(0);}');
    gl.compileShader(v);
    const f = gl.createShader(); gl.shaderSource(f, 'uniform vec4 ucolor_S0; void main(){}');
    gl.compileShader(f);
    gl.attachShader(prog, v); gl.attachShader(prog, f);
    gl.linkProgram(prog); gl.getProgramParameter(prog, 0x8B82);
  });
  canvas.fire();
  canvas.requestAnimationFrame(() => {});
  canvas.fire();
  const line = logs.find((l) => l.indexOf('[mp-perf] program #1') === 0);
  assert.ok(line, logs.join('\n'));
  assert.match(line, /program #1 26\.0ms [0-9a-f]{8} attrs=inPosition unis=ucolor/);
  hud.report();
  assert.ok(logs.some((l) => /programs=1\/26\.0/.test(l)));
  hud.stop();
});

test('框架帧分项:入口包装报的 build/layout/paint… 进长帧明细,other 扣掉框架与光栅化', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const frameProf = createFrameProf();
  const logs = [];
  const hud = createPerfHud({ canvas, gl: null, CK: null, frameProf, setData: () => {}, now: clock.now, log: (m) => logs.push(m) });
  canvas.requestAnimationFrame(() => {
    clock.advance(80);
    frameProf.frame(5, 40, 20, 1, 8, 3, 0, 0, 2, 1, 300);
  });
  canvas.fire(16);
  canvas.requestAnimationFrame(() => {});
  canvas.fire(32);
  const lf = logs.find((l) => l.indexOf('long-frame') >= 0);
  assert.ok(lf, logs.join('\n'));
  assert.match(lf, /long-frame 80\.0ms dart=79\.0\(transient 5\.0, build 40\.0, layout 20\.0, bits 1\.0, paint 8\.0, comp 3\.0, post 2\.0\) metrics=1 inset=300 raster=0\.0 \|/);
  assert.match(lf, /other=1\.0$/);
  hud.stop();
});

test('光栅化在回调返回后的微任务里:getCanvas→flush 并入当前帧(raster=),其中的着色器编译算帧内', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  function Surface() {}
  Surface.prototype.getCanvas = function () { return {}; };
  Surface.prototype.flush = function () {};
  const CK = { Surface };
  const gl = { compileShader() { clock.advance(30); } };
  const logs = [];
  const hud = createPerfHud({ canvas, gl, CK, setData: () => {}, now: clock.now, log: (m) => logs.push(m) });
  const s = new Surface();
  canvas.requestAnimationFrame(() => { clock.advance(10); });
  canvas.fire(16);
  // 引擎异步光栅化:回调返回之后
  s.getCanvas(); gl.compileShader(); clock.advance(20); s.flush();
  clock.advance(5);
  canvas.requestAnimationFrame(() => {});
  canvas.fire(32);
  const lf = logs.find((l) => l.indexOf('long-frame') >= 0);
  assert.ok(lf, logs.join('\n'));
  assert.match(lf, /long-frame 60\.0ms shader=30\.0/);
  assert.ok(!logs.some((l) => l.indexOf('gap') >= 0), '光栅化不再记成帧外');
  hud.stop();
});

test('note():文本桥耗时 tb=、setData 次数/字节、resize 次数进帧外明细', () => {
  const clock = makeClock();
  const canvas = makeFakeCanvas();
  const logs = [];
  const hud = createPerfHud({ canvas, gl: null, CK: null, setData: () => {}, now: clock.now, log: (m) => logs.push(m), heartbeat: false });
  canvas.requestAnimationFrame(() => {});
  canvas.fire(16);
  clock.advance(150);
  hud.note('tb', 12); hud.note('setData', 9, 240); hud.note('resize');
  canvas.requestAnimationFrame(() => {});
  canvas.fire(32);
  const gap = logs.find((l) => l.indexOf('gap') >= 0);
  assert.ok(gap, logs.join('\n'));
  assert.match(gap, /tb=21\.0 setData=1\/240B resize=1/);
  hud.stop();
});
