'use strict';
/**
 * --perf-hud 真机性能测量(默认关,CLI flag / `mp_flutter.yaml` 的 `perf_hud`)。
 *
 * 只做测量,不改变任何渲染行为——所有埋点都是"读时间戳/计数"式的外部包装
 * (与 `pipeline.dart` 里 `--verify` 专用的像素上报 `_verifySnippet` 同一手法:
 * 包一层 `Surface.prototype.flush`/`CanvasKit.MakeImageFromEncoded`,不碰引擎
 * 内部逻辑),不重排、不跳过任何引擎调用。
 *
 * 关闭时零开销:本文件与 boot.js/image.js 完全独立——不修改它们的源码,只在
 * `--perf-hud` 打开时才由承载页(见 `pipeline.dart` `buildHostPageJs`)
 * `require` 本模块并调用;不 require 就不会被小程序 JS 引擎解析/执行,和
 * `semantics-mirror.js` 的注入方式一致。
 *
 * 两部分:
 *   - `createBootTimer`:冷启动阶段耗时(`[mp-boot]` 一行/阶段 + 结束时的
 *     `[mp-boot] total`),配合 `boot.js` 里几个可选的 `onStage` 调用点
 *     (那几个调用点本身只有一次 `typeof === 'function'` 判断,发生在应用
 *     整个生命周期里个位数次,不是热路径,`--perf-hud` 关闭时开销可忽略)。
 *   - `createPerfHud`:稳态每秒一行的 `[mp-perf]`(fps / 帧耗时 / gl 调用 /
 *     图片解码(wasm 与原生)/ 纹理上传 / 着色器编译 / 字体 fetch 与解析 /
 *     段落排版 / 长任务),外挂式包装 `canvas.requestAnimationFrame`、WebGL
 *     上下文的方法、`CanvasKit.MakeImageFromEncoded`(以及动图解码
 *     `MakeAnimatedImageFromEncoded`)、Typeface/FontMgr/registerFont、
 *     ParagraphBuilder.build/Paragraph.layout、window/self.fetch(只计字体 URL)。
 *     超过 50ms 的帧打一行 `long-frame` 分项明细,两帧间隔超过 100ms 打一行
 *     `gap` 分项明细(帧外做了什么),用来在真机上拆开长帧。
 *
 * gl 包装本身有恒定开销(每次调用多一层函数间接 + 一次 sampling 判断),用
 * 采样把"计时"这部分开销压到 1/GL_SAMPLE_EVERY 帧;"计数"意义不大的分支判断
 * 本身在 --perf-hud 打开时无法避免,符合需求"包装本身的开销,只包计数和计时,
 * 可以用采样方式"的要求。
 */

/** 每隔几帧完整统计一次 gl 调用次数/耗时(其余帧只跑原始调用,不计时)。 */
const GL_SAMPLE_EVERY = 10;
/** 一帧超过这个耗时算一次长任务。 */
const LONG_TASK_MS = 50;
/** 单次图片解码超过这个耗时,额外打一行明细。 */
const DECODE_DETAIL_MS = 8;
/** 汇总/setData 周期。 */
const REPORT_INTERVAL_MS = 1000;

/** 冷启动阶段计时器:每次 `mark(stage)` 打一行 `[mp-boot] <stage> +<距 t0 ms> (<本阶段 ms>)`。 */
function createBootTimer(opts) {
  const t0 = opts.t0;
  const now = opts.now || Date.now;
  const log = opts.log || console.log;
  let last = t0;

  function mark(stage) {
    const n = now();
    const offset = n - t0;
    const dur = n - last;
    last = n;
    try { log('[mp-boot] ' + stage + ' +' + offset + 'ms (' + dur + 'ms)'); } catch (e) { /* console 不可用不影响计时 */ }
    return { offset: offset, dur: dur };
  }

  function finish() {
    const n = now();
    try { log('[mp-boot] total +' + (n - t0) + 'ms'); } catch (e) { /* 同上 */ }
  }

  return { mark: mark, finish: finish };
}

/** 递归收集 [gl] 自身与原型链上所有函数属性名(WebGL 方法通常挂在原型上)。 */
function glMethodNames(gl) {
  const names = new Set();
  for (const k in gl) { if (typeof gl[k] === 'function') names.add(k); }
  let proto = Object.getPrototypeOf(gl);
  while (proto && proto !== Object.prototype) {
    Object.getOwnPropertyNames(proto).forEach(function (k) {
      if (typeof gl[k] === 'function') names.add(k);
    });
    proto = Object.getPrototypeOf(proto);
  }
  return Array.from(names);
}

/** 始终计时(不采样)的 gl 调用:着色器/程序编译(真机首帧的大头嫌疑)。 */
const SHADER_METHODS = { compileShader: 1, linkProgram: 1, getShaderParameter: 1, getProgramParameter: 1, shaderSource: 1 };
/** 始终计时的纹理上传(次数少):源是原生图片对象时 texImage2D 可能在这里同步解码。 */
const UPLOAD_METHODS = { texImage2D: 1, texSubImage2D: 1 };
/** 两次 rAF 回调之间超过这个间隔,打一行 gap 明细(帧外做了什么)。 */
const GAP_MS = 100;
/** 主线程占用心跳间隔。 */
const HEARTBEAT_MS = 50;
/** 单次字体解析/注册、段落排版超过这个耗时额外打明细。 */
const TEXT_DETAIL_MS = 8;

/** 分项计时的类别(长帧/间隔明细与每秒汇总共用)。 */
const CATS = ['decode', 'native', 'scale2d', 'upload', 'shader', 'fontParse', 'layout'];
function emptyAcc() {
  const a = {};
  CATS.forEach(function (k) { a[k] = 0; });
  a.fakeBold = 0;   // 计数(不是耗时):本帧 build 的合成加粗段落数,见 wrapFakeBold
  return a;
}
function accText(acc) {
  return CATS.filter(function (k) { return acc[k] >= 0.05; })
    .map(function (k) { return k + '=' + acc[k].toFixed(1); }).join(' ') +
    (acc.fakeBold ? ' fakeBold=' + acc.fakeBold : '');
}

/**
 * 包一层 [gl] 的每个方法:普通调用只有 `state.sampling` 为真的那一帧才计次数/计时,
 * 其余帧直接透传;着色器编译与图片纹理上传始终计时(次数少、是卡顿嫌疑)。
 * 返回 { wrapped, failed }:赋值没生效的方法数(宿主对象只读时)。
 */
function wrapGl(gl, state, now, add) {
  let wrapped = 0, failed = 0;
  glMethodNames(gl).forEach(function (name) {
    const orig = gl[name];
    const cat = SHADER_METHODS[name] ? 'shader' : (UPLOAD_METHODS[name] ? 'upload' : null);
    const fn = function () {
      if (cat) {
        const t = now();
        const r = orig.apply(gl, arguments);
        const d = now() - t;
        add(cat, d);
        if (cat === 'upload') {
          const src = arguments[arguments.length - 1];
          if (src != null && typeof src === 'object' && !ArrayBuffer.isView(src)) {   // 图片对象(原生解码)
            state.uploadImgCount++;
            state.uploadImgMs += d;
            if (d > DECODE_DETAIL_MS && state.log) {
              try { state.log('[mp-perf] upload-slow ' + d.toFixed(1) + 'ms image ' + (src.width | 0) + 'x' + (src.height | 0)); } catch (e) { /* 忽略 */ }
            }
          }
        }
        if (state.sampling) { state.glCalls++; state.glMs += d; }
        return r;
      }
      if (!state.sampling) return orig.apply(gl, arguments);
      const t0 = now();
      const r = orig.apply(gl, arguments);
      state.glCalls++;
      state.glMs += now() - t0;
      return r;
    };
    try { gl[name] = fn; } catch (e) { /* 只读 */ }
    if (gl[name] === fn) wrapped++; else failed++;
  });
  return { wrapped: wrapped, failed: failed };
}

/** 包一层 obj[name](存在才包):计时后交给 onDone(ms, args, result)。 */
function timeMethod(obj, name, now, onDone) {
  if (!obj) return false;
  const orig = obj[name];
  if (typeof orig !== 'function') return false;
  obj[name] = function () {
    const t0 = now();
    const r = orig.apply(this, arguments);
    onDone(now() - t0, arguments, r);
    return r;
  };
  return true;
}

function byteLen(b) {
  if (!b) return '?';
  if (b.length != null) return b.length;
  if (b.byteLength != null) return b.byteLength;
  return '?';
}

/**
 * 包一层 [CK] 的静态图/动图解码入口:image.js 的 wasm 解码与引擎自己的动图路径
 * 都经同一个 CK 对象,包一次即可全部覆盖。
 */
function wrapDecode(CK, state, now, log, add) {
  ['MakeImageFromEncoded', 'MakeAnimatedImageFromEncoded'].forEach(function (name) {
    timeMethod(CK, name, now, function (dur, args, img) {
      state.decodeCount++;
      state.decodeMs += dur;
      add('decode', dur);
      if (dur > DECODE_DETAIL_MS) {
        let w = '?', h = '?';
        try { if (img) { w = img.width(); h = img.height(); } } catch (e) { /* 解码失败(img=null)时保持 ? */ }
        const len = byteLen(args[0]);
        try {
          log('[mp-perf] decode-slow ' + dur.toFixed(1) + 'ms size=' + w + 'x' + h + ' bytes=' + len);
        } catch (e) { /* console 不可用不影响统计 */ }
      }
    });
  });
}

/**
 * 文字相关:字体解析/注册(Typeface 创建、FontMgr、TypefaceFontProvider.registerFont)
 * 与段落排版(ParagraphBuilder.build / Paragraph.layout,首次用到新字体时 FreeType
 * 解析也落在这里)。
 */
function wrapText(CK, state, now, log, add) {
  const parse = function (api) {
    return function (dur, args) {
      state.fontParseCount++;
      state.fontParseMs += dur;
      add('fontParse', dur);
      if (dur > TEXT_DETAIL_MS) {
        try { log('[mp-perf] font-parse ' + dur.toFixed(1) + 'ms ' + api + ' bytes=' + byteLen(args[0])); } catch (e) { /* 忽略 */ }
      }
    };
  };
  const layout = function (api) {
    return function (dur) {
      state.layoutCount++;
      state.layoutMs += dur;
      add('layout', dur);
      if (dur > TEXT_DETAIL_MS * 4) {
        try { log('[mp-perf] layout-slow ' + dur.toFixed(1) + 'ms ' + api); } catch (e) { /* 忽略 */ }
      }
    };
  };
  if (CK.Typeface) timeMethod(CK.Typeface, 'MakeFreeTypeFaceFromData', now, parse('Typeface.MakeFreeTypeFaceFromData'));
  if (CK.Typeface) timeMethod(CK.Typeface, 'MakeTypefaceFromData', now, parse('Typeface.MakeTypefaceFromData'));
  if (CK.FontMgr) timeMethod(CK.FontMgr, 'FromData', now, parse('FontMgr.FromData'));
  if (CK.TypefaceFontProvider && CK.TypefaceFontProvider.prototype) {
    timeMethod(CK.TypefaceFontProvider.prototype, 'registerFont', now, parse('TypefaceFontProvider.registerFont'));
  }
  // 字体集重建:引擎每注册一批回退字体(或业务 loadFontFromList)都新建一个
  // TypefaceFontProvider,紧接着发 fontsChange,框架把所有段落重排一遍。首帧前
  // 清单字体那次重建不发 fontsChange,而本包装在 boot 之后才装,所以这里数到
  // 的次数就是 fontsChange 次数。
  if (CK.TypefaceFontProvider && typeof CK.TypefaceFontProvider.Make === 'function') {
    const origMake = CK.TypefaceFontProvider.Make;
    CK.TypefaceFontProvider.Make = function () {
      state.fontChangeCount++;
      try { log('[mp-perf] font-change #' + state.fontChangeCount + '(回退字体注册 → 字体集重建 → 全部段落重排)'); } catch (e) { /* 忽略 */ }
      return origMake.apply(this, arguments);
    };
  }
  if (CK.ParagraphBuilder && CK.ParagraphBuilder.prototype) {
    timeMethod(CK.ParagraphBuilder.prototype, 'build', now, layout('ParagraphBuilder.build'));
  }
  if (CK.Paragraph && CK.Paragraph.prototype) timeMethod(CK.Paragraph.prototype, 'layout', now, layout('Paragraph.layout'));
}

/**
 * sfnt(TTF/OTF)字节里 OS/2 表的 usWeightClass;不是 sfnt(woff/woff2 表数据
 * 是压缩的)或读不到时返回 0。只读表目录,开销是几十次字节读。
 */
function sfntWeight(data) {
  try {
    let u8 = null;
    if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') u8 = new Uint8Array(data);
    else if (data && data.buffer && typeof data.byteOffset === 'number') u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!u8 || u8.length < 12) return 0;
    const u32 = function (o) { return ((u8[o] << 24) >>> 0) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3]; };
    const tag = u32(0);
    if (tag !== 0x00010000 && tag !== 0x4F54544F && tag !== 0x74727565) return 0;   // \0\1\0\0 / OTTO / true
    const n = (u8[4] << 8) | u8[5];
    for (let i = 0; i < n; i++) {
      const rec = 12 + i * 16;
      if (rec + 16 > u8.length) return 0;
      if (u32(rec) === 0x4F532F32) {   // 'OS/2'
        const off = u32(rec + 8);
        return off + 6 <= u8.length ? ((u8[off + 4] << 8) | u8[off + 5]) : 0;
      }
    }
  } catch (e) { /* 读不到按未知 */ }
  return 0;
}

/**
 * 合成加粗计数(cjk_font_bold 的诊断):段落里有字重 ≥600 的样式、而它的
 * fontFamilies 里没有一个家族注册过 ≥600 的字体时,SkParagraph 只能合成加粗
 * (SkFont embolden,每个字形首次出现都要逐点加粗轮廓,见 cjk_font.dart)。
 * 长帧/间隔明细里记作 `fakeBold=N`(本帧 build 的这类段落数)。
 *
 * 哪些家族有粗体:
 *   · TypefaceFontProvider.registerFont 时读字体 OS/2 字重(只认 TTF/OTF;
 *     引擎回退分片是 woff2,读不到,它们本来也都是常规字重)——引擎每次重建
 *     字体集(回退字体到达、loadFontFromList)都会把全部字体重新注册一遍;
 *   · 首帧前那次注册发生在本 HUD 装上之前,补两条来源:合一字体粗体看 boot
 *     的实际结果([fontInfo.cjkBold],随清单注册成功才算);业务字体看
 *     FontManifest.json 里声明的 weight(pubspec 里写了 weight: 700 才有)。
 * 近似:按"段落字体列表里任一家族有粗体"判断,不追到具体字符落在哪个家族
 * (合一字体排在所有回退分片之前,中文基本都落在它上面)。
 */
function wrapFakeBold(CK, state, fontInfo) {
  const PB = CK.ParagraphBuilder;
  if (!PB || !PB.prototype || typeof WeakMap !== 'function') return false;
  const bold = state.boldFamilies;
  const info = fontInfo || {};
  const cjk = info.cjkBold;
  if (cjk && cjk.state && (cjk.state.status === 'served' || cjk.state.status === 'late-loaded')) bold[cjk.family] = true;
  if (typeof info.fetch === 'function') {
    try {
      Promise.resolve(info.fetch('assets/FontManifest.json')).then(function (r) { return r && r.json ? r.json() : null; }).then(function (doc) {
        (Array.isArray(doc) ? doc : []).forEach(function (f) {
          if (!f || typeof f.family !== 'string' || (cjk && f.family === cjk.family)) return;
          (f.fonts || []).forEach(function (a) { if (a && +a.weight >= 600) bold[f.family] = true; });
        });
      }).then(null, function () { /* 读不到清单只是少一条来源 */ });
    } catch (e) { /* 同上 */ }
  }
  if (CK.TypefaceFontProvider && CK.TypefaceFontProvider.prototype) {
    const proto = CK.TypefaceFontProvider.prototype;
    const origReg = proto.registerFont;
    if (typeof origReg === 'function') {
      proto.registerFont = function (data, family) {
        if (typeof family === 'string' && !bold[family] && sfntWeight(data) >= 600) bold[family] = true;
        return origReg.apply(this, arguments);
      };
    }
  }
  const meta = new WeakMap();
  const note = function (b, ts) {
    if (!b || !ts) return;
    let m = meta.get(b);
    if (!m) { m = { w: 0, fams: [] }; meta.set(b, m); }
    const w = ts.fontStyle && ts.fontStyle.weight;
    const v = w == null ? 0 : (typeof w === 'number' ? w : +w.value);
    if (v > m.w) m.w = v;
    const fams = ts.fontFamilies;
    if (fams && fams.length) for (let i = 0; i < fams.length; i++) if (m.fams.indexOf(fams[i]) < 0) m.fams.push(fams[i]);
  };
  ['MakeFromFontCollection', 'MakeFromFontProvider', 'Make'].forEach(function (name) {
    const orig = PB[name];
    if (typeof orig !== 'function') return;
    PB[name] = function (style) {
      const b = orig.apply(this, arguments);
      try { note(b, style && style.textStyle); } catch (e) { /* 忽略 */ }
      return b;
    };
  });
  ['pushStyle', 'pushPaintStyle'].forEach(function (name) {
    const orig = PB.prototype[name];
    if (typeof orig !== 'function') return;
    PB.prototype[name] = function (ts) {
      try { note(this, ts); } catch (e) { /* 忽略 */ }
      return orig.apply(this, arguments);
    };
  });
  const origBuild = PB.prototype.build;
  if (typeof origBuild === 'function') {
    PB.prototype.build = function () {
      const m = meta.get(this);
      if (m && m.w >= 600 && !m.fams.some(function (f) { return bold[f]; })) {
        state.acc.fakeBold++;
        state.fakeBoldCount++;
      }
      return origBuild.apply(this, arguments);
    };
  }
  return true;
}

const FONT_URL = /\.(ttf|otf|woff2?)(\?|#|$)|mp-fonts\//i;

/** 包一层 host.fetch:字体 URL 记录从发起到拿到响应的等待时间(不占主线程,单独列出)。 */
function wrapFontFetch(hosts, state, now, log) {
  (hosts || []).forEach(function (host) {
    if (!host || typeof host.fetch !== 'function' || host.fetch.__mpPerf) return;
    const orig = host.fetch;
    const fn = function (input) {
      const url = String(input && input.url ? input.url : input);
      const p = orig.apply(this, arguments);
      if (!FONT_URL.test(url) || !p || typeof p.then !== 'function') return p;
      const t0 = now();
      state.fontFetchPending++;
      const done = function () {
        const d = now() - t0;
        state.fontFetchPending--;
        state.fontFetchCount++;
        state.fontFetchMs += d;
        try { log('[mp-perf] font-fetch ' + d.toFixed(0) + 'ms ' + url.slice(-80)); } catch (e) { /* 忽略 */ }
      };
      p.then(done, done);
      return p;
    };
    fn.__mpPerf = true;
    host.fetch = fn;
  });
}

/**
 * 包一层小程序 canvas 节点的 `requestAnimationFrame`——`bom-shim.js` 的
 * `window.requestAnimationFrame`/`self.requestAnimationFrame` 都只是转发到
 * 这一个真实节点方法(见该文件),包这一处即可捕获所有帧,不必分别包
 * window/self 两个转发闭包,也不会因为两条转发路径都存在而重复计数。
 *
 * 分项计时(state.acc)在帧边界切开:回调开始时 acc 里是"上一帧结束到这一帧
 * 开始之间"(帧外)的工作,结束时是帧内的工作。长帧与长间隔各打一行明细。
 */
function wrapCanvasRaf(canvas, state, now, log) {
  const orig = canvas.requestAnimationFrame.bind(canvas);
  canvas.requestAnimationFrame = function (cb) {
    return orig(function (ts) {
      const start = now();
      // 同一 vsync 里有多个 rAF 回调(引擎一帧 + 原生视图同步/文本桥等轮询),
      // 按回调参数 ts 相同归为一帧:帧耗时是这些回调之和,采样也按帧决定——
      // 否则每 10 个回调采样一次可能永远落在不画东西的轮询回调上(GL 恒为 0)。
      const sameFrame = state.cur && typeof ts === 'number' && ts > 0 && ts === state.cur.ts;
      if (!sameFrame) {
        finishFrame(state, log);
        const idx = state.frameSeq++;
        state.sampling = (idx % GL_SAMPLE_EVERY) === 0;
        state.glCalls = 0;
        state.glMs = 0;
        const outside = state.acc;
        state.acc = emptyAcc();
        const blocked = state.gapBlockedMs;
        state.gapBlockedMs = 0;
        if (state.lastFrameEnd != null && start - state.lastFrameEnd > GAP_MS) {
          const gap = start - state.lastFrameEnd;
          let known = 0;
          CATS.forEach(function (k) { known += outside[k]; });
          // 空闲(没有帧要画)也会有长间隔:只有主线程确实被占住(心跳迟到)或
          // 已知分项够大时才打,免得刷屏
          if (blocked >= LONG_TASK_MS || known >= 20) {
            try {
              log('[mp-perf] gap ' + gap.toFixed(0) + 'ms(帧外) blocked=' + blocked.toFixed(0) + ' ' + accText(outside) +
                ' other=' + Math.max(0, gap - known).toFixed(1) +
                (state.fontFetchPending ? ' fontFetchPending=' + state.fontFetchPending : ''));
            } catch (e) { /* 忽略 */ }
          }
        }
        state.cur = { ts: ts, dur: 0 };
      } else {
        // 同帧两个回调之间(帧外)的零星工作不算帧内
        state.acc = emptyAcc();
      }
      state.inFrame = true;
      try {
        return cb(ts);
      } finally {
        state.inFrame = false;
        const end = now();
        state.lastFrameEnd = end;
        const cur = state.cur;
        cur.dur += end - start;
        cur.inside = addAcc(cur.inside || emptyAcc(), state.acc);
        state.acc = emptyAcc();
        // 引擎常只注册一个回调:不等下一帧,若 ts 不可用(不能归并)立即结算
        if (!(typeof ts === 'number' && ts > 0)) finishFrame(state, log);
      }
    });
  };
  return function unwrap() { canvas.requestAnimationFrame = orig; };
}

function addAcc(a, b) {
  CATS.forEach(function (k) { a[k] += b[k]; });
  a.fakeBold += b.fakeBold;
  return a;
}

/** 结算当前帧(下一帧开始时、report() 时、或不能归并的回调结束时)。 */
function finishFrame(state, log) {
  const cur = state.cur;
  state.cur = null;
  if (!cur || cur.inside == null) return;
  const dur = cur.dur;
  const inside = cur.inside;
  state.frames.push(dur);
  state.inFrameDecodeMs += inside.decode + inside.native + inside.scale2d;
  if (dur > LONG_TASK_MS) {
    state.longTasks++;
    let known = 0;
    CATS.forEach(function (k) { known += inside[k]; });
    try {
      log('[mp-perf] long-frame ' + dur.toFixed(1) + 'ms ' + accText(inside) +
        (state.sampling && state.glCalls ? ' glAll=' + state.glMs.toFixed(1) + '/' + state.glCalls : '') +
        ' other=' + Math.max(0, dur - known).toFixed(1));
    } catch (e) { /* 忽略 */ }
  }
  if (state.sampling) state.glSamples.push({ calls: state.glCalls, ms: state.glMs });
}

/**
 * 创建稳态性能 HUD。[opts]:
 *   - canvas:承载页真实 canvas 节点(rAF 包装的唯一挂载点)
 *   - gl:CanvasKit 实际在用的 WebGL 上下文(`shim.glContext`);glAlt:
 *     acquireGlContext(canvas) 拿到的那个——两者不是同一对象时都包(各自的调用
 *     只经过其中一个,不会重复计数),并打一行诊断
 *   - CK:boot() 交出的 CanvasKit 对象
 *   - images:bom-shim 的图片模块(原生解码统计,setStatsSink)
 *   - fetchHosts:[window, self](字体 fetch 等待计时)
 *   - typefaceMemo:boot 装的字体解析去重(typeface-memo.js),每秒行里报复用次数
 *   - fontInfo:{ cjkBold: shim.cjkBold, fetch }——合成加粗计数用的"哪些家族有
 *     粗体"首帧前来源(见 wrapFakeBold)
 *   - setData(patch):驱动左上角浮层(`data.mpPerf`)
 *   - now/log/setIntervalFn/clearIntervalFn:仅供单测注入
 */
function createPerfHud(opts) {
  const canvas = opts.canvas;
  const CK = opts.CK;
  const setData = opts.setData;
  const now = opts.now || Date.now;
  const log = opts.log || console.log;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;

  const state = {
    visible: true,
    sampling: false,
    inFrame: false,
    frameSeq: 0,
    lastFrameEnd: null,
    cur: null,
    gapBlockedMs: 0,  // 上一帧结束以来心跳迟到累计(主线程被占住)
    blockedMs: 0,     // 本窗口心跳迟到累计
    blockedMax: 0,        // 当前 vsync 帧 { ts, dur, inside }
    glCalls: 0,
    glMs: 0,
    frames: [],      // 本窗口每帧耗时(ms)
    longTasks: 0,
    glSamples: [],   // 本窗口内采样帧的 { calls, ms }
    decodeCount: 0,
    decodeMs: 0,
    inFrameDecodeMs: 0,
    acc: emptyAcc(),
    win: emptyAcc(),  // 本窗口分项累计
    nativeCount: 0, nativeSyncMs: 0, nativeWaitMs: 0, nativeFallback: 0,
    scaleCount: 0,
    uploadCount: 0, shaderCount: 0, uploadImgCount: 0, uploadImgMs: 0,
    log: log,
    fontParseCount: 0, fontParseMs: 0,
    layoutCount: 0, layoutMs: 0,
    fontFetchCount: 0, fontFetchMs: 0, fontFetchPending: 0,
    fontChangeCount: 0, memoHitsSeen: 0,
    fakeBoldCount: 0, boldFamilies: {},
  };
  function add(cat, ms) {
    state.acc[cat] += ms;
    state.win[cat] += ms;
    if (cat === 'upload') state.uploadCount++;
    else if (cat === 'shader') state.shaderCount++;
  }

  const gls = [];
  if (opts.gl) gls.push(opts.gl);
  if (opts.glAlt && gls.indexOf(opts.glAlt) < 0) gls.push(opts.glAlt);
  const wraps = gls.map(function (g) { return wrapGl(g, state, now, add); });
  if (gls.length) {
    try {
      log('[mp-perf] gl 包装:' + wraps.map(function (w) { return w.wrapped + ' 个方法' + (w.failed ? '(' + w.failed + ' 个包不上)' : ''); }).join(' + ') +
        (opts.glAlt ? ';引擎上下文与 acquireGlContext ' + (opts.gl === opts.glAlt ? '是同一对象' : '不是同一对象') : ''));
    } catch (e) { /* 忽略 */ }
  }
  if (CK) wrapDecode(CK, state, now, log, add);
  if (CK) { try { wrapText(CK, state, now, log, add); } catch (e) { /* 文字计时失败不影响其余 */ } }
  if (CK) { try { wrapFakeBold(CK, state, opts.fontInfo); } catch (e) { /* 同上 */ } }
  wrapFontFetch(opts.fetchHosts, state, now, log);
  if (opts.images && typeof opts.images.setStatsSink === 'function') {
    opts.images.setStatsSink(function (e) {
      if (e.type === 'native-decode') {
        state.nativeCount++;
        state.nativeSyncMs += e.syncMs;
        state.nativeWaitMs += e.waitMs;
        add('native', e.syncMs);
      } else if (e.type === 'native-2d') {
        state.scaleCount++;
        add('scale2d', e.ms);
        if (e.ms > DECODE_DETAIL_MS) {
          try { log('[mp-perf] scale2d-slow ' + e.ms.toFixed(1) + 'ms ' + e.w + 'x' + e.h); } catch (x) { /* 忽略 */ }
        }
      } else if (e.type === 'native-fallback') {
        state.nativeFallback++;
      }
    });
  }
  const unwrapRaf = (canvas && typeof canvas.requestAnimationFrame === 'function')
    ? wrapCanvasRaf(canvas, state, now, log) : null;

  let timer = null;

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[idx];
  }

  /** 汇总本窗口,打一行 [mp-perf],刷新浮层,重置窗口计数。暴露给单测直接调用。 */
  function report() {
    finishFrame(state, log);
    const frames = state.frames;
    const fps = frames.length;
    let avg = 0, p95 = 0, max = 0;
    if (fps) {
      const sorted = frames.slice().sort(function (a, b) { return a - b; });
      avg = frames.reduce(function (a, b) { return a + b; }, 0) / fps;
      max = sorted[sorted.length - 1];
      p95 = percentile(sorted, 0.95);
    }
    let glCallsPerFrame = 0, glMsPerFrame = 0;
    if (state.glSamples.length) {
      glCallsPerFrame = state.glSamples.reduce(function (a, s) { return a + s.calls; }, 0) / state.glSamples.length;
      glMsPerFrame = state.glSamples.reduce(function (a, s) { return a + s.ms; }, 0) / state.glSamples.length;
    }
    const decodeCount = state.decodeCount;
    const decodeMs = state.decodeMs;
    const longTasks = state.longTasks;
    const win = state.win;
    // 粗略估算:rAF 回调帧均耗时减去 gl 均耗时、再减去**发生在 rAF 回调内**的
    // 解码(wasm/原生同步部分/2d 缩放)按帧均摊。帧外的解码(网络回调里)不减。
    const dartEst = fps ? avg - glMsPerFrame - state.inFrameDecodeMs / fps : 0;
    const r = {
      fps: fps, avg: avg, p95: p95, max: max, glCallsPerFrame: glCallsPerFrame,
      glMsPerFrame: glMsPerFrame, decodeCount: decodeCount, decodeMs: decodeMs,
      longTasks: longTasks, dartEst: dartEst,
      nativeCount: state.nativeCount, nativeSyncMs: state.nativeSyncMs, nativeWaitMs: state.nativeWaitMs,
      nativeFallback: state.nativeFallback, scaleCount: state.scaleCount, scaleMs: win.scale2d,
      uploadCount: state.uploadCount, uploadMs: win.upload,
      uploadImgCount: state.uploadImgCount, uploadImgMs: state.uploadImgMs, shaderCount: state.shaderCount, shaderMs: win.shader,
      fontFetchCount: state.fontFetchCount, fontFetchMs: state.fontFetchMs,
      fontParseCount: state.fontParseCount, fontParseMs: state.fontParseMs,
      layoutCount: state.layoutCount, layoutMs: state.layoutMs,
      blockedMs: state.blockedMs, blockedMax: state.blockedMax,
      fontChangeCount: state.fontChangeCount, fontReuse: 0,
      fakeBoldCount: state.fakeBoldCount,
    };
    const memo = opts.typefaceMemo;
    if (memo && memo.stats) {
      r.fontReuse = memo.stats.hits - state.memoHitsSeen;
      state.memoHitsSeen = memo.stats.hits;
    }

    try {
      log('[mp-perf] fps=' + fps +
        ' frame(avg/p95/max ms)=' + avg.toFixed(1) + '/' + p95.toFixed(1) + '/' + max.toFixed(1) +
        ' gl(calls/frame,ms/frame)=' + glCallsPerFrame.toFixed(0) + '/' + glMsPerFrame.toFixed(2) +
        ' decode(count,ms)=' + decodeCount + '/' + decodeMs.toFixed(2) +
        ' native(count,sync,wait ms)=' + r.nativeCount + '/' + r.nativeSyncMs.toFixed(1) + '/' + r.nativeWaitMs.toFixed(0) +
        (r.nativeFallback ? ' nativeFallback=' + r.nativeFallback : '') +
        ' scale2d=' + r.scaleCount + '/' + r.scaleMs.toFixed(1) +
        ' upload=' + r.uploadCount + '/' + r.uploadMs.toFixed(1) + '(img ' + r.uploadImgCount + '/' + r.uploadImgMs.toFixed(1) + ')' +
        ' shader=' + r.shaderCount + '/' + r.shaderMs.toFixed(1) +
        ' font(fetch,parse)=' + r.fontFetchCount + '/' + r.fontFetchMs.toFixed(0) + ',' + r.fontParseCount + '/' + r.fontParseMs.toFixed(1) +
        (r.fontReuse ? '(reuse ' + r.fontReuse + ')' : '') + ' fontChange=' + r.fontChangeCount +
        ' layout=' + r.layoutCount + '/' + r.layoutMs.toFixed(1) +
        (r.fakeBoldCount ? '(fakeBold ' + r.fakeBoldCount + ')' : '') +
        ' longTasks=' + longTasks +
        ' blocked(total,max ms)=' + r.blockedMs.toFixed(0) + '/' + r.blockedMax.toFixed(0) +
        ' dart~=' + dartEst.toFixed(1) + 'ms(est)');
    } catch (e) { /* console 不可用不影响统计继续 */ }

    if (state.visible) {
      try {
        setData({ mpPerf: { visible: true, fps: fps, avg: Math.round(avg * 10) / 10 } });
      } catch (e) { /* setData 失败不应打断下一轮统计 */ }
    }

    state.frames = [];
    state.longTasks = 0;
    state.glSamples = [];
    state.decodeCount = 0;
    state.decodeMs = 0;
    state.inFrameDecodeMs = 0;
    state.win = emptyAcc();
    state.nativeCount = 0; state.nativeSyncMs = 0; state.nativeWaitMs = 0; state.nativeFallback = 0;
    state.scaleCount = 0; state.uploadCount = 0; state.shaderCount = 0; state.uploadImgCount = 0; state.uploadImgMs = 0;
    state.fontParseCount = 0; state.fontParseMs = 0; state.layoutCount = 0; state.layoutMs = 0;
    state.fakeBoldCount = 0;
    state.fontFetchCount = 0; state.fontFetchMs = 0;
    state.blockedMs = 0; state.blockedMax = 0;

    return r;
  }

  // 主线程占用心跳:每 HEARTBEAT_MS 排一次定时器,迟到超过 LONG_TASK_MS 视为
  // 主线程被一个长任务占住(不管是不是在 rAF 里),计入 blocked
  let hb = null, hbDue = 0;
  function heartbeat() {
    const t = now();
    const late = t - hbDue;
    if (late > LONG_TASK_MS) {
      state.blockedMs += late;
      state.gapBlockedMs += late;
      if (late > state.blockedMax) state.blockedMax = late;
    }
    hbDue = t + HEARTBEAT_MS;
    hb = setTimeoutFn(heartbeat, HEARTBEAT_MS);
  }

  function start() {
    if (timer == null) timer = setIntervalFn(report, REPORT_INTERVAL_MS);
    if (hb == null && opts.heartbeat !== false) { hbDue = now() + HEARTBEAT_MS; hb = setTimeoutFn(heartbeat, HEARTBEAT_MS); }
  }

  function stop() {
    if (timer != null) { clearIntervalFn(timer); timer = null; }
    if (hb != null) { clearTimeoutFn(hb); hb = null; }
    if (unwrapRaf) unwrapRaf();
    if (opts.images && typeof opts.images.setStatsSink === 'function') opts.images.setStatsSink(null);
  }

  /** 浮层开关(pointer-events:none,不能靠点它本身切换;供开发者工具控制台调用,
   * 例如 `getCurrentPages()[0].mpPerf.setVisible(false)`)。 */
  function setVisible(v) {
    state.visible = !!v;
    // 用 dot-path 只改 visible 字段,不用整个 mpPerf 对象覆盖——否则会把
    // report() 刚写入的 fps/avg 冲掉。
    try { setData({ 'mpPerf.visible': state.visible }); } catch (e) { /* 忽略 */ }
  }

  return { start: start, stop: stop, report: report, setVisible: setVisible };
}

module.exports = { createBootTimer, createPerfHud, glMethodNames, sfntWeight };
