'use strict';

// 小程序的 canvas.getContext:第一次调用定死属性,之后传什么 attrs 都没用;
// 且真机 iOS 上**第二次调用直接返回 null**(模拟器是幂等返回同一对象)——
// 所以必须缓存首次拿到的上下文并复用。
// Skia 画裁剪/路径必须要 stencil,而 WebGL 规范默认 stencil:false。
// 所以必须由我们抢在引擎之前建上下文。
const GL_ATTRS = {
  alpha: true,
  depth: true,
  stencil: true,
  antialias: false,          // Skia 自己做抗锯齿,MSAA 只是白费带宽
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
};

// 真机修正 #2:小程序 iOS 的 WebGL 对 VERSION/RENDERER/VENDOR 三个参数
// 返回同一个非标准字符串 "WebGL 1.0(OpenGL ES 3.0)"(括号前无空格)。
// Skia 建 GrDirectContext 时会解析这些字符串判断驱动能力,拿到这种值直接拒绝
// (MakeGrContext → null,glError=0,不是 GL 调用失败,是 Skia 主动判定不可用)。
// 解法:只改写这四个只读字符串参数为标准格式,其余一律透传。
const GL_VERSION = 0x1F02;
const GL_VENDOR = 0x1F00;
const GL_RENDERER = 0x1F01;
const GL_SHADING_LANGUAGE_VERSION = 0x8B8C;

const STANDARD_DRIVER_STRINGS = {
  [GL_VERSION]: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
  [GL_SHADING_LANGUAGE_VERSION]: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
  [GL_VENDOR]: 'WeChat',
  [GL_RENDERER]: 'WeChat MiniProgram WebGL',
};

/** 包一层 getParameter,只改写四个只读字符串,其余原样透传给底层实现。 */
function normalizeGlDriverStrings(gl) {
  const originalGetParameter = gl.getParameter.bind(gl);
  gl.getParameter = function (pname) {
    if (Object.prototype.hasOwnProperty.call(STANDARD_DRIVER_STRINGS, pname)) {
      return STANDARD_DRIVER_STRINGS[pname];
    }
    return originalGetParameter(pname);
  };
  return gl;
}

const _ctxCache = new WeakMap();

function acquireGlContext(canvas) {
  if (_ctxCache.has(canvas)) return _ctxCache.get(canvas);

  const gl = canvas.getContext('webgl', GL_ATTRS);
  if (!gl) {
    throw new Error(
      '[mp-flutter] 无法获取 WebGL 上下文(canvas.getContext 返回 null)。\n' +
      '真机上 canvas.getContext 第二次调用会返回 null(开发者工具模拟器是幂等返回同一对象)——\n' +
      '这个 canvas 的上下文很可能已经被别处以默认属性(无 stencil)抢先建立。\n' +
      '请确保在任何其他 getContext 调用之前,先调用 acquireGlContext()。');
  }

  const at = gl.getContextAttributes ? gl.getContextAttributes() : null;
  const stencilBits = gl.getParameter(gl.STENCIL_BITS);
  if ((at && !at.stencil) || !stencilBits) {
    throw new Error(
      '[mp-flutter] WebGL 上下文没有 stencil buffer(STENCIL_BITS=' + stencilBits + ')。\n' +
      '小程序的 canvas.getContext 首次调用定死属性(真机上第二次调用还会返回 null)——\n' +
      '上下文很可能已被别处用默认属性建立。\n' +
      '请确保在任何其他 getContext 调用之前先调用 acquireGlContext()。\n' +
      '没有 stencil,Skia 的裁剪与路径渲染会失败,MakeOnScreenGLSurface 返回 null。');
  }

  normalizeGlDriverStrings(gl);
  _ctxCache.set(canvas, gl);
  return gl;
}

/**
 * 加载 CanvasKit。
 * 用 emscripten 官方的 Module.instantiateWasm 钩子接管 wasm 加载,
 * emscripten 自己的 fetch / WebAssembly.instantiateStreaming / XHR 逻辑整段跳过。
 */
function loadCanvasKit(opts) {
  const canvas = opts.canvas;
  const wasmPath = opts.wasmPath;
  const canvasKitInit = opts.canvasKitInit;

  acquireGlContext(canvas);   // 必须在 CanvasKit 之前

  return canvasKitInit({
    print: (t) => console.log('[canvaskit] ' + t),
    printErr: (t) => console.error('[canvaskit] ' + t),
    instantiateWasm: function (imports, successCallback) {
      WXWebAssembly.instantiate(wasmPath, imports)
        .then(function (r) { successCallback(r.instance, r.module); })
        .catch(function (e) {
          console.error('[mp-flutter] wasm 加载失败 ' + wasmPath + ': ' + (e && e.message || e));
        });
      // 用 Object() 而非 {} 字面量:{} 字面量的原型来自当前执行 realm,
      // 跨 vm.createContext 边界后与宿主 realm 的 Object.prototype 不再相等,
      // 会让调用方用宿主字面量 {} 做 deepStrictEqual 比较时失败。
      // Object() 显式调用注入的宿主构造函数,产出的对象走宿主 realm 的原型链。
      return Object();   // 空对象 = 告诉 emscripten 走异步
    },
  });
}

/**
 * 把 image.js 解码过的 <img> 元素的 MakeLazyImageFromTextureSource 路由到 wasm 解码结果。
 *
 * 引擎对静态图:img.decode() 之后调 CanvasKit.MakeLazyImageFromTextureSource(img, info)
 * 做纹理上传。小程序没有真 <img>;image.js 的 decode() 已用 MakeImageFromEncoded 解好
 * (或由微信原生解码成原生图片对象),这里把这类元素的请求交给 images.takeImage
 * (返回的 SkImage 归引擎所有,CkImage dispose 时由引擎 delete)。其余来源原样走
 * CanvasKit 自己的实现。
 */
function routeImageElements(CK, images) {
  const orig = CK.MakeLazyImageFromTextureSource;
  // 原生解码的 <img>(image.js 文件头"原生解码"):把微信原生图片对象交给 CanvasKit
  // 自己的实现,画时 texImage2D 直接上传
  const makeLazy = typeof orig === 'function' ? (src, info) => orig.call(CK, src, info) : null;
  CK.MakeLazyImageFromTextureSource = function (src, info) {
    if (images.owns(src)) return images.takeImage(src, info, makeLazy);
    return typeof orig === 'function' ? orig.apply(this, arguments) : null;
  };
  return CK;
}

module.exports = { acquireGlContext, loadCanvasKit, routeImageElements, GL_ATTRS };
