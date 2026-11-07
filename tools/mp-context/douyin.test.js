const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createMpContext } = require('./context');
const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');
function context() {
  const c = createMpContext();
  c.sandbox.tt = c.wx;
  delete c.sandbox.wx;
  c.sandbox.TTWebAssembly = c.sandbox.WXWebAssembly;
  delete c.sandbox.WXWebAssembly;
  return c;
}
test('Douyin host uses tt-only realm, bound methods and current system info', () => {
  const c = context();
  delete c.wx.getWindowInfo;
  delete c.wx.getDeviceInfo;
  let width = 390;
  c.wx.getSystemInfoSync = function () { assert.equal(this, c.wx); return {windowWidth:width}; };
  const host = c.requireModule(path.join(RT, 'host.js')).getHost('douyin');
  assert.equal(host.api.getWindowInfo().windowWidth, 390);
  width = 400;
  assert.equal(host.api.getWindowInfo().windowWidth, 400);
  assert.equal(host.api.getDeviceInfo().windowWidth, 400);
  assert.equal(c.run('typeof wx'), 'undefined');
});
test('Douyin canvas query uses node().exec() result array', () => {
  const c = context();
  c.wx.createSelectorQuery = () => ({select(selector) {
    assert.equal(selector, '#flutter-canvas');
    return {node(...args) {assert.equal(args.length, 0); return {exec(callback) {callback([{node:c.canvas}]);}};}};
  }});
  c.requireModule(path.join(RT, 'host.js')).getHost('douyin').selectCanvas('#flutter-canvas', result => assert.equal(result.node, c.canvas));
});
test('Douyin loader invokes TTWebAssembly without WXWebAssembly', async () => {
  const c = context();
  let loaded;
  c.sandbox.TTWebAssembly.instantiate = async (file, imports) => {loaded = file; return {instance:{exports:{}}, module:{}};};
  await c.requireModule(path.join(RT, 'canvaskit-loader.js')).loadCanvasKit({
    canvas:c.canvas, wasmPath:'/pkg-wasm/canvaskit.wasm.br',
    canvasKitInit(options) {return new Promise(resolve => options.instantiateWasm({}, () => resolve({GetWebGLContext:()=>1})));},
  });
  assert.equal(loaded, '/pkg-wasm/canvaskit.wasm.br');
});
test('Douyin boot initializes engine without exposing WeChat/native bridges', async () => {
  const c = context();
  c.stubModule(path.join(RT, 'canvaskit.js'), () => {});
  c.stubModule(path.join(RT, 'canvaskit-loader.js'), {
    loadCanvasKit:async options => {assert.equal(options.wasm, c.sandbox.TTWebAssembly); assert.equal(options.requireStencil, false); return {};},
    routeImageElements:require(path.join(RT, 'canvaskit-loader.js')).routeImageElements,
  });
  let ran = false;
  const result = await c.requireModule(path.join(RT, 'boot.js')).boot({
    canvas:c.canvas, cssWidth:390, cssHeight:844, nativeImage:false,
    host:c.requireModule(path.join(RT, 'host.js')).getHost('douyin'),
    manifest:{subPackages:{}, assets:{}, loadDart:async () => {
      assert.equal(c.run('!!self.__mpWechat'), false);
      assert.equal(c.run('!!self.__mpNative'), false);
      c.requireModule(path.join(RT, 'bom-shim.js')).self._flutter.loader.didCreateEngineInitializer({
        initializeEngine:async () => ({runApp:async () => {ran=true;}}),
      });
    }},
  });
  assert.equal(ran, true);
  assert.equal(result.shim.nativeFacade, null);
});
test('Douyin may use a default framebuffer without stencil without lying about GL capabilities', () => {
  const c = context();
  const gl = c.canvas.getContext('webgl');
  c.canvas.getContext = () => gl;
  const loader = c.requireModule(path.join(RT, 'canvaskit-loader.js'));
  assert.throws(() => loader.acquireGlContext(c.canvas), /stencil/);
  assert.equal(loader.acquireGlContext(c.canvas, {requireStencil:false}), gl);
  assert.equal(gl.getContextAttributes().stencil, false);
  assert.equal(gl.getParameter(gl.STENCIL_BITS), 0);
});
test('Douyin request maps only binary dataType and preserves request task and receiver', () => {
  const c = context();
  const task = {abort() {}};
  c.wx.request = function (options) {
    assert.equal(this, c.wx);
    assert.equal(options.dataType, 'string');
    assert.equal(options.responseType, 'arraybuffer');
    assert.equal(Object.keys(options.header).some(k => k.toLowerCase() === 'content-length'), false);
    assert.equal(options.header['X-Count'], '12');
    return task;
  };
  const options = {url:'https://example.com', responseType:'arraybuffer', dataType:'arraybuffer', header:{'Content-Length':0,'X-Count':12}};
  const host = c.requireModule(path.join(RT, 'host.js')).getHost('douyin');
  assert.equal(host.api.request(options), task);
  assert.equal(options.dataType, 'arraybuffer');
  assert.equal(options.header['Content-Length'], 0);
  assert.equal(options.header['X-Count'], 12);
});
for (const synchronous of [false, true]) {
  test('Douyin WASM failure rejects boot loader even if initializer stays pending: sync=' + synchronous, {timeout:1000}, async () => {
    const c = context();
    c.sandbox.TTWebAssembly.instantiate = () => {
      if (synchronous) throw new Error('broken wasm');
      return Promise.reject(new Error('broken wasm'));
    };
    const loader = c.requireModule(path.join(RT, 'canvaskit-loader.js'));
    await assert.rejects(loader.loadCanvasKit({canvas:c.canvas,wasmPath:'/broken.wasm.br',
      canvasKitInit(options) {options.instantiateWasm({}, () => {});return new Promise(() => {});}
    }), /broken.wasm.br.*broken wasm/);
  });
}
