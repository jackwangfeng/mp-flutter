'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');
const { installShaderWarmup, buildCombos, IDLE_MS, HEAVY_IDLE_MS, SLICE_BUDGET_MS } = require(path.join(RT, 'shader-warmup.js'));

/** 什么都接受的替身:可调用、可 new、任意属性都返回替身(模拟 CanvasKit 的枚举/构造器/方法)。 */
function anything(log, name) {
  const fn = function () {};
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 1;
      if (k === 'width' || k === 'height') return () => 12;
      return anything(log, name + '.' + String(k));
    },
    apply() { if (log) log.push(name); return anything(log, name + '()'); },
    construct() { return anything(log, 'new ' + name); },
  });
}

function makeFakeCK() {
  const calls = [];
  const draws = [];
  function Surface(w, h) { this.w = w; this.h = h; }
  Surface.prototype.flush = function () { calls.push('flush:' + this.w); };
  Surface.prototype.getCanvas = function () {
    return new Proxy({}, { get: (t, k) => (...a) => { draws.push(String(k)); return undefined; } });
  };
  const base = anything(null, 'CK');
  let grSeq = 0;
  const CK = new Proxy({
    Surface,
    MakeGrContext(h) { calls.push('makeGr:' + h); return { id: ++grSeq, isDeleted: () => false }; },
    MakeRenderTarget(gr, w, h) { calls.push('makeRT:' + gr.id + ':' + w + 'x' + h); return new Surface(w, h); },
    TypefaceFontProvider: function () {},
  }, { get: (t, k) => (k in t ? t[k] : base[k]), set: (t, k, v) => { t[k] = v; return true; } });
  CK.TypefaceFontProvider.prototype.registerFont = function () {};
  return { CK, calls, draws };
}

/** 可控时钟 + 手动定时器队列。 */
function makeTimers() {
  let t = 1000;
  const q = [];
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    setTimeout: (f, ms) => { q.push({ f, at: t + (ms || 0) }); },
    // 推进时间并跑到期的定时器
    run(ms, step) {
      const end = t + ms;
      while (t < end) {
        t += step || 10;
        for (let i = 0; i < q.length;) { if (q[i].at <= t) { const x = q.splice(i, 1)[0]; x.f(); } else i++; }
      }
    },
  };
}

test('共享 GrDirectContext:第一次之后的 MakeGrContext 都交回同一个(上下文丢失才放行新建)', () => {
  const { CK, calls } = makeFakeCK();
  let lost = false;
  const w = installShaderWarmup(CK, { gl: { isContextLost: () => lost }, setTimeout: () => {} });
  const a = CK.MakeGrContext(1);
  const b = CK.MakeGrContext(2);
  assert.strictEqual(a, b);
  assert.deepStrictEqual(calls, ['makeGr:1']);
  assert.strictEqual(w.stats.shared, 1);
  lost = true;
  const c = CK.MakeGrContext(3);
  assert.notStrictEqual(c, a);
});

test('首帧之前不预热;首帧 flush 之后空闲时逐组画在离屏目标上,用原始 flush,不经过外层包装', () => {
  const { CK, calls, draws } = makeFakeCK();
  const tm = makeTimers();
  const logs = [];
  const w = installShaderWarmup(CK, { dpr: 3, now: tm.now, setTimeout: tm.setTimeout, log: (l) => logs.push(l) });
  // 装好之后才包的外层 flush(boot 首帧钩子 / --verify / --perf-hud):预热不能经过它
  const inner = CK.Surface.prototype.flush;
  let outer = 0;
  CK.Surface.prototype.flush = function () { outer++; return inner.apply(this, arguments); };
  CK.MakeGrContext(1);
  tm.run(1000);
  assert.strictEqual(w.stats.started, false, '首帧前什么都不做');
  const screen = new CK.Surface(390, 844);
  screen.flush();   // 引擎首帧
  assert.strictEqual(outer, 1);
  tm.run(20000, 10);
  assert.strictEqual(w.stats.done, true);
  assert.strictEqual(outer, 1, '预热 flush 不经过外层包装');
  assert.ok(calls.some((c) => /^makeRT:1:/.test(c)), '离屏目标建在共享 GrDirectContext 上');
  assert.strictEqual(w.stats.combos, buildCombos(CK).length);
  assert.ok(draws.includes('scale') && draws.includes('clipRRect') && draws.includes('drawImageRectOptions') &&
    draws.includes('drawShadow') && draws.includes('saveLayer'), draws.join(','));
  assert.match(logs[logs.length - 1], /^\[mp-perf\] shader-warmup done combos=\d+\/\d+ busy=/);
});

test('引擎在画帧(最近 IDLE_MS 内 flush 过)时暂停,空闲后继续', () => {
  const { CK } = makeFakeCK();
  const tm = makeTimers();
  const w = installShaderWarmup(CK, { now: tm.now, setTimeout: tm.setTimeout });
  CK.MakeGrContext(1);
  const screen = new CK.Surface(390, 844);
  // 持续 2 秒每 16ms 一帧(滚动中)
  for (let i = 0; i < 125; i++) { screen.flush(); tm.run(16, 4); }
  assert.strictEqual(w.stats.combos, 0, '一直有帧就一组也不画');
  tm.run(20000, 10);
  assert.strictEqual(w.stats.done, true);
  assert.ok(w.stats.combos > 10);
  assert.ok(IDLE_MS >= 100);
});

test('单项失败不影响其余项,失败项记进 stats.failed(shadow 已拆成 opaque/transparent 两项,都调 drawShadow)', () => {
  const { CK } = makeFakeCK();
  const orig = CK.Surface.prototype.getCanvas;
  CK.Surface.prototype.getCanvas = function () {
    const c = orig.call(this);
    return new Proxy({}, { get: (t, k) => (k === 'drawShadow' ? () => { throw new Error('boom'); } : c[k]) });
  };
  const tm = makeTimers();
  const w = installShaderWarmup(CK, { now: tm.now, setTimeout: tm.setTimeout });
  CK.MakeGrContext(1);
  new CK.Surface(400, 400).flush();
  tm.run(20000, 10);
  assert.ok(w.stats.failed.some((f) => /^shadow-opaque:boom/.test(f)), w.stats.failed.join(';'));
  assert.ok(w.stats.failed.some((f) => /^shadow-transparent:boom/.test(f)), w.stats.failed.join(';'));
  assert.strictEqual(w.stats.combos, buildCombos(CK).length - 2);
});

test('每片(一次 tick)最多在轻项上花 SLICE_BUDGET_MS,超预算就停下让出主线程', () => {
  const { CK } = makeFakeCK();
  const tm = makeTimers();
  // 每次 getCanvas 调用(每项一次)都让虚拟时钟往前走 3ms,模拟"轻项也要花点时间"
  const origGetCanvas = CK.Surface.prototype.getCanvas;
  CK.Surface.prototype.getCanvas = function () { tm.advance(3); return origGetCanvas.call(this); };
  const ticks = [];
  const w = installShaderWarmup(CK, {
    now: tm.now,
    setTimeout: (f, ms) => { ticks.push(w.stats.combos); tm.setTimeout(f, ms); },
  });
  CK.MakeGrContext(1);
  new CK.Surface(400, 400).flush();
  tm.run(20000, 10);
  assert.strictEqual(w.stats.done, true);
  // 3ms/项、预算 SLICE_BUDGET_MS:一片最多画 floor(SLICE_BUDGET_MS/3)+1 个轻项,
  // 不会一次性把所有轻项都画完
  const maxLightPerSlice = Math.floor(SLICE_BUDGET_MS / 3) + 1;
  const deltas = ticks.slice(1).map((v, i) => v - ticks[i]).filter((d) => d > 0);
  assert.ok(deltas.every((d) => d <= maxLightPerSlice), 'deltas=' + deltas.join(','));
});

test('light 模式:整批跳过重项,不占用任何一片时间,只画轻项', () => {
  const { CK } = makeFakeCK();
  const tm = makeTimers();
  const all = buildCombos(CK);
  const heavyCount = all.filter((c) => c.heavy).length;
  const w = installShaderWarmup(CK, { now: tm.now, setTimeout: tm.setTimeout, light: true });
  CK.MakeGrContext(1);
  new CK.Surface(400, 400).flush();
  tm.run(20000, 10);
  assert.strictEqual(w.stats.done, true);
  assert.strictEqual(w.stats.heavyRun, 0);
  assert.strictEqual(w.stats.skipped, heavyCount);
  assert.strictEqual(w.stats.combos, all.length - heavyCount);
});

test('重项要求最近 HEAVY_IDLE_MS 内既没有 flush 也没有手指按着,比轻项的 IDLE_MS 更久才画', () => {
  const { CK } = makeFakeCK();
  assert.ok(HEAVY_IDLE_MS > IDLE_MS);
  const tm = makeTimers();
  const w = installShaderWarmup(CK, { now: tm.now, setTimeout: tm.setTimeout });
  CK.MakeGrContext(1);
  new CK.Surface(400, 400).flush();
  // 刚过 IDLE_MS(轻项能画了)但还没到 HEAVY_IDLE_MS:此时不应该有任何重项跑过
  tm.run(500, 10);
  assert.strictEqual(w.stats.heavyRun, 0, '还没到 HEAVY_IDLE_MS 就画了重项');
  tm.run(20000, 10);
  assert.strictEqual(w.stats.done, true);
  assert.ok(w.stats.heavyRun > 0);
});

test('pointerState.down>0 时整体暂停(即使已经空闲超过 IDLE_MS),松开手指后继续', () => {
  const { CK } = makeFakeCK();
  const tm = makeTimers();
  const pointerState = { down: 1 };
  const w = installShaderWarmup(CK, { now: tm.now, setTimeout: tm.setTimeout, pointerState });
  CK.MakeGrContext(1);
  new CK.Surface(400, 400).flush();
  tm.run(5000, 10);
  assert.strictEqual(w.stats.combos, 0, '手指按着就一项也不画');
  pointerState.down = 0;
  tm.run(20000, 10);
  assert.strictEqual(w.stats.done, true);
  assert.ok(w.stats.combos > 0);
});

test('CanvasKit 缺少必要入口时什么都不包', () => {
  const CK = { MakeGrContext: null };
  const w = installShaderWarmup(CK, {});
  assert.strictEqual(w.stats.started, false);
  assert.strictEqual(CK.MakeGrContext, null);
});
