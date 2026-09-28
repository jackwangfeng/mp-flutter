'use strict';
/**
 * 网络层:Flutter Web 产物里没有 dart:io,package:http 走 fetch,dio 与框架的
 * NetworkImage 走 XMLHttpRequest。这里提供两者共用的请求路由:
 *   打包资源 → 资源模块;绝对 http(s) URL → wx.request;其余 → 404。
 * 小程序不自动携带/保存 Cookie;请求域名须在小程序后台配置为合法域名
 * (开发者工具里 project.config.json 的 urlCheck:false 可绕过,真机不行)。
 */

function utf8Encode(str) {
  const s = String(str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

// utf8Decode:从 boot.js 原样迁来(真机没有 TextDecoder)
function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xE0) === 0xC0) {
      const b1 = bytes[i++];
      out += String.fromCharCode(((b0 & 0x1F) << 6) | (b1 & 0x3F));
    } else if ((b0 & 0xF0) === 0xE0) {
      const b1 = bytes[i++], b2 = bytes[i++];
      out += String.fromCharCode(((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F));
    } else if ((b0 & 0xF8) === 0xF0) {
      const b1 = bytes[i++], b2 = bytes[i++], b3 = bytes[i++];
      let cp = ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F);
      cp -= 0x10000;
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    } else {
      out += String.fromCharCode(b0);
    }
  }
  return out;
}

/** 外来 realm 的 ArrayBuffer(wx API 返回)拷贝成本 realm 的 Uint8Array。 */
function toLocalBytes(buf) {
  if (buf == null) return new Uint8Array(0);
  if (typeof buf === 'string') return utf8Encode(buf);
  const src = new Uint8Array(buf);
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}

class Headers {
  constructor(init) {
    this._m = new Map();
    if (init == null) return;
    if (typeof init.forEach === 'function' && !Array.isArray(init)) init.forEach((v, k) => this.append(k, v));
    else if (Array.isArray(init)) init.forEach(([k, v]) => this.append(k, v));
    else Object.keys(init).forEach((k) => this.append(k, init[k]));
  }
  append(k, v) { const n = String(k).toLowerCase(); const old = this._m.get(n); this._m.set(n, old == null ? String(v) : old + ', ' + v); }
  set(k, v) { this._m.set(String(k).toLowerCase(), String(v)); }
  get(k) { const v = this._m.get(String(k).toLowerCase()); return v == null ? null : v; }
  has(k) { return this._m.has(String(k).toLowerCase()); }
  delete(k) { this._m.delete(String(k).toLowerCase()); }
  forEach(cb, thisArg) { this._m.forEach((v, k) => cb.call(thisArg, v, k, this)); }
  entries() { return this._m.entries(); }
  keys() { return this._m.keys(); }
  values() { return this._m.values(); }
  [Symbol.iterator]() { return this._m.entries(); }
}

class AbortSignal {
  constructor() { this.aborted = false; this.reason = undefined; this.onabort = null; this._l = []; }
  addEventListener(t, fn) { if (t === 'abort' && typeof fn === 'function') this._l.push(fn); }
  removeEventListener(t, fn) { const i = this._l.indexOf(fn); if (i >= 0) this._l.splice(i, 1); }
  throwIfAborted() { if (this.aborted) throw this.reason; }
  _fire() {
    const ev = { type: 'abort', target: this };
    if (typeof this.onabort === 'function') { try { this.onabort(ev); } catch (e) { /* 监听器异常不影响中止 */ } }
    this._l.slice().forEach((fn) => { try { fn(ev); } catch (e) { /* 同上 */ } });
  }
}

function abortError(reason) {
  const e = new Error(reason && reason.message ? reason.message : '请求已取消');
  e.name = 'AbortError';
  e.mpKind = 'abort';
  return e;
}

class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort(reason) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason === undefined ? abortError() : reason;
    this.signal._fire();
  }
}

const STATUS_TEXT = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found',
  304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  409: 'Conflict', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout' };

function lowerHeaders(h) {
  const out = {};
  Object.keys(h || {}).forEach((k) => { out[k.toLowerCase()] = Array.isArray(h[k]) ? h[k].join(', ') : String(h[k]); });
  return out;
}

function normalizeBody(body) {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return body.slice(0);
  if (ArrayBuffer.isView(body)) {
    const copy = new Uint8Array(body.byteLength);
    copy.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return copy.buffer;
  }
  throw new TypeError('mp-flutter: 暂不支持 FormData/Blob 请求体(请改用字节或字符串)');
}

// 微信文档:wx.request / wx.uploadFile / wx.downloadFile 同时进行的任务数不能
// 超过 10 个。超出直接调用会被基础库拒绝(fail: 'request:fail exceed max
// request number'),所以并发请求要在这一层排队,而不是指望上层(package:http/
// dio)自己限流。
const MAX_CONCURRENT_REQUESTS = 10;

// 垫片自身的 location.origin(见 bom-shim.js 的 `loc`)。引擎/dio 有时会把
// 相对路径与这个 origin 拼成绝对 URL 再发请求(例如取字体时用
// fontFallbackBaseUrl + 相对路径);这类 URL 本质上还是"本包内资源",要按相对
// 路径去做后缀匹配。只有严格等于其它 origin 的绝对 URL 才是"真的外部请求"。
const SHIM_ORIGIN = 'https://mp.local';

/**
 * 若 url 是垫片自身 origin 下的绝对 URL,返回去掉 origin 的相对路径(可能是
 * '/xxx' 或 '/'),否则返回 null。
 */
function stripShimOrigin(url) {
  const low = url.toLowerCase();
  const o = SHIM_ORIGIN.toLowerCase();
  if (low === o) return '/';
  if (low.indexOf(o + '/') === 0) return url.slice(SHIM_ORIGIN.length);
  return null;
}

function notFound(url) {
  return Promise.resolve({ status: 404, statusText: 'Not Found', headers: {}, bytes: new Uint8Array(0), url });
}

/**
 * 回退字体到达的合并窗口(ms)。
 *
 * 引擎(3.41.9 font_fallbacks.dart `_FallbackFontDownloadQueue`)在一批回退
 * 字体全部下载完、队列空了才注册并发一次 fontsChange;下载期间新发现的缺字
 * 并进同一批。框架收到 fontsChange 会把所有段落重排一遍,所以批次越少越好。
 * 这里让同一阵的回退字体响应至少等到"最后一次请求之后 [FONT_SETTLE_MS]"
 * 且这一阵全部落地才一起交给引擎:窗口内陆续冒出的缺字(翻页、数据到达)
 * 跟上一批合成一次注册、一次重排。最多压 [FONT_SETTLE_MAX_MS],不会被源源
 * 不断的请求一直拖着。只作用于首帧后的回退分片(`mp-fonts/`,Roboto 除外——
 * 它在首帧前的启动路径上)。
 */
const FONT_SETTLE_MS = 100;
const FONT_SETTLE_MAX_MS = 1000;

function isFallbackFontKey(key) {
  return /^mp-fonts\//.test(key) && !/^mp-fonts\/roboto\//.test(key);
}

function createFontGate(opts) {
  const settleMs = opts.settleMs;
  const maxMs = opts.maxMs;
  const now = opts.now || (function () { return Date.now(); });
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  let held = [];
  let inflight = 0;
  let lastReq = 0;
  let burstStart = 0;
  let timer = null;

  function flush() {
    const h = held;
    held = [];
    burstStart = now();
    h.forEach(function (f) { f(); });
  }

  function check() {
    if (timer) { clearT(timer); timer = null; }
    if (!held.length) return;
    const t = now();
    const release = Math.min(inflight === 0 ? lastReq + settleMs : Infinity, burstStart + maxMs);
    if (release <= t) flush();
    else timer = setT(check, release - t);
  }

  function track(p) {
    const t = now();
    if (inflight === 0 && held.length === 0) burstStart = t;
    lastReq = t;
    inflight++;
    return new Promise(function (resolve, reject) {
      p.then(function (v) { inflight--; held.push(function () { resolve(v); }); check(); },
        function (e) { inflight--; held.push(function () { reject(e); }); check(); });
    });
  }

  return { track };
}

/**
 * [opts.remoteFonts](`font_base_url`,可选):加载表里的
 * `{ baseUrl, files: { 'mp-fonts/<相对路径>': 1 } }`。命中 files 的请求不在包内,
 * 从 baseUrl 下载并缓存到本地文件(见 font-cache.js);下载走下面同一个
 * wx.request 并发队列。[opts.fontCache] 仅供单测注入。
 */
function createNet(opts) {
  const wx = opts.wx;
  let activeCount = 0;
  const queue = [];
  const remote = opts.remoteFonts && opts.remoteFonts.baseUrl && opts.remoteFonts.files
    ? opts.remoteFonts : null;
  let fontCache = opts.fontCache || null;
  const settleMs = opts.fontSettleMs != null ? opts.fontSettleMs : FONT_SETTLE_MS;
  const fontGate = settleMs > 0
    ? createFontGate({ settleMs, maxMs: opts.fontSettleMaxMs || FONT_SETTLE_MAX_MS,
      now: opts.now, setTimeout: opts.setTimeout, clearTimeout: opts.clearTimeout })
    : null;
  function gated(key, p) { return fontGate && isFallbackFontKey(key) ? fontGate.track(p) : p; }
  function getFontCache() {
    if (!fontCache) {
      const { createFontCache } = require('./font-cache.js');
      fontCache = createFontCache({ wx, baseUrl: remote.baseUrl,
        download: (url) => wxRequest({ method: 'GET', url, headers: {} }) });
    }
    return fontCache;
  }

  // 排到队首且有空槽时才真正调用 wx.request。
  function pump() {
    while (activeCount < MAX_CONCURRENT_REQUESTS && queue.length > 0) {
      const item = queue.shift();
      if (item.onQueueAbort) { item.signal.removeEventListener('abort', item.onQueueAbort); item.onQueueAbort = null; }
      activeCount++;
      doRequest(item.req).then(
        (v) => { activeCount--; item.resolve(v); pump(); },
        (e) => { activeCount--; item.reject(e); pump(); });
    }
  }

  function doRequest(req) {
    return new Promise((resolve, reject) => {
      const method = String(req.method || 'GET').toUpperCase();
      const signal = req.signal;
      if (signal && signal.aborted) { reject(abortError(signal.reason)); return; }
      let data;
      try { data = normalizeBody(req.body); } catch (e) { reject(e); return; }
      let settled = false;
      let onAbort;
      // 请求一旦落地(成功或失败)就必须摘掉 abort 监听器 —— 同一个 signal
      // 常被复用发多个请求(例如同一个 CancelToken 挂在一串请求上),
      // 不摘除会导致监听器列表随请求数量无限增长。
      function cleanup() { if (signal && onAbort) signal.removeEventListener('abort', onAbort); }
      const task = wx.request({
        url: req.url, method, header: req.headers || {},
        data: (method === 'GET' || method === 'HEAD') ? undefined : data,
        responseType: 'arraybuffer', dataType: 'arraybuffer',
        timeout: req.timeout > 0 ? req.timeout : undefined,
        success(res) {
          if (settled) return; settled = true; cleanup();
          resolve({ status: res.statusCode, statusText: STATUS_TEXT[res.statusCode] || '',
            headers: lowerHeaders(res.header), bytes: toLocalBytes(res.data), url: req.url });
        },
        fail(err) {
          if (settled) return; settled = true; cleanup();
          const msg = (err && err.errMsg) || String(err);
          if (/abort/i.test(msg) || (signal && signal.aborted)) { reject(abortError(signal && signal.reason)); return; }
          const e = new TypeError('网络请求失败: ' + method + ' ' + req.url + ': ' + msg);
          e.mpKind = /timeout/i.test(msg) ? 'timeout' : 'network';
          reject(e);
        },
      });
      if (signal) {
        // 中止不等 wx 回调:wx.request 的 task.abort() 是否/何时触发 fail 属实现
        // 细节(实测偶发不触发),真等它回调会让 fetch/XHR 的 abort 悬空。这里
        // 立即以 AbortError 落地;迟到的 success/fail 由 settled 屏蔽。
        onAbort = () => {
          if (settled) return;
          settled = true; cleanup();
          if (task && task.abort) task.abort();
          reject(abortError(signal.reason));
        };
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  // 对外的 wx.request 入口:排队,槽位不够就等;排队期间被 abort 直接出队
  // 拒绝,既不占槽也不调用 wx.request。
  function wxRequest(req) {
    return new Promise((resolve, reject) => {
      const signal = req.signal;
      if (signal && signal.aborted) { reject(abortError(signal.reason)); return; }
      const item = { req, resolve, reject, signal, onQueueAbort: null };
      if (signal) {
        item.onQueueAbort = () => {
          const idx = queue.indexOf(item);
          if (idx < 0) return; // 已出队进入 doRequest,交由那边的 abort 监听处理
          queue.splice(idx, 1);
          signal.removeEventListener('abort', item.onQueueAbort);
          reject(abortError(signal.reason));
        };
        signal.addEventListener('abort', item.onQueueAbort);
      }
      queue.push(item);
      pump();
    });
  }

  function loadAsset(key, url) {
    // 资源模块在分包里,只能异步加载;加载失败直接 reject 并带上资源路径——
    // 静默回 404 会让引擎当成"资源不存在",最后表现为缺字或黑屏,极难倒查。
    return opts.assets[key]().then(
      (parts) => ({ status: 200, statusText: 'OK',
        headers: { 'content-type': 'application/octet-stream' }, bytes: opts.decodeParts([].concat(parts)), url }),
      (e) => { throw new Error('资源 ' + key + ' 加载失败: ' + ((e && (e.message || e.errMsg)) || e)); });
  }

  function loadRemoteFont(key, url) {
    // key 形如 mp-fonts/notosanssc/v37/xxx.4.woff2,远端路径去掉 mp-fonts/ 前缀
    const rel = key.replace(/^mp-fonts\//, '');
    return getFontCache().load(rel).then(
      (bytes) => ({ status: 200, statusText: 'OK',
        headers: { 'content-type': 'font/woff2' }, bytes, url }),
      (e) => { throw new Error('远端字体 ' + key + ' 加载失败: ' + ((e && (e.message || e.errMsg)) || e)); });
  }

  // [opts.preloaded]:{ 资源 key: () => Promise<Uint8Array|null> },启动时已预读的
  // 资源(常用汉字合一字体,见 cjk-font.js)。null 表示读取失败,按 404 应答。
  // 应答的 arrayBuffer() 直接交出底层 buffer(shareBuffer):引擎对同一个
  // ArrayBuffer 解析才能命中 typeface-memo 里预解析的结果。
  function loadPreloaded(key, url) {
    return opts.preloaded[key]().then((bytes) => bytes
      ? { status: 200, statusText: 'OK', headers: { 'content-type': 'font/ttf' }, bytes, url, shareBuffer: true }
      : { status: 404, statusText: 'Not Found', headers: {}, bytes: new Uint8Array(0), url });
  }

  // 预读资源优先;再包内资源;再远端字体表;都没有才 404
  function local(path, url) {
    if (opts.preloaded) {
      const pkey = opts.matchAsset(opts.preloaded, path);
      if (pkey) return loadPreloaded(pkey, url);
    }
    const key = opts.matchAsset(opts.assets || {}, path);
    if (key) return gated(key, loadAsset(key, url));
    if (remote) {
      const rkey = opts.matchAsset(remote.files, path);
      if (rkey) return gated(rkey, loadRemoteFont(rkey, url));
    }
    return notFound(url);
  }

  function route(req) {
    const url = String(req.url);
    const abs = /^https?:\/\//i.test(url);
    if (abs) {
      // 垫片自身 origin 下的绝对 URL 等价于相对路径,按后缀匹配资源;未命中
      // 直接 404,不交给 wx.request(真机会报"不在合法域名列表"这类误导性错误)。
      const rel = stripShimOrigin(url);
      if (rel != null) return local(rel, url);
      // 真正的外部绝对 URL:哪怕后缀与某个打包资源同名,也必须真的发网络
      // 请求 —— 否则远端内容更新永远反映不到小程序里,且没有任何诊断信息。
      return wxRequest(req);
    }
    return local(url, url);
  }

  return { route };
}

function makeFetchResponse(r) {
  const bytes = r.bytes;
  const headers = new Headers(r.headers);
  let sent = false;
  const resp = {
    ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText || '',
    url: r.url, redirected: false, type: 'basic', bodyUsed: false, headers,
    body: {
      locked: false,
      cancel() { return Promise.resolve(); },
      getReader() {
        return {
          closed: Promise.resolve(),
          cancel() { return Promise.resolve(); },
          releaseLock() {},
          read() {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value: bytes });
          },
        };
      },
    },
    arrayBuffer() {
      if (r.shareBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
        return Promise.resolve(bytes.buffer);
      }
      return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    },
    text() { return Promise.resolve(utf8Decode(bytes)); },
    json() { return Promise.resolve(JSON.parse(utf8Decode(bytes))); },
    clone() { return makeFetchResponse(r); },
  };
  return resp;
}

// 出站请求头:有意**不**经 Headers 类做小写归一 —— wx.request 的 header 字段
// 原样透传给后端,大小写对某些服务端有意义(实测:约定测试要求 seen.header
// 保留调用方原始大小写,如 'Content-Type')。Headers 类的小写统一只用于
// fetch Response 一侧(读取响应头,大小写不敏感是 fetch 规范要求)。
function plainHeaders(h) {
  const out = {};
  if (h == null) return out;
  if (Array.isArray(h)) { h.forEach(([k, v]) => { out[k] = v; }); return out; }
  if (typeof h.forEach === 'function') { h.forEach((v, k) => { out[k] = v; }); return out; }
  Object.keys(h).forEach((k) => { out[k] = h[k]; });
  return out;
}

function makeFetch(net) {
  return function fetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const i = init || {};
    const headers = plainHeaders(i.headers);
    return net.route({ method: i.method || 'GET', url, headers, body: i.body, signal: i.signal })
      .then(makeFetchResponse);
  };
}

module.exports = { createNet, makeFetch, makeFetchResponse, Headers, AbortController, AbortSignal,
  utf8Encode, utf8Decode, toLocalBytes, createFontGate, isFallbackFontKey };
