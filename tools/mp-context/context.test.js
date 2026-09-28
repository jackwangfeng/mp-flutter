const test = require('node:test');
const assert = require('node:assert');
const { createMpContext } = require('./context');

test('缺失的浏览器全局确实缺失', () => {
  const c = createMpContext();
  // 包括这些模拟器有、真机没有的(Brief 指明的 5 个坑点):
  for (const g of ['window', 'document', 'navigator', 'fetch', 'URL',
                   'requestAnimationFrame', 'ResizeObserver', 'WebAssembly',
                   'performance', 'TextEncoder', 'TextDecoder', 'FontFace',
                   'WebGLRenderingContext']) {
    assert.strictEqual(c.run(`typeof ${g}`), 'undefined', `${g} 不该存在(真机验证)`);
  }
});

test('该有的全局都在(真机具备 13 项)', () => {
  const c = createMpContext();
  // 真机实测具备的完整 13 项
  for (const g of ['globalThis', 'console', 'setTimeout', 'queueMicrotask', 'Promise',
                   'Proxy', 'Reflect', 'WeakRef', 'FinalizationRegistry', 'BigInt',
                   'Intl', 'Atomics', 'WXWebAssembly']) {
    assert.notStrictEqual(c.run(`typeof ${g}`), 'undefined', `${g} 应该存在(真机具备)`);
  }
  // wx 特殊对象也应该存在
  assert.notStrictEqual(c.run(`typeof wx`), 'undefined', `wx 应该存在`);
});

test('getContext 第二次调用返回 null(真机行为,非模拟器的幂等)', () => {
  const c = createMpContext();
  const a = c.canvas.getContext('webgl', { stencil: true });
  assert.ok(a, '首次调用应返回上下文');
  assert.strictEqual(a.getContextAttributes().stencil, true, '属性由首次调用决定');
  const b = c.canvas.getContext('webgl', { stencil: false });
  assert.strictEqual(b, null,
    '真机 iPhone 15 实测:第二次 getContext 返回 null。' +
    '仿真上下文必须复现真机行为,否则本地单测会放过真机上必然出现的 bug。');
});

test('webgl2 拿不到', () => {
  const c = createMpContext();
  assert.strictEqual(c.canvas.getContext('webgl2'), null);
});

test('代码包内二进制文件读不到', () => {
  const c = createMpContext();
  assert.throws(() => c.wx.getFileSystemManager().readFileSync('/a.ttf'), /permission denied/);
});

test('WebGL VERSION/RENDERER/VENDOR 返回真机非标准字符串', () => {
  const c = createMpContext();
  const gl = c.canvas.getContext('webgl');
  const versionStr = 'WebGL 1.0(OpenGL ES 3.0)';
  assert.strictEqual(gl.getParameter(gl.VERSION), versionStr,
    '真机 iPhone 15 实测:VERSION 返回非标准字符串');
  assert.strictEqual(gl.getParameter(gl.RENDERER), versionStr,
    '真机:RENDERER 返回同一非标准字符串');
  assert.strictEqual(gl.getParameter(gl.VENDOR), versionStr,
    '真机:VENDOR 返回同一非标准字符串');
});

test('WebGL 扩展列表(13 个,缺 OES_element_index_uint/EXT_blend_minmax/WEBGL_depth_texture)', () => {
  const c = createMpContext();
  const gl = c.canvas.getContext('webgl');
  const exts = gl.getSupportedExtensions();
  assert.strictEqual(exts.length, 13, '真机只有 13 个扩展');
  // 验证不包含模拟器有、真机没有的扩展
  assert.ok(!exts.includes('OES_element_index_uint'), '不应包含 OES_element_index_uint');
  assert.ok(!exts.includes('EXT_blend_minmax'), '不应包含 EXT_blend_minmax');
  assert.ok(!exts.includes('WEBGL_depth_texture'), '不应包含 WEBGL_depth_texture');
  // 验证包含应有的扩展
  assert.ok(exts.includes('OES_vertex_array_object'), '应包含 OES_vertex_array_object');
  assert.ok(exts.includes('OES_texture_float'), '应包含 OES_texture_float');
  assert.ok(exts.includes('WEBGL_lose_context'), '应包含 WEBGL_lose_context');
});

test('wx 对象提供基本接口', () => {
  const c = createMpContext();
  assert.ok(c.wx.getWindowInfo, 'wx.getWindowInfo 存在');
  assert.ok(c.wx.getSystemInfoSync, 'wx.getSystemInfoSync 存在');
  const info = c.wx.getWindowInfo();
  assert.strictEqual(info.windowWidth, 366);
  assert.strictEqual(info.windowHeight, 249);
  assert.strictEqual(info.pixelRatio, 3);
});

test('requireModule 能加载并执行 CommonJS 模块', () => {
  const c = createMpContext();
  const testModulePath = '/tmp/test-module-' + Math.random().toString(36).slice(2) + '.js';
  const fs = require('fs');
  fs.writeFileSync(testModulePath, `
    module.exports = {
      add: (a, b) => a + b,
      greet: () => 'hello'
    };
  `);
  try {
    const mod = c.requireModule(testModulePath);
    assert.strictEqual(mod.add(2, 3), 5);
    assert.strictEqual(mod.greet(), 'hello');
  } finally {
    fs.unlinkSync(testModulePath);
  }
});

test('globalThis.window 在真机上可写', () => {
  const c = createMpContext();
  // 真机上可以写入 globalThis.window,模拟器不行
  c.run(`globalThis.window = { test: 123 }`);
  const result = c.run(`globalThis.window?.test`);
  assert.strictEqual(result, 123, '真机允许写入 globalThis.window');
});

test('canvas 提供基本方法', () => {
  const c = createMpContext();
  assert.ok(c.canvas.createImage, 'canvas.createImage 存在');
  assert.ok(c.canvas.createImageData, 'canvas.createImageData 存在');
  assert.ok(c.canvas.createPath2D, 'canvas.createPath2D 存在');
  assert.ok(c.canvas.toDataURL, 'canvas.toDataURL 存在');
  assert.strictEqual(c.canvas.width, 366);
  assert.strictEqual(c.canvas.height, 249);
});

test('WebGL 上下文属性配置正确', () => {
  const c = createMpContext();
  const gl = c.canvas.getContext('webgl', { depth: true, alpha: false });
  const attrs = gl.getContextAttributes();
  assert.strictEqual(attrs.depth, true);
  assert.strictEqual(attrs.alpha, false);
  assert.strictEqual(attrs.stencil, false); // 默认值
  assert.strictEqual(gl.getParameter(gl.DEPTH_BITS), 24);
  assert.strictEqual(gl.getParameter(gl.STENCIL_BITS), 0);
});

test('cachemodule 在 requireModule 中正常工作', () => {
  const c = createMpContext();
  const testModulePath = '/tmp/test-cache-' + Math.random().toString(36).slice(2) + '.js';
  const fs = require('fs');
  fs.writeFileSync(testModulePath, `
    let callCount = 0;
    module.exports = {
      getCount: () => ++callCount
    };
  `);
  try {
    const mod1 = c.requireModule(testModulePath);
    const mod2 = c.requireModule(testModulePath);
    assert.strictEqual(mod1, mod2, '同一文件的两次 require 应返回缓存的 module');
    assert.strictEqual(mod1.getCount(), 1, '模块初始化只执行一次');
    assert.strictEqual(mod2.getCount(), 2, '两个引用指向同一对象');
  } finally {
    fs.unlinkSync(testModulePath);
  }
});

test('Node.js 全局不会泄漏进 sandbox', () => {
  const c = createMpContext();
  // 这些 Node.js 专有全局在真机上不存在
  // 泄漏会导致垫片用了 require/Buffer/process 等在真机通过本地测试,
  // 但真机上直接 ReferenceError(虚假安全感)
  for (const g of ['require', 'process', 'Buffer', '__dirname', '__filename',
                   'module', 'exports', 'global', 'setImmediate']) {
    assert.strictEqual(c.run(`typeof ${g}`), 'undefined',
      `Node.js 全局 ${g} 不应泄漏进 sandbox(真机不存在)`);
  }
});
