'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

/**
 * 仿微信小程序逻辑层 JS Context。
 *
 * 能力集严格对齐真机实测(iPhone 15 / iOS 26.5 / 基础库 3.17.3):
 *
 *   真机具备(13 项):
 *   globalThis console setTimeout queueMicrotask Promise Proxy Reflect
 *   WeakRef FinalizationRegistry BigInt Intl Atomics WXWebAssembly
 *
 *   真机缺失(包括这些模拟器里有的):
 *   performance TextDecoder TextEncoder FontFace WebGLRenderingContext
 *   window document navigator location fetch URL Blob FileReader
 *   requestAnimationFrame MutationObserver ResizeObserver
 *   OffscreenCanvas createImageBitmap Image WebAssembly
 *
 *   行为差异:
 *   · canvas.getContext() 第二次调用返回 null(非幂等)
 *   · WebGL VERSION/RENDERER/VENDOR 返回同一非标准字符串 "WebGL 1.0(OpenGL ES 3.0)"
 *   · WebGL 扩展只有 13 个(缺 OES_element_index_uint、EXT_blend_minmax、WEBGL_depth_texture)
 *
 * 依据:2026-09-26 真机验证报告 §3
 * 本任务的全部价值:让本地单测能抓出真机上会出的问题。基准错了反而给虚假安全感。
 */
function createMpContext(opts = {}) {
  const W = opts.canvasWidth || 366;
  const H = opts.canvasHeight || 249;
  const dpr = opts.dpr || 3;
  const calls = [];
  const record = (name, args) => calls.push({ name, args });
  // wx 同步存储桩的底层数据:允许测试传入共享 Map,模拟"小程序重启后仍在"。
  const store = opts.storage || new Map();

  // 模拟"外来 realm":wx 网络类 API 返回的 ArrayBuffer 与 wx.base64ToArrayBuffer
  // 一样,不是本 vm.Context 的 intrinsic(开发者工具 2.02 起原型被冻结)。
  const foreignRealm = vm.runInNewContext(
    'Object.freeze(ArrayBuffer.prototype); (b) => { const a = new ArrayBuffer(b.length); new Uint8Array(a).set(b); return a; }');
  const foreignArrayBuffer = (buf) => foreignRealm(buf);

  // 小程序的 canvas 节点。无 addEventListener。
  // ★ getContext 采用真机行为:第二次调用返回 null(模拟器是幂等返回同一对象)。
  // 真机 iPhone 15 实测。仿真上下文必须复现真机行为 ——
  // 照模拟器写会让本地单测放过真机上必然出现的 bug。
  let glCtx = null;
  let glAttrs = null;
  let glHandedOut = false;
  const canvas = {
    width: W,
    height: H,
    getContext(type, attrs) {
      record('canvas.getContext', [type, attrs]);
      if (type !== 'webgl') return null;          // 无 webgl2(实测)
      if (glHandedOut) {                           // ★ 真机:第二次起返回 null
        record('canvas.getContext → null(第二次调用)', [type]);
        return null;
      }
      glHandedOut = true;
      glAttrs = Object.assign(
        { alpha: true, depth: false, stencil: false, antialias: false,
          premultipliedAlpha: true, preserveDrawingBuffer: false },
        attrs || {});
      glCtx = makeFakeGl(glAttrs, W, H, dpr, record);
      return glCtx;
    },
    requestAnimationFrame(cb) { record('canvas.requestAnimationFrame', []); return setTimeout(() => cb(Date.now()), 16); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    createImage() { return {}; },
    createImageData() { return {}; },
    createPath2D() { return {}; },
    toDataURL() { return ''; },
  };

  const wx = {
    getWindowInfo: () => ({ pixelRatio: dpr, windowWidth: W, windowHeight: H }),
    getDeviceInfo: () => ({ platform: 'devtools', system: 'iOS 17.0' }),
    getSystemInfoSync: () => ({ pixelRatio: dpr, windowWidth: W, windowHeight: H, SDKVersion: '3.15.0' }),
    base64ToArrayBuffer: (b64) => Uint8Array.from(Buffer.from(b64, 'base64')).buffer,
    arrayBufferToBase64: (buf) => Buffer.from(buf).toString('base64'),
    createOffscreenCanvas: () => canvas,
    getFileSystemManager: () => ({
      // 实测:代码包内二进制文件读不到
      readFileSync() { const e = new Error('readFileSync:fail permission denied'); throw e; },
    }),
    createSelectorQuery: () => ({
      select: () => ({ node: (cb) => ({ exec: () => cb({ node: canvas }) }) }),
    }),
    // 网络桩:opts.net 为 (req) => { statusCode, header, data(Buffer|string) } | { fail: errMsg } | Promise
    request(req) {
      record('wx.request', [req.method || 'GET', req.url]);
      let aborted = false;
      const task = { abort() { aborted = true; setTimeout(() => req.fail && req.fail({ errMsg: 'request:fail abort' }), 0); } };
      Promise.resolve().then(() => (opts.net ? opts.net(req) : { statusCode: 404, header: {}, data: Buffer.alloc(0) }))
        .then((r) => {
          if (aborted) return;
          if (r && r.fail) { req.fail && req.fail({ errMsg: r.fail }); return; }
          // 模拟外来 realm:用 vm 另一个上下文的 ArrayBuffer(原型冻结)
          const data = Buffer.isBuffer(r.data) ? foreignArrayBuffer(r.data) : r.data;
          req.success && req.success({ statusCode: r.statusCode, header: r.header || {}, data });
        });
      return task;
    },
    // wx 同步存储桩:数据放闭包 Map(store),模拟小程序 wx.setStorageSync 一族。
    // opts.storageQuotaKeys 可让指定键在 setStorageSync 时抛错,模拟超限。
    getStorageSync(k) { return store.has(k) ? JSON.parse(store.get(k)) : ''; },
    setStorageSync(k, v) {
      if ((opts.storageQuotaKeys || []).includes(k)) throw new Error('setStorageSync:fail exceed storage max size');
      store.set(k, JSON.stringify(v));
    },
    removeStorageSync(k) { store.delete(k); },
    getStorageInfoSync() { return { keys: [...store.keys()], currentSize: 0, limitSize: 10240 }; },
  };

  const sandbox = Object.create(null);
  Object.assign(sandbox, {
    Object, Array, Function, Boolean, Number, String, Symbol, BigInt,
    Math, JSON, Date, RegExp, Error, TypeError, RangeError, SyntaxError,
    ReferenceError, Promise, Proxy, Reflect, Map, Set, WeakMap, WeakSet,
    WeakRef, FinalizationRegistry, Atomics,
    ArrayBuffer, DataView, Int8Array, Uint8Array, Uint8ClampedArray,
    Int16Array, Uint16Array, Int32Array, Uint32Array,
    Float32Array, Float64Array, BigInt64Array, BigUint64Array,
    isNaN, isFinite, parseInt, parseFloat, NaN, Infinity,
    encodeURI, encodeURIComponent, decodeURI, decodeURIComponent,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    console,
    WXWebAssembly: {
      instantiate: () => Promise.reject(new Error('mp-context: 未提供 wasm')),
      compile: () => Promise.reject(new Error('mp-context: 未提供 wasm')),
      Memory: function () {}, Table: function () {},
      Module: function () {}, Instance: function () {},
    },
    wx,
    // 显式关闭模拟器/Node 里有、真机没有的全局
    // (Node.js 的 vm.createContext 可能会泄露这些)
    window: undefined,
    document: undefined,
    navigator: undefined,
    location: undefined,
    self: undefined,
    performance: undefined,
    TextEncoder: undefined,
    TextDecoder: undefined,
    FontFace: undefined,
    WebGLRenderingContext: undefined,
    WebGL2RenderingContext: undefined,
    URL: undefined,
    Blob: undefined,
    FileReader: undefined,
    fetch: undefined,
    XMLHttpRequest: undefined,
    WebAssembly: undefined,
    SharedArrayBuffer: undefined,
    Worker: undefined,
    requestAnimationFrame: undefined,
    cancelAnimationFrame: undefined,
    MutationObserver: undefined,
    ResizeObserver: undefined,
    IntersectionObserver: undefined,
    OffscreenCanvas: undefined,
    createImageBitmap: undefined,
    Image: undefined,
    localStorage: undefined,
    sessionStorage: undefined,
  });
  // opts.noIntl:模拟整个没有 Intl 的安卓真机 JS 引擎(真机实测裸引用 Intl 抛
  // ReferenceError)。vm 上下文自带内建 Intl,必须进上下文里 delete 才能让裸引用
  // 也抛 ReferenceError;只在 sandbox 上放 undefined 模拟不出这一点。
  if (!opts.noIntl) sandbox.Intl = Intl;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  if (opts.noIntl) vm.runInContext('delete globalThis.Intl;', ctx);

  // 极简 CommonJS:让被测 JS 能 require 同目录模块
  const cache = new Map();
  function requireModule(file) {
    const abs = path.resolve(file);
    if (cache.has(abs)) return cache.get(abs).exports;
    const mod = { exports: {} };
    cache.set(abs, mod);
    const src = fs.readFileSync(abs, 'utf8');
    const wrapper = vm.runInContext(
      `(function(exports, require, module, __filename, __dirname){${src}\n})`,
      ctx, { filename: abs });
    wrapper(mod.exports,
      (p) => requireModule(p.startsWith('.') ? path.resolve(path.dirname(abs), p) : p),
      mod, abs, path.dirname(abs));
    return mod.exports;
  }

  return {
    sandbox, wx, canvas, calls,
    get glAttrs() { return glAttrs; },
    run: (code, filename) => vm.runInContext(code, ctx, { filename: filename || 'eval' }),
    requireModule,
    // 预置模块导出(替代构建期才产出、或需要打桩的模块,如 canvaskit.js)
    stubModule: (file, exports) => cache.set(path.resolve(file), { exports }),
  };
}

function makeFakeGl(attrs, W, H, dpr, record) {
  // 真机 iPhone 15 实测的 WebGL 常量和行为
  const gl = {
    VERSION: 0x1F02, RENDERER: 0x1F01, VENDOR: 0x1F00,
    STENCIL_BITS: 0x0D57, DEPTH_BITS: 0x0D56, SAMPLES: 0x80A9,
    RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    drawingBufferWidth: W * dpr, drawingBufferHeight: H * dpr,
    canvas: null,
    getContextAttributes: () => Object.assign({}, attrs),
    getParameter(p) {
      if (p === gl.STENCIL_BITS) return attrs.stencil ? 8 : 0;
      if (p === gl.DEPTH_BITS) return attrs.depth ? 24 : 0;
      if (p === gl.SAMPLES) return 0;
      // ★ 真机特性:VERSION/RENDERER/VENDOR 返回同一非标准字符串
      if (p === gl.VERSION || p === gl.RENDERER || p === gl.VENDOR) {
        return 'WebGL 1.0(OpenGL ES 3.0)';
      }
      return 0;
    },
    // ★ 真机只有 13 个扩展(缺 OES_element_index_uint、EXT_blend_minmax、WEBGL_depth_texture)
    getSupportedExtensions: () => [
      'OES_vertex_array_object',
      'OES_texture_float',
      'OES_texture_float_linear',
      'OES_texture_half_float',
      'OES_texture_half_float_linear',
      'EXT_texture_filter_anisotropic',
      'EXT_frag_depth',
      'EXT_shader_texture_lod',
      'WEBGL_lose_context',
      'WEBGL_debug_renderer_info',
      'WEBGL_debug_shaders',
      'ANGLE_instanced_arrays',
      'WEBGL_compressed_texture_s3tc',
    ],
    getExtension: () => null,
    getError: () => 0,
    readPixels: (x, y, w, h, f, t, buf) => { buf.fill(0); record('gl.readPixels', [x, y]); },
    createTexture: () => ({}),
  };
  return gl;
}

module.exports = { createMpContext };
