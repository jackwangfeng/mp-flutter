const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');

const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

// 打桩 canvaskit.js(构建期产物)与 CanvasKit 加载,驱动 boot() 走到 initializeEngine,
// 捕获引擎配置与垫片装好后的 UA
async function runBoot(bootOpts, deviceInfo, windowInfo) {
  const c = createMpContext();
  if (deviceInfo) c.wx.getDeviceInfo = () => deviceInfo;
  if (windowInfo) c.wx.getWindowInfo = () => windowInfo;
  c.stubModule(path.join(RT, 'canvaskit.js'), function () {});
  const CK = { fake: 'CK', MakeLazyImageFromTextureSource: () => 'orig' };
  c.stubModule(path.join(RT, 'canvaskit-loader.js'), {
    loadCanvasKit: () => Promise.resolve(CK),
    // 路由函数用真实实现(纯函数,不依赖构建期产物)
    routeImageElements: require(path.join(RT, 'canvaskit-loader.js')).routeImageElements,
  });
  const { boot } = c.requireModule(path.join(RT, 'boot.js'));
  let config = null;
  // 记录 manifest.loadDart() 被调用的那一刻(main.dart.js 加载之前)微信桥是否
  // 已经装在全局 self 上——boot.js 的顺序要求是"先装桥,再 loadDart",因为
  // main.dart.js/业务代码可能在模块顶层就读取 self.__mpWechat。
  let wechatBeforeLoadDart;
  let safeAreaBeforeLoadDart;
  const manifest = {
    subPackages: {},
    assets: {},
    loadDart: () => {
      wechatBeforeLoadDart = c.run('typeof self !== "undefined" && self.__mpWechat != null');
      safeAreaBeforeLoadDart = c.run('typeof self !== "undefined" && self.__mpSafeArea != null ? JSON.stringify([self.__mpSafeArea.top, self.__mpSafeArea.bottom]) : null');
      c.requireModule(path.join(RT, 'bom-shim.js')).self._flutter.loader.didCreateEngineInitializer({
        initializeEngine(cfg) { config = cfg; return Promise.resolve({ runApp() { return Promise.resolve(); } }); },
      });
      return Promise.resolve();
    },
  };
  const r = await boot(Object.assign({ canvas: c.canvas, manifest, cssWidth: 390, cssHeight: 844 }, bootOpts));
  return { config, ua: r.shim.window.navigator.userAgent, CK, shim: r.shim, wechatBeforeLoadDart, safeAreaBeforeLoadDart };
}

test('initializeEngine 强制多画布光栅器(渲染器不随 UA 走 OffscreenCanvas),且限定单画布(平台视图黑屏修复)', async () => {
  const { config } = await runBoot({});
  assert.strictEqual(config.canvasKitForceMultiSurfaceRasterizer, true);
  assert.strictEqual(config.canvasKitMaximumSurfaces, 1);
});

test('initializeEngine 声明 canvasKitVariant=full(与打包的完整版 CanvasKit 一致)', async () => {
  const { config } = await runBoot({});
  assert.strictEqual(config.canvasKitVariant, 'full');
});

test('opts.simulate 透传给垫片(--force-platform ios / android-noIntl 用)', async () => {
  const ios = await runBoot({ platform: 'ios', simulate: 'ios' });
  assert.strictEqual(ios.shim.self.Intl.v8BreakIterator, undefined);
  assert.strictEqual(ios.shim.self.Intl.Segmenter, undefined);
  const noIntl = await runBoot({ platform: 'android', simulate: 'android-noIntl' });
  assert.strictEqual(noIntl.shim.self.Intl.NumberFormat, undefined);
  assert.strictEqual(typeof noIntl.shim.self.Intl.Locale, 'function');
});

test('安卓真机也强制多画布光栅器,且限定单画布', async () => {
  const { config, ua } = await runBoot({}, { platform: 'android' });
  assert.match(ua, /Android/);
  assert.strictEqual(config.canvasKitForceMultiSurfaceRasterizer, true);
  assert.strictEqual(config.canvasKitMaximumSurfaces, 1);
});

test('opts.platform 覆盖真机平台(--force-platform 用)', async () => {
  const a = await runBoot({ platform: 'android' }, { platform: 'devtools' });
  assert.match(a.ua, /Android/);
  const i = await runBoot({ platform: 'ios' }, { platform: 'android' });
  assert.match(i.ua, /iPhone/);
});

test('boot 把 CanvasKit 交给垫片,并把 <img> 的纹理上传入口路由到 wasm 解码结果', async () => {
  const { CK, shim } = await runBoot({});
  CK.MakeImageFromEncoded = () => ({ width: () => 2, height: () => 3, delete() {} });
  const w = shim.window;
  const img = w.document.createElement('img');
  img.src = w.URL.createObjectURL(new w.Blob([new Uint8Array([0x89]).buffer]));
  await img.decode();
  assert.strictEqual(img.naturalWidth, 2);
  assert.strictEqual(CK.MakeLazyImageFromTextureSource(img, {}).width(), 2);
  assert.strictEqual(CK.MakeLazyImageFromTextureSource({}, {}), 'orig');
});

test('boot 在 loadDart 之前装好微信桥,shim/window/self 三处一致,承载页经 shim.wechat 访问', async () => {
  const { shim, wechatBeforeLoadDart } = await runBoot({});
  assert.strictEqual(wechatBeforeLoadDart, true, 'manifest.loadDart() 被调用时 self.__mpWechat 应已存在');
  assert.strictEqual(typeof shim.wechat.call, 'function');
  assert.strictEqual(shim.window.__mpWechat, shim.wechat);
  assert.strictEqual(shim.self.__mpWechat, shim.wechat);
});

// I1 修复:门面必须在 loadDart 之前就挂上(与 __mpWechat 同样的时机要求),
// 否则 Dart 侧 isAvailable 在引擎启动那一刻读到的仍然是 false。
test('boot 在 loadDart 之前装好原生视图门面,shim.nativeFacade 可供 createNativeViews 接管', async () => {
  const c = createMpContext();
  c.stubModule(path.join(RT, 'canvaskit.js'), function () {});
  const CK = { fake: 'CK', MakeLazyImageFromTextureSource: () => 'orig' };
  c.stubModule(path.join(RT, 'canvaskit-loader.js'), {
    loadCanvasKit: () => Promise.resolve(CK),
    routeImageElements: require(path.join(RT, 'canvaskit-loader.js')).routeImageElements,
  });
  const { boot } = c.requireModule(path.join(RT, 'boot.js'));
  let nativeBeforeLoadDart;
  const manifest = {
    subPackages: {},
    assets: {},
    loadDart: () => {
      nativeBeforeLoadDart = c.run('typeof self !== "undefined" && self.__mpNative != null');
      c.requireModule(path.join(RT, 'bom-shim.js')).self._flutter.loader.didCreateEngineInitializer({
        initializeEngine() { return Promise.resolve({ runApp() { return Promise.resolve(); } }); },
      });
      return Promise.resolve();
    },
  };
  const r = await boot({ canvas: c.canvas, manifest, cssWidth: 390, cssHeight: 844 });
  assert.strictEqual(nativeBeforeLoadDart, true, 'manifest.loadDart() 被调用时 self.__mpNative(门面)应已存在');
  assert.strictEqual(r.shim.window.__mpNative, r.shim.self.__mpNative, 'shim/window/self 三处一致');
  assert.strictEqual(typeof r.shim.window.__mpNative.register, 'function');
  assert.strictEqual(typeof r.shim.window.__mpNative.command, 'function');
  assert.strictEqual(typeof r.shim.nativeFacade.drain, 'function', 'createNativeViews 接管靠 shim.nativeFacade.drain()');
});

test('K1:loadDart 之前 self.__mpSafeArea 已按 wx.getWindowInfo 的安全区装好(首帧即生效)', async () => {
  const { safeAreaBeforeLoadDart, shim } = await runBoot({}, null, {
    pixelRatio: 3, windowWidth: 390, windowHeight: 844, screenWidth: 390, screenHeight: 844,
    statusBarHeight: 47, safeArea: { top: 47, left: 0, right: 390, bottom: 810, width: 390, height: 763 },
  });
  assert.strictEqual(safeAreaBeforeLoadDart, '[47,34]');
  assert.strictEqual(shim.window.__mpSafeArea, shim.self.__mpSafeArea);
});

// K4:crypto.getRandomValues 播种是 boot() 链路里唯一的异步步骤,必须在
// manifest.loadDart() 之前 await 完——main.dart.js/uuid 一类库可能在模块顶层
// 就调用 Random.secure() 读 self.crypto。
//
// 不 await:交给调用方决定何时推进(I1 的 4s 超时测试需要在 await 之前手动
// tick 模拟时钟,否则挂假 setTimeout 之后永远等不到)。返回 { c, promise },
// promise resolve 为 { shim, cryptoBeforeLoadDart }。
function bootWithWxPending(extraWx, loadCanvasKitImpl) {
  const c = createMpContext();
  Object.assign(c.wx, extraWx);
  c.stubModule(path.join(RT, 'canvaskit.js'), function () {});
  const CK = { fake: 'CK', MakeLazyImageFromTextureSource: () => 'orig' };
  c.stubModule(path.join(RT, 'canvaskit-loader.js'), {
    loadCanvasKit: loadCanvasKitImpl || (() => Promise.resolve(CK)),
    routeImageElements: require(path.join(RT, 'canvaskit-loader.js')).routeImageElements,
  });
  const { boot } = c.requireModule(path.join(RT, 'boot.js'));
  let cryptoBeforeLoadDart;
  const manifest = {
    subPackages: {},
    assets: {},
    loadDart: () => {
      cryptoBeforeLoadDart = c.run(
        'typeof self !== "undefined" && self.crypto != null ? typeof self.crypto.getRandomValues : "__absent__"');
      c.requireModule(path.join(RT, 'bom-shim.js')).self._flutter.loader.didCreateEngineInitializer({
        initializeEngine() { return Promise.resolve({ runApp() { return Promise.resolve(); } }); },
      });
      return Promise.resolve();
    },
  };
  const promise = boot({ canvas: c.canvas, manifest, cssWidth: 390, cssHeight: 844 })
    .then((r) => ({ shim: r.shim, cryptoBeforeLoadDart: cryptoBeforeLoadDart }));
  return { c, CK, promise };
}

async function runBootWithWx(extraWx) {
  const { promise } = bootWithWxPending(extraWx);
  return promise;
}

test('K4:wx.getRandomValues 播种成功——loadDart 之前 self.crypto 已就绪,shim/window/self 三处一致', async () => {
  const { shim, cryptoBeforeLoadDart } = await runBootWithWx({
    getRandomValues(opts) {
      const bytes = new Uint8Array(opts.length);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i;
      Promise.resolve().then(() => opts.success({ randomValues: bytes.buffer }));
    },
  });
  assert.strictEqual(cryptoBeforeLoadDart, 'function',
    'manifest.loadDart() 被调用时 self.crypto.getRandomValues 应已存在');
  assert.strictEqual(shim.window.crypto, shim.self.crypto);
  assert.strictEqual(shim.crypto, shim.window.crypto);
  assert.strictEqual(typeof shim.crypto.randomUUID, 'function');
});

test('K4:wx.getRandomValues 不存在——boot 仍会等待播种尝试完成再 loadDart,且不挂 crypto(Dart 侧保持 Unsupported)', async () => {
  const originalWarn = console.warn;
  console.warn = () => {}; // 预期会 warn 一次,压掉测试输出里的噪音
  try {
    const { shim, cryptoBeforeLoadDart } = await runBootWithWx({ getRandomValues: undefined });
    assert.strictEqual(cryptoBeforeLoadDart, '__absent__');
    assert.strictEqual(shim.window.crypto, undefined);
    assert.strictEqual(shim.self.crypto, undefined);
    assert.strictEqual(shim.crypto, null);
  } finally {
    console.warn = originalWarn;
  }
});

// I1(2026-09-28 终审):首次取种子没有超时,wx.getRandomValues 回调永不触发
// 就会让 boot() 永久卡在 await 上、承载页永久黑屏。修法:套 4s 超时,超时按
// 失败处理——返回 null、不挂 crypto、只 warn 一次,照常 loadDart。
test('I1:wx.getRandomValues 永不回调——4s 超时后按失败处理,照常 loadDart 且不挂 crypto', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalWarn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(m);
  try {
    // 永不调用 success/fail:模拟基础库该接口挂死不回调
    const { promise } = bootWithWxPending({ getRandomValues() {} });
    // 4s 到期之前不应该已经完成(否则说明根本没等播种,或超时定得不对)
    let settled = false;
    promise.then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.strictEqual(settled, false, '4s 超时触发之前,boot() 不应该已经完成');

    t.mock.timers.tick(4000);
    const { shim, cryptoBeforeLoadDart } = await promise;

    assert.strictEqual(cryptoBeforeLoadDart, '__absent__', '超时按失败处理,loadDart 时 self.crypto 不应存在');
    assert.strictEqual(shim.window.crypto, undefined);
    assert.strictEqual(shim.self.crypto, undefined);
    assert.strictEqual(shim.crypto, null);
    assert.strictEqual(warned.length, 1, '只 warn 一次');
    assert.match(warned[0], /超时/);
  } finally {
    console.warn = originalWarn;
  }
});

// I1:播种应该在 loadSubpackages/CanvasKit 加载阶段就发起(与它们并行),而不是
// 等它们跑完、只剩 loadDart 前才开始——否则播种耗时会直接叠加到首屏耗时上。
test('I1:crypto 播种与 CanvasKit 加载并行发起,不等 CanvasKit 加载完成才开始', async () => {
  let getRandomValuesCalled = false;
  let resolveCanvasKit;
  const ckGate = new Promise((r) => { resolveCanvasKit = r; });
  const { CK, promise } = bootWithWxPending({
    getRandomValues(opts) {
      getRandomValuesCalled = true;
      const bytes = new Uint8Array(opts.length);
      Promise.resolve().then(() => opts.success({ randomValues: bytes.buffer }));
    },
  }, () => ckGate.then(() => CK));

  // boot() 调用本身是同步的:createCrypto()(进而 wx.getRandomValues)在函数体
  // 顶部同步发起,早于 loadSubpackages().then(loadCanvasKit) 这条链子的任何一步。
  assert.strictEqual(getRandomValuesCalled, true,
    'wx.getRandomValues 应该在 boot() 调用返回时就已经发起,不等 CanvasKit 加载');

  // 此刻 CanvasKit 还卡在 ckGate 上没 resolve,放开它,boot 才能继续往下走
  resolveCanvasKit();
  const { shim, cryptoBeforeLoadDart } = await promise;
  assert.strictEqual(cryptoBeforeLoadDart, 'function', '并行发起的播种结果在 loadDart 之前已经 await 完');
  assert.strictEqual(typeof shim.crypto.randomUUID, 'function');
});

// --perf-hud(默认关)冷启动阶段计时:boot() 只在几个阶段边界调用一次可选的
// opts.onStage(name),不计时、不格式化——计时/格式化是承载页(perf-hud.js
// createBootTimer)的事,这里只验证 boot() 在正确的时间点、以正确的名字调用它。
test('--perf-hud:opts.onStage 未传(默认关)时,boot() 完全不触碰它,行为与不支持该参数一样', async () => {
  // 不传 onStage,只要 boot() 正常跑完不抛错即可——不需要额外断言,
  // 这条测试本身就是"关闭时零影响"的回归:如果 boot.js 哪天误把 onStage 当
  // 必需参数用(比如忘了判空直接调用),这里会先炸。
  const { config } = await runBoot({});
  assert.ok(config);
});

test('--perf-hud:opts.onStage 按正确顺序/名字报各阶段(分包带名字,canvaskit/crypto/dart-chunks/dart-main/first-frame)', async () => {
  const c = createMpContext();
  c.stubModule(path.join(RT, 'canvaskit.js'), function () {});
  function FakeSurface() {}
  FakeSurface.prototype.flush = function () { return 'flushed'; };
  const CK = { fake: 'CK', MakeLazyImageFromTextureSource: () => 'orig', Surface: FakeSurface };
  c.stubModule(path.join(RT, 'canvaskit-loader.js'), {
    loadCanvasKit: () => Promise.resolve(CK),
    routeImageElements: require(path.join(RT, 'canvaskit-loader.js')).routeImageElements,
  });
  const { boot } = c.requireModule(path.join(RT, 'boot.js'));

  const stages = [];
  const manifest = {
    subPackages: {
      'pkg-wasm': () => Promise.resolve(),
      'pkg-dart-0': () => Promise.resolve(),
    },
    assets: {},
    loadDart: () => {
      c.requireModule(path.join(RT, 'bom-shim.js')).self._flutter.loader.didCreateEngineInitializer({
        initializeEngine() { return Promise.resolve({ runApp() { return Promise.resolve(); } }); },
      });
      return Promise.resolve();
    },
  };

  const r = await boot({
    canvas: c.canvas, manifest, cssWidth: 390, cssHeight: 844,
    onStage: (stage) => stages.push(stage),
  });

  // 分包按名字各报一次(并行加载,顺序不保证,只要求两个都出现且在 canvaskit 之前)
  assert.ok(stages.includes('subpackage:pkg-wasm'));
  assert.ok(stages.includes('subpackage:pkg-dart-0'));
  const idxWasm = stages.indexOf('subpackage:pkg-wasm');
  const idxCanvaskit = stages.indexOf('canvaskit');
  assert.ok(idxWasm < idxCanvaskit, '分包阶段应该先于 canvaskit 阶段');
  assert.ok(stages.includes('crypto'));
  // 严格顺序的部分:canvaskit → dart-chunks → dart-main(此时还没有任何一次
  // 真正的 flush 发生——假 runApp() 不画东西——所以 first-frame 还不应该出现)。
  const tail = stages.filter((s) => ['canvaskit', 'dart-chunks', 'dart-main'].includes(s));
  assert.deepStrictEqual(tail, ['canvaskit', 'dart-chunks', 'dart-main']);
  assert.ok(!stages.includes('first-frame'), 'boot() resolve 时还没真正 flush 过,不应该报 first-frame');

  // 第一次真正的 flush(引擎第一帧提交)才报 first-frame,且只报这一次;
  // 之后每帧正常的 flush 不应该再触发(钩子在第一次调用后立即还原)。
  r.CK.Surface.prototype.flush();
  assert.deepStrictEqual(stages.filter((s) => s === 'first-frame'), ['first-frame']);
  const countAfterSecond = stages.filter((s) => s === 'first-frame').length;
  r.CK.Surface.prototype.flush();
  assert.strictEqual(stages.filter((s) => s === 'first-frame').length, countAfterSecond,
    '第二次 flush 不应该再新增 first-frame');
});

test('首帧钩子:boot 之后外层再包 flush(--verify 像素上报),第一帧不能把外层包装冲掉', async () => {
  const c = createMpContext();
  c.stubModule(path.join(RT, 'canvaskit.js'), function () {});
  function FakeSurface() {}
  let real = 0;
  FakeSurface.prototype.flush = function () { real++; return 'flushed'; };
  const CK = { fake: 'CK', MakeLazyImageFromTextureSource: () => 'orig', Surface: FakeSurface };
  c.stubModule(path.join(RT, 'canvaskit-loader.js'), {
    loadCanvasKit: () => Promise.resolve(CK),
    routeImageElements: require(path.join(RT, 'canvaskit-loader.js')).routeImageElements,
  });
  const { boot } = c.requireModule(path.join(RT, 'boot.js'));
  const stages = [];
  const manifest = {
    subPackages: {}, assets: {},
    loadDart: () => {
      c.requireModule(path.join(RT, 'bom-shim.js')).self._flutter.loader.didCreateEngineInitializer({
        initializeEngine() { return Promise.resolve({ runApp() { return Promise.resolve(); } }); },
      });
      return Promise.resolve();
    },
  };
  const r = await boot({ canvas: c.canvas, manifest, cssWidth: 390, cssHeight: 844, onStage: (s) => stages.push(s) });
  // 承载页 --verify 的做法:boot resolve 后再包一层
  const proto = r.CK.Surface.prototype;
  const inner = proto.flush;
  let outer = 0;
  proto.flush = function () { outer++; return inner.apply(this, arguments); };
  for (let i = 0; i < 3; i++) new FakeSurface().flush();
  assert.strictEqual(outer, 3, '外层包装必须每帧都被调用');
  assert.strictEqual(real, 3);
  assert.deepStrictEqual(stages.filter((s) => s === 'first-frame'), ['first-frame']);
});

test('合一字体:boot 一开始就读(早于 CanvasKit),引擎取用时直接应答同一个 buffer,预解析后引擎解析全部命中', async () => {
  const c = createMpContext();
  c.stubModule(path.join(RT, 'canvaskit.js'), function () {});
  const events = [];
  let parses = 0;
  const make = (data) => { parses++; const h = { clone: () => h, delete() {}, isDeleted: () => false }; return h; };
  const CK = { Typeface: { MakeTypefaceFromData: make, MakeFreeTypeFaceFromData: make } };
  c.stubModule(path.join(RT, 'canvaskit-loader.js'), {
    loadCanvasKit: () => { events.push('canvaskit'); return new Promise((r) => setTimeout(() => r(CK), 10)); },
    routeImageElements: require(path.join(RT, 'canvaskit-loader.js')).routeImageElements,
  });
  const FONT = Buffer.from([0, 1, 0, 0, 9, 9, 9, 9]);
  c.wx.getFileSystemManager = () => ({
    readCompressedFile(o) {
      events.push('read ' + o.filePath + ' ' + o.compressionAlgorithm);
      setTimeout(() => o.success({ data: Uint8Array.from(FONT).buffer }), 1);
    },
  });
  const { boot } = c.requireModule(path.join(RT, 'boot.js'));
  const lines = [];
  const key = 'assets/mp-cjk/NotoSansSC.ttf';
  const manifest = {
    subPackages: {}, assets: {},
    cjkFont: { key, file: '/pkg-cjk/mp-cjk.ttf.br', load: () => { events.push('load pkg-cjk'); return Promise.resolve(); } },
    loadDart: () => {
      const self = c.requireModule(path.join(RT, 'bom-shim.js')).self;
      return self.fetch(key).then((r) => { assert.strictEqual(r.status, 200); return r.arrayBuffer(); }).then((buf) => {
        CK.Typeface.MakeFreeTypeFaceFromData(buf);                 // loadAssetFonts
        CK.Typeface.MakeTypefaceFromData(new Uint8Array(buf));     // registerFont
        assert.deepStrictEqual(Array.from(new Uint8Array(buf)), Array.from(FONT));
        self._flutter.loader.didCreateEngineInitializer({
          initializeEngine() { return Promise.resolve({ runApp() { return Promise.resolve(); } }); },
        });
      });
    },
  };
  const r = await boot({ canvas: c.canvas, manifest, cssWidth: 390, cssHeight: 844, perfLog: (l) => lines.push(l) });
  assert.deepStrictEqual(events.slice(0, 2), ['load pkg-cjk', 'canvaskit']);
  assert.ok(events.includes('read /pkg-cjk/mp-cjk.ttf.br br'));
  assert.strictEqual(parses, 1, '预解析一次,引擎的两次都命中');
  assert.strictEqual(r.shim.typefaceMemo.stats.hits, 2);
  for (const re of [/^\[mp-perf\] cjk-font pkg \d+ms$/, /^\[mp-perf\] cjk-font read \d+ms via readCompressedFile bytes=8$/,
    /^\[mp-perf\] cjk-font parse \d+ms\(预解析\)$/, /^\[mp-perf\] cjk-font 引擎取用等待 \d+ms$/]) {
    assert.ok(lines.some((l) => re.test(l)), re + '\n' + lines.join('\n'));
  }
});

test('合一字体粗体:排在 dart/wasm 分包请求之后读;不晚于常规就随清单应答,晚到则 404 + self.__mpLateFonts 补交', async () => {
  for (const boldDelay of [1, 40]) {
    const c = createMpContext();
    c.stubModule(path.join(RT, 'canvaskit.js'), function () {});
    const events = [];
    const make = () => { const h = { clone: () => h, delete() {}, isDeleted: () => false }; return h; };
    const CK = { Typeface: { MakeTypefaceFromData: make, MakeFreeTypeFaceFromData: make } };
    c.stubModule(path.join(RT, 'canvaskit-loader.js'), {
      loadCanvasKit: () => new Promise((r) => setTimeout(() => r(CK), 10)),
      routeImageElements: require(path.join(RT, 'canvaskit-loader.js')).routeImageElements,
    });
    c.wx.getFileSystemManager = () => ({
      readCompressedFile(o) {
        const bold = o.filePath.indexOf('cjkb') >= 0;
        setTimeout(() => o.success({ data: new Uint8Array(bold ? [7, 7] : [1]).buffer }), bold ? boldDelay : 1);
      },
    });
    const { boot } = c.requireModule(path.join(RT, 'boot.js'));
    const statuses = {};
    const lines = [];
    const manifest = {
      subPackages: { 'pkg-dart-0': () => { events.push('load pkg-dart-0'); return Promise.resolve(); } }, assets: {},
      cjkFont: { key: 'assets/mp-cjk/NotoSansSC.ttf', family: 'MpNotoSansSC', file: '/pkg-cjk/mp-cjk.ttf.br',
        load: () => { events.push('load pkg-cjk'); return Promise.resolve(); } },
      cjkFontBold: { key: 'assets/mp-cjk/NotoSansSC-Bold.ttf', family: 'MpNotoSansSC', file: '/pkg-cjkb/mp-cjk-bold.ttf.br',
        load: () => { events.push('load pkg-cjkb'); return Promise.resolve(); } },
      loadDart: () => {
        const self = c.requireModule(path.join(RT, 'bom-shim.js')).self;
        return Promise.all(['assets/mp-cjk/NotoSansSC.ttf', 'assets/mp-cjk/NotoSansSC-Bold.ttf'].map((k) =>
          self.fetch(k).then((r) => { statuses[k.endsWith('Bold.ttf') ? 'Bold.ttf' : 'SC.ttf'] = r.status; }))).then(() => {
          self._flutter.loader.didCreateEngineInitializer({
            initializeEngine() { return Promise.resolve({ runApp() { return Promise.resolve(); } }); },
          });
        });
      },
    };
    const r = await boot({ canvas: c.canvas, manifest, cssWidth: 390, cssHeight: 844, perfLog: (l) => lines.push(l) });
    assert.deepStrictEqual(events, ['load pkg-cjk', 'load pkg-dart-0', 'load pkg-cjkb']);
    const bridge = r.shim.self.__mpLateFonts;
    assert.ok(bridge && typeof bridge.listen === 'function');
    assert.strictEqual(r.shim.cjkBold.family, 'MpNotoSansSC');
    const got = [];
    bridge.listen((b, fam) => got.push([Array.from(b), fam]));
    await new Promise((res) => setTimeout(res, 60));
    if (boldDelay === 1) {
      assert.deepStrictEqual(statuses, { 'SC.ttf': 200, 'Bold.ttf': 200 });
      assert.strictEqual(r.shim.cjkBold.state.status, 'served');
      assert.deepStrictEqual(got, []);
    } else {
      assert.deepStrictEqual(statuses, { 'SC.ttf': 200, 'Bold.ttf': 404 });
      assert.deepStrictEqual(got, [[[7, 7], 'MpNotoSansSC']]);
      assert.strictEqual(r.shim.cjkBold.state.status, 'late-loaded');
    }
  }
});

test('合一字体读取失败:引擎拿到 404,照常启动', async () => {
  const c = createMpContext();
  c.stubModule(path.join(RT, 'canvaskit.js'), function () {});
  c.stubModule(path.join(RT, 'canvaskit-loader.js'), {
    loadCanvasKit: () => Promise.resolve({}),
    routeImageElements: require(path.join(RT, 'canvaskit-loader.js')).routeImageElements,
  });
  c.wx.getFileSystemManager = () => ({ readCompressedFile(o) { o.fail({ errMsg: 'readCompressedFile:fail permission denied' }); } });
  const { boot } = c.requireModule(path.join(RT, 'boot.js'));
  let status;
  const manifest = {
    subPackages: {}, assets: {},
    cjkFont: { key: 'assets/mp-cjk/NotoSansSC.ttf', file: '/pkg-cjk/mp-cjk.ttf.br', load: () => Promise.resolve() },
    loadDart: () => {
      const self = c.requireModule(path.join(RT, 'bom-shim.js')).self;
      return self.fetch('assets/mp-cjk/NotoSansSC.ttf').then((r) => {
        status = r.status;
        self._flutter.loader.didCreateEngineInitializer({
          initializeEngine() { return Promise.resolve({ runApp() { return Promise.resolve(); } }); },
        });
      });
    },
  };
  await boot({ canvas: c.canvas, manifest, cssWidth: 390, cssHeight: 844 });
  assert.strictEqual(status, 404);
});

function bootWithPackages(c, subPackages, deferred, events) {
  c.stubModule(path.join(RT, 'canvaskit.js'), function () {});
  c.stubModule(path.join(RT, 'canvaskit-loader.js'), {
    loadCanvasKit: () => { events.push('canvaskit'); return Promise.resolve({}); },
    routeImageElements: require(path.join(RT, 'canvaskit-loader.js')).routeImageElements,
  });
  const { boot } = c.requireModule(path.join(RT, 'boot.js'));
  const manifest = {
    subPackages, deferredSubPackages: deferred, assets: {},
    loadDart: () => {
      events.push('loadDart');
      c.requireModule(path.join(RT, 'bom-shim.js')).self._flutter.loader.didCreateEngineInitializer({
        initializeEngine() { events.push('initializeEngine'); return Promise.resolve({ runApp() { return Promise.resolve(); } }); },
      });
      return Promise.resolve();
    },
  };
  return boot({ canvas: c.canvas, manifest, cssWidth: 390, cssHeight: 844 });
}

test('启动资源包(deferredSubPackages)不挡 CanvasKit/Dart,initializeEngine 之前等齐', async () => {
  const c = createMpContext();
  const events = [];
  let releaseAssets;
  const assetsGate = new Promise((r) => { releaseAssets = r; });
  const p = bootWithPackages(c, {
    'pkg-dart-0': () => { events.push('dart-pkg'); return Promise.resolve(); },
    'pkg-assets-boot': () => assetsGate.then(() => events.push('assets-pkg')),
  }, ['pkg-assets-boot'], events);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(events, ['dart-pkg', 'canvaskit', 'loadDart']);
  releaseAssets();
  await p;
  assert.deepStrictEqual(events, ['dart-pkg', 'canvaskit', 'loadDart', 'assets-pkg', 'initializeEngine']);
});

test('启动资源包加载失败:boot 以点名分包的错误失败,不调 initializeEngine', async () => {
  const c = createMpContext();
  const events = [];
  await assert.rejects(bootWithPackages(c, {
    'pkg-assets-boot': () => Promise.reject(new Error('net down')),
  }, ['pkg-assets-boot'], events), /分包 pkg-assets-boot 加载失败: net down/);
  assert.ok(events.indexOf('initializeEngine') < 0);
});
