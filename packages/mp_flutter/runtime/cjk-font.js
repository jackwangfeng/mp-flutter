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
  const now = o.now || function () { return Date.now(); };
  const warn = o.warn || function (m) { try { console.warn(m); } catch (e) { /* 忽略 */ } };
  const loadTimeoutMs = o.loadTimeoutMs || CJK_FONT_LOAD_TIMEOUT_MS;
  const t0 = now();
  // M6:spec.load() 超时按读取失败处理——落到下面统一的 catch 分支,返回 null
  // 走 404 分支(中文回退按需下载分片),不让首屏一直等一个卡住的分包。
  return Promise.resolve().then(function () { return withTimeout(spec.load(), loadTimeoutMs); }).then(function () {
    const t1 = now();
    if (log) log('[mp-perf] cjk-font pkg ' + (t1 - t0) + 'ms');
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
      if (log) log('[mp-perf] cjk-font read ' + (now() - t1) + 'ms via readCompressedFile bytes=' + bytes.length);
      return bytes;
    });
  }).then(null, function (e) {
    warn('[mp-flutter] 常用汉字合一字体读取失败,中文改用按需下载的回退字体:' + ((e && e.message) || e));
    return null;
  });
}

module.exports = { preloadCjkFont };
