'use strict';
/**
 * 常用汉字合一字体的预读(`cjk_font`,见 lib/src/cjk_font.dart)。
 *
 * 字体不走资源分包的 base64 模块:真机上引擎取字体(initializeEngine →
 * loadAssetFonts)时才 require.async 两个 1–1.4MB 的 base64 模块再
 * `wx.base64ToArrayBuffer` 解码,iOS 实测 2.1MB 字体等了 1536ms、安卓 815ms,
 * 而且串在 dart-main 之后。现在:
 *   · 构建期把字体 brotli 压缩后放进独立分包 `pkg-cjk`(代码包文件);
 *   · boot 一开始就 require.async 该分包的就位探针,就位后
 *     `FileSystemManager.readCompressedFile`(代码包文件 + 原生 brotli 解压)
 *     读出字节——与 wasm 编译、Dart 分片加载并行;
 *   · 引擎请求这个资源时直接用预读的字节应答(net.js 的 preloaded);
 *   · CanvasKit 一就绪、字节一到就先解析一次(typeface-memo 缓存),引擎随后的
 *     MakeFreeTypeFaceFromData / registerFont 命中缓存。
 *
 * 为什么不是 readFile:开发者工具与真机上 readFile 读代码包里的字体文件报
 * `permission denied`(见 docs/architecture.md);readCompressedFile 的
 * filePath 官方文档明确支持"代码包文件"。读取失败(基础库太旧、权限变化)时
 * 解出 null:引擎拿到 404,打一行警告后照常启动,中文退回按需下载回退分片,
 * 不影响正确性。
 */

function toLocalBytes(buf) {
  // readCompressedFile 交出的 ArrayBuffer 属于另一个 realm(原型冻结),
  // dart2js 往它原型上写 dispatch 标记会抛错——拷进本 realm
  const src = new Uint8Array(buf);
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}

/** M6:spec.load()(分包就位探针)默认超时——避免分包一直下载不下来时首屏永远卡着等它。 */
const CJK_FONT_LOAD_TIMEOUT_MS = 10000;

/** [ms] 内 [promise] 没定下来就 reject(不影响 [promise] 本身继续跑,只是不再等它)。 */
function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      reject(new Error('分包就位超时 ' + ms + 'ms'));
    }, ms);
    Promise.resolve(promise).then(function (v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    }, function (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * [spec] 是加载表的 `cjkFont`:{ key, file, load() }。
 * 返回 Promise<Uint8Array | null>,永不 reject。
 */
function preloadCjkFont(spec, opts) {
  const o = opts || {};
  const wx = o.wx;
  const log = o.perfLog || null;
  const label = o.label || 'cjk-font';
  const now = o.now || function () { return Date.now(); };
  const warn = o.warn || function (m) { try { console.warn(m); } catch (e) { /* 忽略 */ } };
  const loadTimeoutMs = o.loadTimeoutMs || CJK_FONT_LOAD_TIMEOUT_MS;
  // [opts.startAfter](Promise,可缺省):等它定下来(resolve 或 reject 都算)才
  // 开始请求分包——粗体用它推迟到首帧之后,不和首帧前必需的分包抢带宽。
  const gate = o.startAfter ? Promise.resolve(o.startAfter).then(null, function () {}) : Promise.resolve();
  let t0 = 0;
  // M6:spec.load() 超时按读取失败处理——落到下面统一的 catch 分支,返回 null
  // 走 404 分支(中文回退按需下载分片),不让首屏一直等一个卡住的分包。
  return gate.then(function () {
    t0 = now();
    if (typeof o.onIssue === 'function') { try { o.onIssue(); } catch (e) { /* 计时失败不影响读取 */ } }
    return withTimeout(spec.load(), loadTimeoutMs);
  }).then(function () {
    if (typeof o.onReady === 'function') { try { o.onReady(); } catch (e) { /* 同上 */ } }
    const t1 = now();
    if (log) log('[mp-perf] ' + label + ' pkg ' + (t1 - t0) + 'ms');
    const fs = wx && wx.getFileSystemManager && wx.getFileSystemManager();
    if (!fs || typeof fs.readCompressedFile !== 'function') {
      throw new Error('FileSystemManager.readCompressedFile 不可用(基础库过低)');
    }
    return new Promise(function (resolve, reject) {
      fs.readCompressedFile({
        filePath: spec.file,
        compressionAlgorithm: 'br',
        success: function (r) { resolve(r && r.data); },
        fail: function (e) { reject(new Error((e && e.errMsg) || String(e))); },
      });
    }).then(function (data) {
      const bytes = toLocalBytes(data);
      if (log) log('[mp-perf] ' + label + ' read ' + (now() - t1) + 'ms via readCompressedFile bytes=' + bytes.length);
      return bytes;
    });
  }).then(null, function (e) {
    warn((o.failMessage || '[mp-flutter] 常用汉字合一字体读取失败,中文改用按需下载的回退字体:') + ((e && e.message) || e));
    return null;
  });
}

/**
 * 合一字体的粗体(`cjk_font_bold`,见 lib/src/cjk_font.dart kCjkFontBoldSources)。
 *
 * 与常规合一字体同一 family、同一字表,FontManifest 里同一家族的第二个字体;
 * 引擎按字重匹配,w≥600 的文字落到真粗体上,不再合成加粗。
 *
 * 首帧不等它:
 *   · 默认(`cjk_font_bold_timing: after_first_frame`)boot 传 [opts.startAfter]
 *     = 首帧提交,首帧之后才请求分包:首帧前真正必需的 wasm/dart/常规字体
 *     独享带宽(粗体约 1.2MB,原先与它们同时下载,占首帧前字节的 17–24%);
 *     `eager` 时不传,调用本函数即开始读(boot 在 dart/wasm 分包请求之后调用);
 *   · 补注册经 [opts.whenIdle] 安排到空闲时(boot 实现:没有手指按着、最近
 *     300ms 没有帧提交),不在滚动/动画中途整页重排;
 *   · 引擎取字体([respond])时,粗体只要不晚于常规字体到就一起交出去——常规
 *     字体本来就在等,零额外等待,首帧前注册不发 fontsChange;
 *   · 比常规字体晚:先按 404 应答(引擎打一行 "not found (404)" 警告,照常
 *     首帧,这期间粗体文字仍是合成加粗),字节到了经 [bridge](挂在
 *     `self.__mpLateFonts`)交给入口包装,首帧之后 `ui.loadFontFromList` 补注册,
 *     引擎发一次 fontsChange、框架把段落重排一遍(字形缓存是热的,只多一次
 *     shaping;粗体字形首次光栅化与首帧时的合成加粗相比便宜得多);
 *   · 常规字体读取失败(null)时粗体也不注册:家族里只剩粗体,常规文字也会
 *     落到它上面。
 * 没有入口包装(`--no-safe-area`)时没人 listen,晚到的粗体就不用了(粗体文字
 * 继续合成加粗,正确性不受影响)。
 *
 * [spec] 是加载表的 `cjkFontBold`:{ key, family, file, load() };
 * [regular] 是常规合一字体的 preloadCjkFont 结果。
 */
function createCjkBold(spec, regular, opts) {
  const o = opts || {};
  const log = o.perfLog || null;
  const now = o.now || function () { return Date.now(); };
  const state = { status: 'loading' };
  const bytes = preloadCjkFont(spec, {
    wx: o.wx, perfLog: log, now: o.now, warn: o.warn, loadTimeoutMs: o.loadTimeoutMs, label: 'cjk-bold',
    startAfter: o.startAfter, onIssue: o.onIssue, onReady: o.onReady,
    failMessage: '[mp-flutter] 合一字体粗体读取失败,粗体中文改由 CanvasKit 合成加粗:',
  });
  let listener = null;
  let pending = null;
  let lateAt = 0;

  // [opts.whenIdle](fn)(可缺省):补注册要发一次 fontsChange、整页重排一遍,
  // 由 boot 安排到空闲时(没有手指按着、最近一段时间没有帧在画)再做,避开滚动。
  const whenIdle = typeof o.whenIdle === 'function' ? o.whenIdle : function (fn) { fn(); };
  let scheduled = false;
  function deliver() {
    if (!listener || !pending || scheduled) return;
    scheduled = true;
    whenIdle(function () { scheduled = false; deliverNow(); });
  }
  function deliverNow() {
    if (!listener || !pending) return;
    const b = pending;
    pending = null;
    state.status = 'late-loaded';
    if (log) log('[mp-perf] cjk-bold 补注册(首帧后 loadFontFromList,引擎发一次 fontsChange),404 后 ' + (now() - lateAt) + 'ms');
    try { listener(b, spec.family); } catch (e) {
      try { console.warn('[mp-flutter] 合一字体粗体补注册失败:' + ((e && e.message) || e)); } catch (e2) { /* 忽略 */ }
    }
  }

  const LATE = {};
  function respond() {
    const t = now();
    return Promise.race([bytes, regular.then(function () { return LATE; })]).then(function (r) {
      return regular.then(function (reg) {
        if (!reg) { state.status = 'skipped'; return null; }
        if (r === LATE) {
          state.status = 'late';
          lateAt = now();
          if (log) log('[mp-perf] cjk-bold 未就绪,首帧不等(404),到了再补注册');
          bytes.then(function (b) {
            if (!b) { state.status = 'failed'; return; }
            pending = b;
            deliver();
          });
          return null;
        }
        if (!r) { state.status = 'failed'; return null; }
        state.status = 'served';
        if (log) log('[mp-perf] cjk-bold 随常规字体注册,引擎取用等待 ' + (now() - t) + 'ms');
        return r;
      });
    });
  }

  const bridge = {
    /** 入口包装在首帧之后调用:[fn](bytes: Uint8Array, family: string)。 */
    listen: function (fn) {
      listener = typeof fn === 'function' ? fn : null;
      deliver();
    },
  };

  return { bytes: bytes, respond: respond, bridge: bridge, state: state };
}

module.exports = { preloadCjkFont, createCjkBold };
