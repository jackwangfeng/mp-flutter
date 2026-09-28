'use strict';
const { loadCanvasKit, routeImageElements } = require('./canvaskit-loader.js');
const { createNet, makeFetch } = require('./net.js');

/**
 * 在小程序里启动 Flutter Web engine。
 *
 * 顺序是有讲究的:
 *   1. 先起 CanvasKit —— 此时还没装 BOM 垫片,让 emscripten 走
 *      `typeof window === "undefined"` 的无浏览器分支,少一堆无谓的探测
 *   2. 再装 BOM 垫片
 *   3. 把 CanvasKit 挂到 window/self 的 flutterCanvasKit —— 引擎读到就不再下载
 *   4. 布好 _flutter 握手位,再加载 main.dart.js
 *
 * 在这之前先并行拉齐**首帧前必需**的分包(main.dart.js 各分片、wasm、启动
 * 资源包 pkg-assets-boot:FontManifest/AssetManifest/清单里声明的字体/Roboto/
 * 常用汉字合一字体)。启动资源包列在 deferredSubPackages 里:不挡 CanvasKit
 * 初始化与 Dart 分片执行,initializeEngine 之前才等齐。
 * 其余资源分包(NOTICES、回退字体分片、图片、shader)不在这张表里:引擎
 * fetch 某个资源时,由该资源在加载表里的 require.async 按需下载所在分包。
 *
 * [opts.manifest] 是构建期生成的加载表 `mp-manifest.js`:
 *   { subPackages: { 分包名: () => Promise }, deferredSubPackages: [分包名],
 *     loadDart: () => Promise, assets: { 原始路径: () => Promise<base64> },
 *     remoteFonts?, cjkFont?, cjkFontBold? }
 * 主包不能同步 require 分包 JS,所以 main.dart.js 与资源都经它 require.async。
 *
 * 注意:`./bom-shim.js`、`./canvaskit.js`(经 CanvasKitInit)的 require 下沉到
 * 函数体内。canvaskit.js 是构建期产物,单测环境不存在;顶层 require 会让本
 * 模块在单测环境下连加载都做不到,`matchAsset`/`decodeParts` 就没法单测了。
 */
// 引擎是整个小程序 JS 上下文里的单例:main.dart.js 经 require.async 加载后被
// 模块缓存,承载页重入(reLaunch、从分享卡片再次打开)时不会再执行,引擎握手
// 也就不会再发生。与其让第二次启动无声挂住(黑屏),不如立即给出明确错误。
// 把引擎迁移到新画布属于页面生命周期,Phase 2 处理。
let booted = false;

function boot(opts) {
  if (booted) {
    const err = new Error(
      'Flutter 引擎在本次小程序生命周期内已启动过;承载页重入(reLaunch/重新打开)暂不支持');
    err.code = 'MP_REENTRY';
    return Promise.reject(err);
  }
  booted = true;
  const bom = require('./bom-shim.js');
  const CanvasKitInit = require('./canvaskit.js');
  const { createCrypto } = require('./crypto.js');

  // --perf-hud(默认关)冷启动阶段计时:opts.onStage 只由承载页在 `--perf-hud`
  // 打开时才传入(见 pipeline.dart `buildHostPageJs`/`perf-hud.js`
  // `createBootTimer`)。boot() 本身对它一无所知——只在下面几个阶段边界调用
  // 一次,不计时、不格式化,单纯"到点了通知一声"。这几处调用总共只发生在
  // 应用整个生命周期的一次启动过程里(不是每帧/每次渲染都走的热路径),
  // `onStage` 为 null 时每处都只有一次函数类型判断,--perf-hud 关闭时开销
  // 可忽略不计。
  const onStage = typeof opts.onStage === 'function' ? opts.onStage : null;
  // --perf-hud(默认关):首帧前的诊断行(常用汉字合一字体的 fetch/解析耗时)。
  // 稳态的 perf-hud 在 boot 之后才装,看不到首帧前的这些事。
  const perfLog = typeof opts.perfLog === 'function' ? opts.perfLog : null;

  // crypto.getRandomValues(K4)播种(I1 修复,2026-09-28 终审):与分包/CanvasKit
  // 加载并行发起,而不是等到那条链子全部跑完、只剩 loadDart 前才开始——一次
  // wx.getRandomValues 往返被"藏"进分包/CanvasKit 加载本就要花的时间里,不再
  // 额外拖慢首屏。crypto.js 内部给这次播种套了 4s 超时,永不回调也不会让下面
  // await 它的地方永久卡住(见 crypto.js createCrypto 文档)。
  const cryptoPromise = createCrypto({ wx: wx });
  // 播种完成即报"crypto"阶段——独立挂一条 .then,不影响下面 cryptoApi 的主链路
  // (播种失败/超时 createCrypto 解出 null 而不是 reject,这条 onRejected 只是
  // 保险,理论上不会走到)。
  if (onStage) cryptoPromise.then(function () { onStage('crypto'); }, function () { onStage('crypto'); });

  const canvas = opts.canvas;
  const wasmPath = opts.wasmPath || '/pkg-wasm/canvaskit.wasm.br';
  const manifest = opts.manifest;
  const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2);
  // ★ bom.install({width,height}) 的 width/height 要喂给 shim.window.innerWidth
  // /innerHeight —— 引擎(Flutter Web)按浏览器语义把它当 CSS 像素的逻辑视口,
  // 自己再乘 devicePixelRatio 换算物理尺寸。传物理像素进去会让引擎把逻辑尺寸
  // 算大了 dpr 倍(Task 4 E2E『逻辑尺寸与屏幕一致』验收实测抓到:iPhone 15
  // dpr=3 时报出 1170x2532,即物理像素原样冒充了逻辑像素)。
  // ★ 修复轮 1 Minor 4:优先用承载页直接透传的 wx.getWindowInfo() CSS 像素
  // (opts.cssWidth/cssHeight)。canvas.width/height 是承载页按物理像素设的
  // (devicePixelRatio 倍数),反过来除 dpr 只是近似值——安卓小数
  // devicePixelRatio(如 2.75)会有取整误差,与触摸桥拿到的 info.windowWidth
  // 不一致(引擎逻辑尺寸与触摸坐标换算用两个不同的近似宽度)。只有承载页没
  // 传时(理论上不会发生,防御性兜底)才退回 canvas.width / dpr 的旧算法。
  const width = opts.cssWidth != null ? opts.cssWidth : canvas.width / dpr;
  const height = opts.cssHeight != null ? opts.cssHeight : canvas.height / dpr;

  // 启动资源包(FontManifest、清单字体、常用汉字合一字体……)只有引擎初始化
  // (initializeEngine 里取字体)才用得到:不挡 CanvasKit 初始化与 Dart 分片执行,
  // 与它们并行下载,initializeEngine 之前再等齐。其余分包(dart 分片、wasm)
  // 照旧先到齐。
  // 常用汉字合一字体:boot 一开始就拉分包、读文件(见 cjk-font.js),与 wasm
  // 编译、Dart 分片加载并行;引擎初始化取字体时只等这个结果。
  const cjkSpec = manifest.cjkFont && typeof manifest.cjkFont.load === 'function' ? manifest.cjkFont : null;
  const cjkBytes = cjkSpec
    ? require('./cjk-font.js').preloadCjkFont(cjkSpec, { wx: wx, perfLog: perfLog })
    : null;
  const boldSpec = cjkSpec && manifest.cjkFontBold && typeof manifest.cjkFontBold.load === 'function'
    ? manifest.cjkFontBold : null;

  const allLoaders = manifest.subPackages || {};
  const deferredNames = (manifest.deferredSubPackages || []).filter(function (n) { return n in allLoaders; });
  const early = {}, late = {};
  Object.keys(allLoaders).forEach(function (n) {
    (deferredNames.indexOf(n) >= 0 ? late : early)[n] = allLoaders[n];
  });
  // 先发 dart/wasm 分包的请求,再发启动资源包的:开发者工具里分包是逐个注入的,
  // 先发先到,资源包的下载/注入落在 CanvasKit 初始化与 Dart 分片执行期间
  const earlyLoaded = loadSubpackages(early, onStage);
  const lateLoaded = loadSubpackages(late, onStage);
  // 合一字体粗体(cjk_font_bold):排在 dart/wasm/启动资源包请求之后再拉,不挤占
  // 关键路径;首帧不等它,晚到就首帧后补注册(见 cjk-font.js createCjkBold)
  const cjkBold = boldSpec
    ? require('./cjk-font.js').createCjkBold(boldSpec, cjkBytes, { wx: wx, perfLog: perfLog })
    : null;
  // 先挂一个空的 catch,免得启动资源包先失败时成为未处理的 rejection;
  // 真正的失败在下面 initializeEngine 之前被 await 出来,走同一条报错路径
  lateLoaded.catch(function () {});
  return earlyLoaded
    .then(function () {
      return loadCanvasKit({ canvas: canvas, wasmPath: wasmPath, canvasKitInit: CanvasKitInit });
    })
    .then(function (CK) {
      // 微信没有细分"读取 wasm 字节/编译/实例化"三个子阶段的 API
      // (WXWebAssembly.instantiate 是一次性完成的黑盒调用,见
      // canvaskit-loader.js `loadCanvasKit` 的 `instantiateWasm`),这里按
      // loadCanvasKit() 整体耗时报一个合并阶段。
      if (onStage) onStage('canvaskit');
      // 同一份字体字节只解析一次(见 typeface-memo.js):引擎每注册一批回退字体
      // 都把迄今全部字体重新 registerFont 一遍,不去重时第 k 批要把前面所有字体
      // 再解析一遍。必须在引擎开始注册字体(initializeEngine)之前装上。
      let memo = null;
      try {
        const { installTypefaceMemo } = require('./typeface-memo.js');
        memo = installTypefaceMemo(CK);
      } catch (e) { /* 去重失败只是退回每次解析,不影响启动 */ }
      // 字节一到就先解析合一字体(TTF 解析很快,不挡别的步骤);引擎随后对同一个
      // ArrayBuffer 的 MakeFreeTypeFaceFromData / registerFont 命中缓存
      const preparse = function (p, label) {
        p.then(function (bytes) {
          if (!bytes) return;
          try {
            const t = Date.now();
            const tf = CK.Typeface.MakeTypefaceFromData(bytes.buffer);
            if (tf && typeof tf.delete === 'function') tf.delete();
            if (perfLog) perfLog('[mp-perf] ' + label + ' parse ' + (Date.now() - t) + 'ms(预解析)');
          } catch (e) { /* 预解析失败不影响引擎自己解析 */ }
        });
      };
      if (cjkBytes && memo) preparse(cjkBytes, 'cjk-font');
      if (cjkBold && memo) preparse(cjkBold.bytes, 'cjk-bold');
      // 首帧提交:包一次 Surface.prototype.flush,第一次调用时报阶段并立即
      // 还原(只报一次,不影响后续每帧真实的 flush 调用)。必须趁 CK 刚拿到、
      // 垫片/引擎都还没开始画之前包上,否则真机上首帧可能已经在这之前画完。
      if (onStage) {
        try {
          const proto = CK.Surface && CK.Surface.prototype;
          if (proto && typeof proto.flush === 'function') {
            const origFlush = proto.flush;
            const firstFrameHook = function () {
              // 只在自己仍是最外层时才还原:boot resolve 之后承载页还可能再包
              // 一层(--verify 像素上报、--perf-hud 帧计时),它们的包装器里调的
              // origFlush 就是本钩子——这时直接赋值会把外层包装冲掉,像素上报
              // 从此停在第一帧。被包住时保留本钩子,之后每帧只多一次比较。
              if (proto.flush === firstFrameHook) proto.flush = origFlush;
              if (!firstFrameHook.done) {
                firstFrameHook.done = true;
                onStage('first-frame');
              }
              return origFlush.apply(this, arguments);
            };
            proto.flush = firstFrameHook;
          }
        } catch (e) { /* 首帧计时失败不应影响启动 */ }
      }
      // opts.platform 仅由 --verify 构建的 --force-platform 传入(E2E 在开发者工具里
      // 覆盖 android 路径);正常构建按真机平台
      const platform = opts.platform ||
        (wx.getDeviceInfo ? wx.getDeviceInfo().platform : 'devtools');
      // opts.simulate 同样只由 --verify --force-platform 传入:在开发者工具(V8)
      // 里模拟真机 JS 引擎缺失的能力('ios' / 'android-noIntl',见 bom-shim.js)
      const shim = bom.install({
        canvas: canvas, width: width, height: height, dpr: dpr, platform: platform, CK: CK,
        simulate: opts.simulate,
        // 静态 JPEG/PNG 走微信原生解码(image.js);opts.nativeImage === false 关闭,
        // 传对象可指定 { mode: 'file' | 'dataurl' }
        nativeImage: opts.nativeImage === false ? null : (opts.nativeImage || {}),
      });
      // 静态图解码:<img>.decode() 已在 wasm 里解好,纹理上传入口改走同一份结果(image.js)
      routeImageElements(CK, shim.images);

      shim.window.flutterCanvasKit = CK;
      shim.self.flutterCanvasKit = CK;

      // 资源、网络、404 共用一个路由:package:http 走 fetch(url, init),
      // 引擎内部取字体等走 fetch(url);XHR(Task 2)也走同一路由
      const preloaded = {};
      if (cjkSpec) {
        preloaded[cjkSpec.key] = function () {
          const t = Date.now();
          return cjkBytes.then(function (bytes) {
            if (perfLog) perfLog('[mp-perf] cjk-font 引擎取用等待 ' + (Date.now() - t) + 'ms' + (bytes ? '' : '(读取失败,404)'));
            return bytes;
          });
        };
      }
      if (cjkBold) {
        preloaded[boldSpec.key] = cjkBold.respond;
        // 晚到的粗体经入口包装补注册(首帧之后 ui.loadFontFromList)
        shim.window.__mpLateFonts = cjkBold.bridge;
        shim.self.__mpLateFonts = cjkBold.bridge;
        shim.cjkBold = { family: boldSpec.family, state: cjkBold.state };
      }
      const net = createNet({ wx: wx, assets: manifest.assets || {}, matchAsset: matchAsset, decodeParts: decodeParts,
        remoteFonts: manifest.remoteFonts || null, preloaded: preloaded });
      shim.typefaceMemo = memo;
      shim.window.fetch = makeFetch(net);
      shim.self.fetch = shim.window.fetch;
      shim.net = net;

      // XMLHttpRequest(Task 2):框架的 NetworkImage(web)与 dio 都走它,
      // 必须在 manifest.loadDart() 之前装好 —— main.dart.js 可能在模块顶层
      // 就缓存了构造器引用。
      const { createXMLHttpRequestClass } = require('./xhr.js');
      const XHR = createXMLHttpRequestClass({ getNet: () => net, Event: shim.window.Event, ProgressEvent: shim.window.ProgressEvent });
      shim.window.XMLHttpRequest = XHR;
      shim.self.XMLHttpRequest = XHR;

      // 微信能力 JS 桥(Task 2 的 package:mp_flutter_wechat 经 self.__mpWechat 调用):
      // 同样必须在 manifest.loadDart() 之前装好——引擎/业务代码可能在模块顶层
      // 就读取该全局。承载页经 r.shim.wechat 访问,供 onShareAppMessage 等钩子使用。
      const { createWechatBridge } = require('./wechat.js');
      const wechat = createWechatBridge({ wx: wx });
      shim.window.__mpWechat = wechat;
      shim.self.__mpWechat = wechat;
      shim.wechat = wechat;

      // 安全区(K1,见 safe-area.js):同样必须在 manifest.loadDart() 之前挂上——
      // 构建期生成的入口包装在首帧前就读 self.__mpSafeArea,首帧即带正确的
      // viewPadding,不会出现"首帧后 padding 才变、布局整体跳一下"。
      const { createSafeArea } = require('./safe-area.js');
      const safeArea = createSafeArea({ wx: wx });
      shim.window.__mpSafeArea = safeArea.bridge;
      shim.self.__mpSafeArea = safeArea.bridge;
      shim.safeArea = safeArea;

      // 原生视图同步层的门面(I1 修复,2026-09-27 终审):真正的
      // createNativeViews() 仍然是承载页 boot 成功之后才创建(需要真实
      // DOM/rAF/setData),但 Dart 侧 `MpNativeView.build()` 只在
      // `_backend.isAvailable`(镜像 `self.__mpNative` 是否存在)为 true 时
      // 才创建 HtmlElementView——桥晚到,build 已经落地成 fallback,以后
      // 不会自己再重新读一次桥是否出现了(没有任何东西触发 rebuild)。同
      // `__mpWechat` 一样,必须在 manifest.loadDart() 之前把 self.__mpNative
      // 装上,Dart 引擎一启动 isAvailable 就已经是 true。这里先挂一个只会
      // 排队的门面(register/unregister/command 都只记账,不做真正的发现/
      // 派发),createNativeViews() 接管时用 shim.nativeFacade.drain() 取走
      // 这批积压并逐条重放(见 native-views.js 里 createNativeFacade 的
      // 文档)。registry_web.dart 的 `_awaitBridge` 作为兜底继续保留,不
      // 依赖这里一定先跑到。
      const { createNativeFacade } = require('./native-views.js');
      const nativeFacade = createNativeFacade();
      shim.window.__mpNative = nativeFacade.bridge;
      shim.self.__mpNative = nativeFacade.bridge;
      shim.nativeFacade = nativeFacade;

      // 原生视图同步层(Phase 5 Task 2,承载页 boot 成功后创建)经 r.shim.wx
      // 调 wx.createVideoContext/createMapContext/createCameraContext——与
      // wechat 桥同样的理由:承载页拿到的是 r.shim,不应该另外要求它记住
      // 全局 wx 是否在当前作用域可见。
      shim.wx = wx;

      let resolveInit;
      const waitInit = new Promise(function (r) { resolveInit = r; });
      const ns = {
        buildConfig: {
          engineRevision: 'mp-flutter',
          builds: [{ compileTarget: 'dart2js', renderer: 'canvaskit', mainJsPath: 'main.dart.js' }],
        },
        loader: { didCreateEngineInitializer: function (i) { resolveInit(i); } },
      };
      shim.self._flutter = ns;
      shim.window._flutter = ns;

      // crypto.getRandomValues(K4):唯一需要异步播种的桥——一次 wx.getRandomValues
      // 往返之后 ChaCha20 DRBG 才能同步产出。必须在 manifest.loadDart() 之前
      // await 完(main.dart.js 顶层可能就初始化 uuid 一类库,进而调用
      // Random.secure() 读 self.crypto)。wx.getRandomValues 不存在、播种失败或
      // 超时(I1,4s)时 createCrypto 解出 null——不装 window/self.crypto,Dart 侧
      // Random.secure() 保持 Unsupported,不伪造安全性(见 crypto.js 文件头注释)。
      // 播种已在 boot() 顶部与分包/CanvasKit 加载并行发起过(cryptoPromise),
      // 这里只 await 结果,不再重新发起。
      return cryptoPromise.then(function (cryptoApi) {
        if (cryptoApi) {
          shim.window.crypto = cryptoApi;
          shim.self.crypto = cryptoApi;
        }
        shim.crypto = cryptoApi || null;
        // preamble 会从 bom-shim 取遮蔽变量,所以必须在 install 之后才加载
        return manifest.loadDart();
      }).then(function (r) {
        // "Dart 各分片加载"完成:main.dart.js 各分片的 require.async 全部
        // resolve(分片已下载并执行完毕,preamble 已跑,但 didCreateEngineInitializer
        // 是否已回调不确定,下面单独等 waitInit)。
        if (onStage) onStage('dart-chunks');
        return r;
      }).then(function () {
        return withTimeout(waitInit, 30000,
          'main.dart.js 已加载,但 30 秒内没有调用 _flutter.loader.didCreateEngineInitializer'
          + '(preamble 或引擎握手不匹配?)');
      }).then(function (init) {
        // "Dart main 开始执行"的代理指标:引擎经 preamble 回调
        // didCreateEngineInitializer 的这一刻,是 JS 侧能观测到的、Dart 生成代码
        // 开始接管执行的最早时间点(真正的 dart:_internal main() 入口更早,但
        // JS 侧无法从外部单独打点)。
        if (onStage) onStage('dart-main');
        return lateLoaded.then(function () { return init; });
      }).then(function (init) {
        return init.initializeEngine({
          useLocalCanvasKit: true, renderer: 'canvaskit', assetBase: '', canvasKitBaseUrl: '',
          // 回退字体(Roboto/Noto)默认从 fonts.gstatic.com 拉,小程序里拉不到;
          // 构建期已打包到 mp-fonts/ 下,经资源 fetch 供给
          fontFallbackBaseUrl: 'mp-fonts/',
          // 渲染器不能随 UA 变:引擎只在 Safari/Firefox(或此开关)下用
          // MultiSurfaceRasterizer,其余(安卓 UA → blink)走 OffscreenCanvasRasterizer,
          // 而垫片里 OffscreenCanvas 是 undefined(小程序没有),真机会首帧黑屏。
          // 强制多画布光栅器,让 iOS/安卓都走已验证的"直接画在承载页画布上"路径。
          canvasKitForceMultiSurfaceRasterizer: true,
          // 探针结论(2026-09-27 platform-view-probe §1/§3):多画布时垫片把所有
          // 逻辑 <canvas> 都映射到唯一的真实 WebGL 画布(bom-shim.js 注释:"所有
          // canvas 元素共用这一个真实节点"),多个 CanvasKit Surface 各自
          // 清屏/刷新同一物理帧缓冲,后刷新的覆盖先刷新的 → 只要出现平台视图
          // (原生组件)就整页黑屏,不止是原生组件区域。限制为单画布后,平台
          // 视图之上的 Flutter 内容画进同一张底层画布,不再分配额外的
          // "overlay" 画布——与 spec 的"原生组件永远在最上层"结论一致。
          canvasKitMaximumSurfaces: 1,
          // 打包的是完整版 CanvasKit(wasm 自带 ICU,见 pipeline.dart _canvasKitDir):
          // 断行在 wasm 里完成,不需要 Intl.Segmenter / Intl.v8BreakIterator。
          // CanvasKit 已经经 flutterCanvasKit 交给引擎,引擎不再下载、也不按这个值
          // 挑文件;写明只是让引擎的配置与实际加载的变体一致。
          canvasKitVariant: 'full',
        });
      }).then(function (app) {
        return app.runApp();
      }).then(function () {
        return { CK: CK, shim: shim };
      });
    });
}

/** 超时即以 [msg] reject——宁可报错,也不要无声地永远等下去(用户只会看到黑屏)。 */
function withTimeout(p, ms, msg) {
  let timer;
  return Promise.race([
    p,
    new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error(msg)); }, ms); }),
  ]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
}

/**
 * 并行确保首帧前必需的分包已下载。preloadRule 只有 2MB 额度,放不下的分包
 * 靠这里拉取;已预下载的分包会直接成功。按需资源分包不经这里。
 *
 * [loaders] 是加载表里的 { 分包名: () => require.async(该包的就位探针) }。
 * 不能用 wx.loadSubpackage —— 那是小游戏 API,小程序里不存在。
 *
 * [onStage](--perf-hud,默认不传):每个分包 require.async 完成时报一次
 * `'subpackage:' + name`,供冷启动阶段日志按分包名逐条打印。
 */
function loadSubpackages(loaders, onStage) {
  return Promise.all(Object.keys(loaders).map(function (name) {
    if (typeof loaders[name] !== 'function') {
      return Promise.reject(new Error('加载表损坏:分包 ' + name + ' 的加载器不是函数'));
    }
    return Promise.resolve().then(loaders[name]).then(function (r) {
      if (onStage) onStage('subpackage:' + name);
      return r;
    }).catch(function (e) {
      throw new Error('分包 ' + name + ' 加载失败: ' + ((e && (e.message || e.errMsg)) || e));
    });
  }));
}

/**
 * 按"最长后缀"匹配资源 key。
 *
 * 不能用 `url.indexOf(key)` 取第一个命中:`assets/AssetManifest.bin` 是
 * `assets/AssetManifest.bin.json` 的子串,引擎请求后者时会拿到前者的内容。
 * 引擎请求的 URL 可能带前缀(assetBase、fontFallbackBaseUrl)或查询串。
 */
function matchAsset(assets, url) {
  let path = url.split('?')[0].split('#')[0];
  // 引擎请求前会 Uri.encodeFull(资源路径):`assets/图片/a b.png` 实际请求
  // `assets/%E5%9B%BE%E7%89%87/a%20b.png`,而加载表 key 是原始路径
  try { path = decodeURI(path); } catch (e) { /* 非法编码按原样匹配 */ }
  let best = null;
  Object.keys(assets).forEach(function (k) {
    const hit = path === k || (path.length > k.length &&
        path.slice(-k.length) === k && path[path.length - k.length - 1] === '/');
    if (hit && (best === null || k.length > best.length)) best = k;
  });
  return best;
}

/**
 * 逐片解码(每片长度对齐 4 字符,可独立解码)并拼接成**本 realm** 的字节。
 *
 * 拼接这一步同时是必要的拷贝:开发者工具 2.02 起,`wx.base64ToArrayBuffer`
 * 返回的是另一个 realm 的 ArrayBuffer(不是 `instanceof ArrayBuffer`,原型链
 * 冻结)。dart2js 第一次遇到 ArrayBuffer 时要往它的原型上写 dispatch 标记,
 * 写冻结原型直接抛 `Cannot define property ___dart_dispatch_record...,
 * object is not extensible`,引擎启动失败。`new Uint8Array(buf)` 仍共享那个
 * 外来 buffer,必须拷进本 realm 新建的数组。
 */
function decodeParts(parts) {
  const chunks = parts.map(function (b64) { return new Uint8Array(wx.base64ToArrayBuffer(b64)); });
  const total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
  const out = new Uint8Array(total);
  let off = 0;
  chunks.forEach(function (c) { out.set(c, off); off += c.length; });
  return out;
}

module.exports = { boot, loadSubpackages, matchAsset, decodeParts };
