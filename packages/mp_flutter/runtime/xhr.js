'use strict';
/**
 * 基于 net.route 的 XMLHttpRequest。框架的 NetworkImage(web)与 dio 都用它:
 * GET + responseType='arraybuffer' 取图片字节,再交给 CanvasKit 解码。
 * 不支持:同步请求、responseType 'blob'/'document'、FormData/Blob 请求体、真实上传进度。
 */
const { utf8Decode } = require('./net.js');

function createXMLHttpRequestClass(deps) {
  const STATES = { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 };

  function makeTarget(obj) {
    obj._l = {};
    obj.addEventListener = function (t, fn) { if (typeof fn === 'function') (this._l[t] = this._l[t] || []).push(fn); };
    obj.removeEventListener = function (t, fn) { const a = this._l[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } };
    obj.dispatchEvent = function (ev) {
      try { ev.target = ev.target || this; ev.currentTarget = this; } catch (e) { /* 只读字段 */ }
      const prop = this['on' + ev.type];
      if (typeof prop === 'function') { try { prop.call(this, ev); } catch (e) { console.error('[mp-flutter] XHR on' + ev.type + ' 异常:', e); } }
      (this._l[ev.type] || []).slice().forEach((fn) => { try { fn.call(this, ev); } catch (e) { console.error('[mp-flutter] XHR ' + ev.type + ' 监听器异常:', e); } });
      return true;
    };
    return obj;
  }

  function XMLHttpRequest() {
    makeTarget(this);
    this.upload = makeTarget({ onprogress: null, onload: null, onloadend: null, onerror: null, onabort: null, onloadstart: null, ontimeout: null });
    this.readyState = 0; this.status = 0; this.statusText = ''; this.response = null;
    this.responseType = ''; this.responseURL = ''; this.timeout = 0; this.withCredentials = false;
    this._headers = {}; this._resHeaders = {}; this._method = 'GET'; this._url = ''; this._ac = null; this._done = false;
    ['onreadystatechange', 'onloadstart', 'onprogress', 'onload', 'onerror', 'ontimeout', 'onabort', 'onloadend'].forEach((k) => { this[k] = null; });
  }
  Object.keys(STATES).forEach((k) => { XMLHttpRequest[k] = STATES[k]; XMLHttpRequest.prototype[k] = STATES[k]; });

  const P = XMLHttpRequest.prototype;
  P._fire = function (type, extra) {
    const E = type === 'progress' || type === 'load' || type === 'loadend' || type === 'loadstart' ? deps.ProgressEvent : deps.Event;
    this.dispatchEvent(new E(type, Object.assign({ lengthComputable: false, loaded: 0, total: 0 }, extra || {})));
  };
  P._setState = function (s) { this.readyState = s; this._fire('readystatechange'); };
  Object.defineProperty(P, 'responseText', {
    get() {
      if (this.responseType !== '' && this.responseType !== 'text') throw new Error('responseType 为 ' + this.responseType + ' 时不能读 responseText');
      return this._bytes ? utf8Decode(this._bytes) : '';
    },
  });
  P.open = function (method, url, async) {
    if (async === false) throw new Error('mp-flutter: 小程序不支持同步 XMLHttpRequest');
    this._method = String(method || 'GET').toUpperCase(); this._url = String(url);
    this._headers = {}; this._resHeaders = {}; this._done = false; this.status = 0; this.response = null; this._bytes = null;
    this._setState(1);
  };
  P.setRequestHeader = function (k, v) {
    if (this.readyState !== 1) throw new Error('setRequestHeader 必须在 open 之后、send 之前调用');
    this._headers[k] = this._headers[k] == null ? String(v) : this._headers[k] + ', ' + v;
  };
  P.overrideMimeType = function () {};
  P.getResponseHeader = function (k) { const v = this._resHeaders[String(k).toLowerCase()]; return v == null ? null : v; };
  P.getAllResponseHeaders = function () {
    if (this.readyState < 2) return '';
    return Object.keys(this._resHeaders).sort().map((k) => k + ': ' + this._resHeaders[k] + '\r\n').join('');
  };
  P.send = function (body) {
    if (this.readyState !== 1) throw new Error('send 必须在 open 之后调用');
    if (this.responseType === 'blob' || this.responseType === 'document') {
      throw new Error('mp-flutter: 暂不支持 responseType=' + this.responseType + '(请用 arraybuffer)');
    }
    const net = deps.getNet();
    // 轻量 abort signal:net.route 只需要 aborted + addEventListener('abort')
    // + removeEventListener —— Task 1 的 wxRequest 在请求落地(成功/失败/超时)
    // 后一定会调用 signal.removeEventListener('abort', onAbort) 摘除监听器,
    // 这里必须提供真正生效的 removeEventListener,否则调用会直接抛错。
    const ac = {
      aborted: false, reason: undefined, _l: [],
      addEventListener(t, fn) { if (t === 'abort') this._l.push(fn); },
      removeEventListener(t, fn) { const i = this._l.indexOf(fn); if (i >= 0) this._l.splice(i, 1); },
    };
    this._ac = ac;
    const hasBody = body != null && this._method !== 'GET' && this._method !== 'HEAD';
    this._fire('loadstart');
    if (hasBody) this.upload.dispatchEvent(new deps.ProgressEvent('loadstart', { loaded: 0, total: 0 }));
    net.route({ method: this._method, url: this._url, headers: this._headers, body: hasBody ? body : undefined, timeout: this.timeout, signal: ac })
      .then((r) => {
        if (this._done) return;
        if (hasBody) {
          this.upload.dispatchEvent(new deps.ProgressEvent('progress', { lengthComputable: true, loaded: 1, total: 1 }));
          this.upload.dispatchEvent(new deps.ProgressEvent('load', { lengthComputable: true, loaded: 1, total: 1 }));
          this.upload.dispatchEvent(new deps.ProgressEvent('loadend', { lengthComputable: true, loaded: 1, total: 1 }));
        }
        this.status = r.status; this.statusText = r.statusText; this.responseURL = r.url; this._resHeaders = r.headers;
        this._setState(2); this._setState(3);
        const n = r.bytes.length;
        if (this.responseType === 'arraybuffer') {
          // r.bytes 来自 net.js 的 toLocalBytes/decodeParts,几乎总是独占一整块
          // 刚分配的 buffer(byteOffset=0 且 byteLength=buffer.byteLength)——
          // 这种情况下 .slice() 是一次多余的整包拷贝,直接复用底层 buffer 即可。
          // responseText/JSON 才需要保留 _bytes,arraybuffer 模式不读它。
          this.response = (r.bytes.byteOffset === 0 && r.bytes.byteLength === r.bytes.buffer.byteLength)
            ? r.bytes.buffer
            : r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + n);
        } else if (this.responseType === 'json') {
          this._bytes = r.bytes;
          try { this.response = JSON.parse(utf8Decode(r.bytes)); } catch (e) { this.response = null; }
        } else {
          this._bytes = r.bytes;
          this.response = utf8Decode(r.bytes);
        }
        this._fire('progress', { lengthComputable: true, loaded: n, total: n });
        this._done = true;
        this._setState(4);
        this._fire('load', { lengthComputable: true, loaded: n, total: n });
        this._fire('loadend', { lengthComputable: true, loaded: n, total: n });
      }, (e) => {
        if (this._done) return;
        this._done = true; this.status = 0;
        this._setState(4);
        const kind = e && e.mpKind;
        if (kind !== 'abort') console.warn('[mp-flutter] XHR 失败:', e && e.message);
        this._fire(kind === 'timeout' ? 'timeout' : kind === 'abort' ? 'abort' : 'error');
        this._fire('loadend');
      });
  };
  P.abort = function () {
    const ac = this._ac;
    if (!ac || this._done) { this.readyState = 0; return; }
    ac.aborted = true;
    ac._l.slice().forEach((fn) => { try { fn(); } catch (e) { /* 忽略 */ } });
    // net.route 会以 AbortError 拒绝;若底层不支持取消,也在这里立即收尾
    this._done = true; this.status = 0;
    this._setState(4);
    this._fire('abort');
    this._fire('loadend');
  };
  return XMLHttpRequest;
}

module.exports = { createXMLHttpRequestClass };
