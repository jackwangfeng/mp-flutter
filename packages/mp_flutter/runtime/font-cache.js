'use strict';
/**
 * 远端回退字体(`font_base_url`,默认关):回退字体分片不打进包,引擎请求
 * `mp-fonts/<相对路径>` 时从 CDN 拉取,并缓存到本地用户文件
 * (`wx.env.USER_DATA_PATH/mp-fonts-cache/`),下次启动直接读文件。
 *
 *  · 按文件名缓存:相对路径里的 `/` 换成 `__`,Google Fonts 的分片文件名
 *    本身带内容哈希,同名即同内容,不需要过期校验;
 *  · 容量上限 [maxBytes](默认 10MB,整套 notosanssc 约 2.4MB),超出按最近
 *    使用时间(LRU)淘汰;微信本地用户文件总上限 200MB,不能无限增长;
 *  · 索引 `index.json` 记录每个文件的大小与最近使用时间;索引与实际文件
 *    不一致(被用户清理、写一半)时以文件为准:读失败就当未命中重新下载;
 *  · 文件系统不可用或写失败只影响缓存,不影响本次字体加载(照样返回字节);
 *  · 下载内容必须是 woff2(魔数 wOF2),否则拒绝且不缓存——代理/登录页返回
 *    200 的 HTML 会被永久命中,引擎解析失败还查不出原因;
 *  · 同一文件并发请求只下载一次。
 *
 * 请求域名必须加进小程序后台「request 合法域名」,否则真机下载失败
 * (开发者工具 urlCheck:false 会掩盖这个问题)。
 */

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const INDEX_FILE = 'index.json';
/**
 * M10:index.json 只记录大小/最近使用时间,命中缓存(几乎每次取字体分片都会
 * 命中)时没必要每次都同步写一遍文件——节流到最多这么久写一次;`flush()`
 * 供调用方(比如承载页 onHide)在页面隐藏前把还没写盘的那次补上。
 */
const SAVE_THROTTLE_MS = 2000;

function isWoff2(b) {
  return b && b.length >= 4 && b[0] === 0x77 && b[1] === 0x4F && b[2] === 0x46 && b[3] === 0x32;
}

/** 缓存文件名:只保留 [A-Za-z0-9._-],`/` 换成 `__`,其余字符换成 `_`。 */
function cacheFileName(rel) {
  return String(rel).split('/').join('__').replace(/[^A-Za-z0-9._-]/g, '_');
}

function toBytes(buf) {
  const src = new Uint8Array(buf);
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}

/**
 * [opts.download](url) → Promise<{ status, bytes }>:由 net.js 提供(走同一个
 * wx.request 并发队列)。[opts.baseUrl] 以 `/` 结尾。
 */
function createFontCache(opts) {
  const wx = opts.wx;
  const baseUrl = opts.baseUrl;
  const maxBytes = opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const now = opts.now || function () { return Date.now(); };
  let fs = null;
  let dir = null;
  try {
    if (wx.getFileSystemManager && wx.env && wx.env.USER_DATA_PATH) {
      fs = wx.getFileSystemManager();
      dir = wx.env.USER_DATA_PATH + '/' + (opts.dirName || 'mp-fonts-cache');
    }
  } catch (e) { fs = null; }

  let index = null;          // { 文件名: { size, t } }
  const inflight = {};
  const setTimeoutFn = opts.setTimeout || setTimeout;
  const clearTimeoutFn = opts.clearTimeout || clearTimeout;
  const saveThrottleMs = opts.saveThrottleMs != null ? opts.saveThrottleMs : SAVE_THROTTLE_MS;
  let dirty = false;
  let saveTimer = null;

  function warn(msg) { try { console.warn('[mp-flutter] 字体缓存: ' + msg); } catch (e) { /* ignore */ } }

  function ensureDir() {
    try { fs.accessSync(dir); } catch (e) {
      try { fs.mkdirSync(dir, true); } catch (e2) { /* 并发创建:已存在 */ }
    }
  }

  function loadIndex() {
    if (index) return index;
    index = {};
    if (!fs) return index;
    try {
      ensureDir();
      const raw = fs.readFileSync(dir + '/' + INDEX_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') index = parsed;
    } catch (e) { /* 首次运行/索引损坏:从空索引开始 */ }
    return index;
  }

  /** 立即落盘(新文件写入 / 淘汰这些不常发生的变更走这条,跟以前一样同步)。 */
  function saveIndex() {
    if (!fs) return;
    dirty = false;
    if (saveTimer) { clearTimeoutFn(saveTimer); saveTimer = null; }
    try { fs.writeFileSync(dir + '/' + INDEX_FILE, JSON.stringify(index), 'utf8'); }
    catch (e) { warn('索引写入失败: ' + ((e && (e.errMsg || e.message)) || e)); }
  }

  /**
   * M10:缓存命中只是刷新一下 `t`(最近使用时间),用来给 LRU 淘汰排序——
   * 命中几乎每次取字体分片都会发生,没必要每次都同步写一遍文件,节流到最多
   * 每 [saveThrottleMs](默认 2s)写一次。
   */
  function scheduleSave() {
    if (!fs) return;
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeoutFn(function () {
      saveTimer = null;
      if (dirty) saveIndex();
    }, saveThrottleMs);
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  /** 立即把还没落盘的索引变更写掉(供承载页 onHide 等场景调用)。 */
  function flush() {
    if (dirty) saveIndex();
  }

  function remove(name) {
    delete index[name];
    try { fs.unlinkSync(dir + '/' + name); } catch (e) { /* 已不存在 */ }
  }

  /** 超过容量上限时按最近使用时间淘汰,[keep] 是刚写入的文件,不淘汰。 */
  function evict(keep) {
    let total = 0;
    Object.keys(index).forEach(function (k) { total += index[k].size || 0; });
    if (total <= maxBytes) return;
    const order = Object.keys(index).filter(function (k) { return k !== keep; })
      .sort(function (a, b) { return (index[a].t || 0) - (index[b].t || 0); });
    for (let i = 0; i < order.length && total > maxBytes; i++) {
      total -= index[order[i]].size || 0;
      remove(order[i]);
    }
  }

  function readCached(name) {
    if (!fs || !loadIndex()[name]) return null;
    try {
      const bytes = toBytes(fs.readFileSync(dir + '/' + name));
      if (!isWoff2(bytes)) { remove(name); saveIndex(); return null; }
      index[name].t = now();
      scheduleSave();
      return bytes;
    } catch (e) {
      remove(name);   // 索引有、文件没了(被清理):当未命中
      return null;
    }
  }

  function writeCached(name, bytes) {
    if (!fs) return;
    try {
      ensureDir();
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      fs.writeFileSync(dir + '/' + name, copy);
      loadIndex()[name] = { size: bytes.length, t: now() };
      evict(name);
      saveIndex();
    } catch (e) {
      warn('写入失败(不影响本次显示): ' + ((e && (e.errMsg || e.message)) || e));
    }
  }

  function load(rel) {
    const name = cacheFileName(rel);
    const hit = readCached(name);
    if (hit) return Promise.resolve(hit);
    if (inflight[name]) return inflight[name];
    const url = baseUrl + rel;
    const p = Promise.resolve().then(function () { return opts.download(url); }).then(function (r) {
      if (!r || r.status !== 200) {
        throw new Error('远端字体 ' + url + ' 下载失败: HTTP ' + (r && r.status));
      }
      if (!isWoff2(r.bytes)) {
        throw new Error('远端字体 ' + url + ' 返回的不是 woff2(可能是代理/登录页),未缓存');
      }
      writeCached(name, r.bytes);
      return r.bytes;
    });
    inflight[name] = p;
    const clear = function () { delete inflight[name]; };
    p.then(clear, clear);
    return p;
  }

  return { load, flush, _debugIndex: function () { return loadIndex(); } };
}

module.exports = { createFontCache, cacheFileName, isWoff2, DEFAULT_MAX_BYTES };
