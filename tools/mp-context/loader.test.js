const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');

const LOADER = path.resolve(__dirname, '../../packages/mp_flutter/runtime/canvaskit-loader.js');

test('抢先用正确 attrs 建上下文,拿到 stencil', () => {
  const c = createMpContext();
  const loader = c.requireModule(LOADER);
  const gl = loader.acquireGlContext(c.canvas);
  const at = gl.getContextAttributes();
  assert.strictEqual(at.stencil, true, '必须请求 stencil');
  assert.strictEqual(at.depth, true, '必须请求 depth');
  assert.strictEqual(at.antialias, false, 'Skia 自己做 AA,不要 MSAA');
  assert.strictEqual(gl.getParameter(gl.STENCIL_BITS), 8);
});

test('已被无 stencil 的上下文抢占时必须报错,不静默降级', () => {
  const c = createMpContext();
  const loader = c.requireModule(LOADER);
  c.canvas.getContext('webgl');          // 模拟被别处先建了(默认无 stencil)
  assert.throws(() => loader.acquireGlContext(c.canvas), /stencil/i,
    '没有 stencil 必须显式失败');
});

test('acquireGlContext 幂等:重复调用返回同一上下文', () => {
  const c = createMpContext();
  const loader = c.requireModule(LOADER);
  assert.strictEqual(loader.acquireGlContext(c.canvas), loader.acquireGlContext(c.canvas));
});

test('loadCanvasKit 通过 instantiateWasm 钩子接管 wasm 加载', async () => {
  const c = createMpContext();
  const loader = c.requireModule(LOADER);
  let hookUsed = false, sawPath = null;
  c.sandbox.WXWebAssembly.instantiate = (p, imports) => {
    sawPath = p;
    return Promise.resolve({ instance: { exports: { __fake: 1 } }, module: {} });
  };
  const fakeInit = (moduleArg) => {
    assert.strictEqual(typeof moduleArg.instantiateWasm, 'function',
      '必须提供 instantiateWasm 钩子');
    const ret = moduleArg.instantiateWasm({ a: {} }, (instance) => { hookUsed = true; });
    assert.deepStrictEqual(ret, {}, '异步模式必须返回空对象');
    return Promise.resolve({ GetWebGLContext: () => 1 });
  };
  await loader.loadCanvasKit({
    canvas: c.canvas, wasmPath: '/pkg-wasm/canvaskit.wasm.br', canvasKitInit: fakeInit,
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(sawPath, '/pkg-wasm/canvaskit.wasm.br');
  assert.strictEqual(hookUsed, true, 'successCallback 未被调用');
});

test('wasm 加载失败时 Promise reject,附带路径', async () => {
  const c = createMpContext();
  const loader = c.requireModule(LOADER);
  c.sandbox.WXWebAssembly.instantiate = () => Promise.reject(new Error('boom'));
  const fakeInit = (moduleArg) => new Promise((_, rej) => {
    moduleArg.instantiateWasm({ a: {} }, () => {});
    setTimeout(() => rej(new Error('never resolved')), 30);
  });
  await assert.rejects(
    loader.loadCanvasKit({ canvas: c.canvas, wasmPath: '/w.br', canvasKitInit: fakeInit }),
    /w\.br|boom|never resolved/);
});

// ── 真机修正 #2:GL 驱动字符串规范化 ──────────────────────────────────────
// 仿真上下文(Task 10)按真机行为对 VERSION/RENDERER/VENDOR 返回同一个
// 非标准字符串 "WebGL 1.0(OpenGL ES 3.0)"(括号前无空格)。Skia 建 GrDirectContext
// 时解析这些字符串判断驱动能力,拿到这种值会直接拒绝(MakeGrContext → null,glError=0)。
// 这里钉死:规范化后四个字符串必须是标准格式且互不相同,其余参数原样透传。
test('规范化 GL 驱动字符串:VERSION/VENDOR/RENDERER/SHADING_LANGUAGE_VERSION 改写为标准格式', () => {
  const c = createMpContext();
  const loader = c.requireModule(LOADER);
  const gl = loader.acquireGlContext(c.canvas);

  const SHADING_LANGUAGE_VERSION = 0x8B8C;
  const version = gl.getParameter(gl.VERSION);
  const renderer = gl.getParameter(gl.RENDERER);
  const vendor = gl.getParameter(gl.VENDOR);
  const glsl = gl.getParameter(SHADING_LANGUAGE_VERSION);

  // 真机原始值:三者相同且无空格,"WebGL 1.0(OpenGL ES 3.0)"
  assert.notStrictEqual(version, 'WebGL 1.0(OpenGL ES 3.0)',
    'VERSION 不应再是真机原始的非标准值');
  assert.notStrictEqual(renderer, version, 'RENDERER 规范化后不应再与 VERSION 相同');
  assert.notStrictEqual(vendor, version, 'VENDOR 规范化后不应再与 VERSION 相同');

  assert.match(version, /^WebGL 1\.0 \(OpenGL ES/, 'VERSION 必须是标准格式(括号前带空格)');
  assert.strictEqual(typeof renderer, 'string');
  assert.strictEqual(typeof vendor, 'string');
  assert.match(glsl, /^WebGL GLSL ES/, 'SHADING_LANGUAGE_VERSION 必须是标准格式');
});

test('规范化只改写四个只读字符串,其余 GL 参数原样透传', () => {
  const c = createMpContext();
  const loader = c.requireModule(LOADER);
  const gl = loader.acquireGlContext(c.canvas);

  assert.strictEqual(gl.getParameter(gl.STENCIL_BITS), 8, 'STENCIL_BITS 必须透传不变');
  assert.strictEqual(gl.getParameter(gl.DEPTH_BITS), 24, 'DEPTH_BITS 必须透传不变');
  assert.strictEqual(gl.getParameter(gl.SAMPLES), 0, 'SAMPLES 必须透传不变');
  // 未知/无关参数必须原样透传给底层实现(此处底层对未识别 pname 返回 0)
  assert.strictEqual(gl.getParameter(0x9999), 0, '未识别的 pname 必须透传底层返回值');
  assert.strictEqual(typeof gl.getSupportedExtensions, 'function',
    '规范化不应动到 getParameter 以外的方法');
  assert.strictEqual(gl.getSupportedExtensions().length, 13,
    'getSupportedExtensions 返回值必须原样透传(真机只有 13 个扩展)');
});
