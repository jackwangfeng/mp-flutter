import 'dart:convert';

import 'config.dart' show kLocationScopePrivateInfos;

class ProjectFiles {
  /// 相对产物根目录的路径 → 文件内容
  final Map<String, String> textFiles;
  const ProjectFiles(this.textFiles);
}

/// 分包占位页(相对分包 root)。
///
/// 微信要求每个分包至少声明一个页面,`subPackages[n].pages` 为空数组会在
/// 开发者工具编译期报错。分包里除了产物没有别的页面,放一个不渲染任何
/// 内容的占位页,仅用来让分包在 app.json 里合法存在。
const kPlaceholderPage = 'p/p';

/// 微信对同一个包内页面的预下载总额限制(按分包源码大小累计)。
const kPreloadQuotaBytes = 2048 * 1024;

/// --perf-hud(默认关):左上角的可开关小浮层,只显示 fps 与帧均耗时——
/// 详细字段(gl/decode/长任务/[mp-boot] 阶段)都走 console.log,浮层只是给
/// 真机调试时"扫一眼有没有掉帧"用,不需要塞满屏幕。`pointer-events:none`
/// (见下面 wxss)决定了它不能靠点击切换;开发者工具/真机调试控制台里可以经
/// `getCurrentPages()[0].mpPerf.setVisible(false)` 切换(见 `perf-hud.js`)。
const _perfHudOverlayWxml = '''
<text wx:if="{{mpPerf.visible}}" class="mp-perf-hud">FPS {{mpPerf.fps}} · {{mpPerf.avg}}ms</text>
''';

/// 浮层必须 `pointer-events: none`——不能挡住底下 canvas 的触摸事件
/// (列表滚动/手势),这也是它不能靠"点击"切换开关的原因。
const _perfHudOverlayWxss = '''
.mp-perf-hud { position: fixed; left: 8px; top: 8px; z-index: 999; pointer-events: none;
               font-size: 10px; line-height: 1.4; color: #0f0; background: rgba(0,0,0,0.55);
               padding: 2px 6px; border-radius: 4px; }
''';

/// App.onLaunch 里越早记时间戳越准——`--perf-hud` 打开时这是 app.js 里第一行
/// 执行的代码(见 `pipeline.dart` `buildHostPageJs` 的注释:承载页 onLoad 读
/// `getApp().__mpBootT0` 作为冷启动计时器的 t0)。
const _perfHudOnLaunch = '''
  onLaunch() { this.__mpBootT0 = Date.now(); },
''';

/// 按顺序贪心挑出能放进预下载额度的分包。
///
/// 超出额度的分包不预下载,由启动器 require.async 就位探针显式拉取——
/// 预下载只是提速,不是正确性前提。
List<String> selectPreloadPackages(
  List<String> orderedRoots,
  Map<String, int> packageBytes, {
  int quotaBytes = kPreloadQuotaBytes,
}) {
  final out = <String>[];
  var used = 0;
  for (final r in orderedRoots) {
    final size = packageBytes[r] ?? 0;
    if (used + size <= quotaBytes) {
      out.add(r);
      used += size;
    }
  }
  return out;
}

/// app.json preloadRule 的候选顺序(`preload` 策略,见 config.dart kPreloadModes),
/// 交给 [selectPreloadPackages] 按额度贪心挑。
///
/// preloadRule 在进入入口页时才触发,和 boot 的 require.async 几乎同时发出,
/// 对入口页冷启动没有提前量,只决定谁先抢到带宽:
///   · auto/dart:dart 分包 → 启动资源包 → wasm → 常规合一字体。dart 分包到了还要
///     在 JS 线程上注入(解析约 2MB 源码),先到才能和 wasm 下载重叠;wasm 一到
///     就编译(early_wasm),不必抢在最前;
///   · wasm:0.2.3 的顺序 wasm → 启动资源包 → 常规字体 → dart → 粗体;
///   · none:空,不写 preloadRule。
/// 粗体(首帧后才用)只在 wasm(旧行为)里出现。
List<String> preloadOrder(
  String mode, {
  required List<String> dartPackages,
  required List<String> bootAssetPackages,
  required String wasmPackage,
  String? cjkPackage,
  String? cjkBoldPackage,
}) {
  switch (mode) {
    case 'none':
      return const [];
    case 'wasm':
      return [
        wasmPackage,
        ...bootAssetPackages,
        if (cjkPackage != null) cjkPackage,
        ...dartPackages,
        if (cjkBoldPackage != null) cjkBoldPackage,
      ];
    case 'auto':
    case 'dart':
      return [
        ...dartPackages,
        ...bootAssetPackages,
        wasmPackage,
        if (cjkPackage != null) cjkPackage,
      ];
    default:
      throw ArgumentError.value(mode, 'mode', '只能是 auto / dart / wasm / none');
  }
}

/// `splash_color` 缺省值。
const kDefaultSplashColor = '#ffffff';

/// 校验并规范化 `splash_color`:只接受 `#rgb` / `#rrggbb`,返回小写 `#rrggbb`。
/// 不合法抛 [FormatException]。
String normalizeSplashColor(String color) {
  final c = color.trim().toLowerCase();
  final short = RegExp(r'^#([0-9a-f])([0-9a-f])([0-9a-f])$').firstMatch(c);
  if (short != null) {
    return '#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}';
  }
  if (RegExp(r'^#[0-9a-f]{6}$').hasMatch(c)) return c;
  throw FormatException('splash_color 必须是 #rgb 或 #rrggbb 形式的颜色,实际是:$color');
}

/// 启动界面前景色:按背景亮度取深色或浅色,保证应用名与进度条看得清。
String splashForeground(String bg) {
  final v = int.parse(normalizeSplashColor(bg).substring(1), radix: 16);
  final r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#333333' : '#f2f2f2';
}

String _xmlEscape(String s) => s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('{{', '{ {');

/// 原生启动界面(首帧提交前显示,见 pipeline.dart `buildHostPageJs` 的
/// `mpBootStage`):应用名 + 细进度条;启动失败时进度条换成错误文案。
String _splashWxml(String title) =>
    '''
<view wx:if="{{mpSplash.visible}}" class="mp-splash">
  <text class="mp-splash-title">${_xmlEscape(title)}</text>
  <view wx:if="{{!mpSplash.error}}" class="mp-splash-track"><view class="mp-splash-bar" style="width:{{mpSplash.progress}}%"></view></view>
  <text wx:if="{{mpSplash.error}}" class="mp-splash-error" user-select="{{true}}">启动失败:{{mpSplash.error}}</text>
</view>
''';

String _splashWxss(String bg) {
  final fg = splashForeground(bg);
  final track = fg == '#333333'
      ? 'rgba(0, 0, 0, 0.12)'
      : 'rgba(255, 255, 255, 0.2)';
  return '''
/* 原生启动界面:盖在(还是黑的)画布上,首帧提交后移除 */
.mp-splash { position: fixed; left: 0; top: 0; right: 0; bottom: 0; z-index: 50; background: $bg;
             display: flex; flex-direction: column; align-items: center; justify-content: center; }
.mp-splash-title { color: $fg; font-size: 18px; font-weight: 500; margin-bottom: 20px; padding: 0 32px; text-align: center; }
.mp-splash-track { width: 40%; height: 2px; border-radius: 1px; background: $track; overflow: hidden; }
.mp-splash-bar { height: 100%; background: $fg; transition: width 0.3s; }
.mp-splash-error { color: #d93025; font-size: 13px; line-height: 1.5; padding: 0 24px; text-align: center; word-break: break-all; }
''';
}

/// [splashTitle]/[splashColor]:原生启动界面的应用名与背景色;应用名同时写进
/// app.json 的 `window.navigationBarTitleText`(自定义导航栏下页面上不显示,
/// 但微信在最近使用/多任务等处会用到)。
///
/// [ignoreDirs]:产物目录里不属于小程序代码包的目录(如远端字体的待上传目录
/// `mp-fonts-remote/`),写进 project.config.json 的 `packOptions.ignore`,
/// 预览/上传时不打包。
///
/// [privateInfos]:要写进 `requiredPrivateInfos` 的用户隐私接口名(取值集合见
/// `config.dart` 的 `kAllowedPrivateInfos`;去重/合法性校验由调用方——CLI 合并
/// `mp_flutter.yaml` 的 `private_infos` 与 `--private-info` 时——负责,这里假定
/// 已经是合法值)。[requireLocation] 是历史开关,保留向后兼容:单独传
/// `requireLocation: true` 时效果等价于 `privateInfos: ['getLocation']`,与
/// [privateInfos] 合并去重。
/// [initialRenderingCache](冷启动,`initial_rendering_cache`):承载页 json 写
/// `"initialRenderingCache": "static"`。第二次及以后冷启动时,视图层直接用上次
/// 缓存的"初始 data 渲染出的 WXML"先上屏,不等逻辑层(主包 JS 注入、onLoad)。
/// 兼容性(官方文档「初始渲染缓存」):只缓存 view/text/button/image/scroll-view/
/// rich-text,其余组件在缓存里不显示——我们初始 data 下可见的只有原生启动界面
/// (`mpSplash.visible: true`,view + text),canvas 在缓存里不显示正好被启动界面
/// 盖住;输入框/原生组件/伴生层初始都是 wx:if 假或空列表。只缓存初始 data,不含
/// setData 结果;仅 WebView 渲染(我们没开 Skyline);基础库 2.11.1+(libVersion 3.15.0)。
///
/// [lazyCodeLoading](`lazy_code_loading`):app.json 写
/// `"lazyCodeLoading": "requiredComponents"`,只注入当前页面用到的代码。我们只有
/// 一个真页面、没有自定义组件,运行时 JS 都经承载页 require/require.async 按需
/// 执行;各分包的占位页 p/p 从不访问,本来就不该注入。收益很小,但无害。
ProjectFiles emitProject({
  required String appId,
  required List<String> subPackageRoots,
  required String entryPagePath,
  List<String>? preloadRoots,
  bool requireLocation = false,
  List<String> privateInfos = const [],
  bool perfHud = false,
  bool inputTiming = false,
  String splashTitle = '',
  String splashColor = kDefaultSplashColor,
  List<String> ignoreDirs = const [],
  bool initialRenderingCache = false,
  bool lazyCodeLoading = false,
}) {
  final enc = const JsonEncoder.withIndent('  ');
  final preload = preloadRoots ?? subPackageRoots;
  final splashBg = normalizeSplashColor(splashColor);

  // --require-location 向后兼容:等价于给 privateInfos 追加一个 getLocation
  // (已存在时不重复添加)。
  final resolvedPrivateInfos = <String>[];
  for (final v in privateInfos) {
    if (!resolvedPrivateInfos.contains(v)) resolvedPrivateInfos.add(v);
  }
  if (requireLocation && !resolvedPrivateInfos.contains('getLocation')) {
    resolvedPrivateInfos.add('getLocation');
  }
  final needsLocationScope = resolvedPrivateInfos.any(
    kLocationScopePrivateInfos.contains,
  );

  final appJson = enc.convert({
    'pages': [entryPagePath],
    'subPackages': [
      for (final root in subPackageRoots)
        {
          'root': root,
          'pages': [kPlaceholderPage],
        },
    ],
    if (preload.isNotEmpty)
      'preloadRule': {
        entryPagePath: {'network': 'all', 'packages': preload},
      },
    'window': {
      'navigationStyle': 'custom',
      'backgroundColor': '#000000',
      if (splashTitle.isNotEmpty) 'navigationBarTitleText': splashTitle,
    },
    'sitemapLocation': 'sitemap.json',
    if (lazyCodeLoading) 'lazyCodeLoading': 'requiredComponents',
    // 用户隐私相关接口需要显式声明用途才能调用(wx.getLocation/chooseLocation
    // 等);默认不声明(不需要这些能力的 App 不应背上对应的隐私弹窗)。
    if (resolvedPrivateInfos.isNotEmpty)
      'requiredPrivateInfos': resolvedPrivateInfos,
    // 定位类接口(getLocation/getFuzzyLocation/chooseLocation/... ,不含地址簿
    // 性质的 chooseAddress)还需要 permission.scope.userLocation 的权限说明。
    if (needsLocationScope)
      'permission': {
        'scope.userLocation': {'desc': '用于展示附近门店与配送范围'},
      },
  });

  // ★ es6/enhance 必须关:开发者工具上传/预览时会对 JS 再做一遍 ES6→ES5 /
  //   增强编译,约 2MB 的 dart 分片会膨胀到 4MB+,超过单分包 2048KB 上限
  //   (真实电商小程序真机预览实测:pkg-dart-0 4326KB 被拒;关掉后 2045457 字节通过)。
  //   我们的产物不需要它:canvaskit.js 已由 esbuild 降级到 es2017,dart2js
  //   产物本身即可直接运行。构建期体积校验看的是未经工具转换的大小,
  //   所以这两项一旦打开,校验就失真。
  //   `minified: true` 会对 dart2js 产物再压一遍,**未经真机验证**,不要开。
  final projectConfig = enc.convert({
    'description': 'Generated by mp_flutter. Do not edit by hand.',
    'appid': appId,
    'projectname': 'mp_flutter_app',
    'compileType': 'miniprogram',
    'libVersion': '3.15.0',
    'setting': {
      'urlCheck': false,
      'es6': false,
      'enhance': false,
      'postcss': false,
      'minified': false,
      'minifyWXML': false,
      'ignoreUploadUnusedFiles': false,
    },
    if (ignoreDirs.isNotEmpty)
      'packOptions': {
        'ignore': [
          for (final d in ignoreDirs) {'type': 'folder', 'value': d},
        ],
      },
  });

  // 承载页:整屏一块 WebGL 画布。
  final wxml =
      '''
<canvas type="webgl" id="flutter-canvas" class="flutter-canvas" disable-scroll="true"
        bindtouchstart="onMpTouch" bindtouchmove="onMpTouch"
        bindtouchend="onMpTouch" bindtouchcancel="onMpTouch"></canvas>
<block wx:for="{{mpNativeList}}" wx:for-item="mpNid" wx:key="*this">
  <view wx:if="{{mpNative[mpNid]}}" class="mp-native-clip" hidden="{{mpNative[mpNid].hidden}}"
        style="left:{{mpNative[mpNid].clip ? mpNative[mpNid].clip.left : mpNative[mpNid].left}}px;
               top:{{mpNative[mpNid].clip ? mpNative[mpNid].clip.top : mpNative[mpNid].top}}px;
               width:{{mpNative[mpNid].clip ? mpNative[mpNid].clip.width : mpNative[mpNid].width}}px;
               height:{{mpNative[mpNid].clip ? mpNative[mpNid].clip.height : mpNative[mpNid].height}}px;
               border-radius:{{mpNative[mpNid].clip ? mpNative[mpNid].clip.radius : 0}}px;
               opacity:{{mpNative[mpNid].opacity}}">
    <video wx:if="{{mpNative[mpNid].type === 'video'}}" id="mpv-{{mpNid}}" class="mp-native-item"
           data-mpid="{{mpNid}}"
           style="left:{{mpNative[mpNid].left - (mpNative[mpNid].clip ? mpNative[mpNid].clip.left : mpNative[mpNid].left)}}px;
                  top:{{mpNative[mpNid].top - (mpNative[mpNid].clip ? mpNative[mpNid].clip.top : mpNative[mpNid].top)}}px;
                  width:{{mpNative[mpNid].width}}px; height:{{mpNative[mpNid].height}}px;"
           src="{{mpNative[mpNid].params.src}}" controls="{{mpNative[mpNid].params.controls}}"
           autoplay="{{mpNative[mpNid].params.autoplay}}" loop="{{mpNative[mpNid].params.loop}}"
           muted="{{mpNative[mpNid].params.muted}}" object-fit="{{mpNative[mpNid].params.objectFit}}"
           poster="{{mpNative[mpNid].params.poster}}"
           bindplay="onMpNativeEvent" bindpause="onMpNativeEvent" bindended="onMpNativeEvent"
           bindtimeupdate="onMpNativeEvent" binderror="onMpNativeEvent"
           bindfullscreenchange="onMpNativeEvent"></video>
    <map wx:if="{{mpNative[mpNid].type === 'map'}}" id="mpm-{{mpNid}}" class="mp-native-item"
         data-mpid="{{mpNid}}"
         style="left:{{mpNative[mpNid].left - (mpNative[mpNid].clip ? mpNative[mpNid].clip.left : mpNative[mpNid].left)}}px;
                top:{{mpNative[mpNid].top - (mpNative[mpNid].clip ? mpNative[mpNid].clip.top : mpNative[mpNid].top)}}px;
                width:{{mpNative[mpNid].width}}px; height:{{mpNative[mpNid].height}}px;"
         latitude="{{mpNative[mpNid].params.latitude}}" longitude="{{mpNative[mpNid].params.longitude}}"
         scale="{{mpNative[mpNid].params.scale}}" markers="{{mpNative[mpNid].params.markers}}"
         show-location="{{mpNative[mpNid].params.showLocation}}"
         bindtap="onMpNativeEvent" bindmarkertap="onMpNativeEvent"
         bindregionchange="onMpNativeEvent"></map>
    <camera wx:if="{{mpNative[mpNid].type === 'camera'}}" class="mp-native-item"
            data-mpid="{{mpNid}}"
            style="left:{{mpNative[mpNid].left - (mpNative[mpNid].clip ? mpNative[mpNid].clip.left : mpNative[mpNid].left)}}px;
                   top:{{mpNative[mpNid].top - (mpNative[mpNid].clip ? mpNative[mpNid].clip.top : mpNative[mpNid].top)}}px;
                   width:{{mpNative[mpNid].width}}px; height:{{mpNative[mpNid].height}}px;"
            device-position="{{mpNative[mpNid].params.devicePosition}}"
            flash="{{mpNative[mpNid].params.flash}}"
            binderror="onMpNativeEvent" bindstop="onMpNativeEvent"></camera>
  </view>
</block>
<block wx:for="{{mpSemantics}}" wx:for-item="mps" wx:key="id">
  <text class="mp-semantics-mirror"
        style="left:{{mps.left}}px; top:{{mps.top}}px; width:{{mps.width}}px; height:{{mps.height}}px;">{{mps.label}}</text>
</block>
${perfHud ? _perfHudOverlayWxml : ''}${_splashWxml(splashTitle)}<input wx:if="{{mpInput.visible && !mpInput.multiline}}" class="mp-input"
       style="left:{{mpInput.left}}px;top:{{mpInput.top}}px;width:{{mpInput.width}}px;height:{{mpInput.height}}px;font-size:{{mpInput.fontSize}}px"
       value="{{mpInput.value}}" cursor="{{mpInput.cursor}}" focus="{{mpInput.focus}}" cursor-color="#00000000"
       type="{{mpInput.type}}" password="{{mpInput.password}}" confirm-type="{{mpInput.confirmType}}"
       adjust-position="{{true}}" hold-keyboard="{{true}}"
       data-session="{{mpInput.session}}" bindinput="onMpInput" bindconfirm="onMpConfirm" bindblur="onMpBlur"${inputTiming ? ' bindfocus="onMpFocus"' : ''} />
<textarea wx:if="{{mpInput.visible && mpInput.multiline}}" class="mp-input"
       style="left:{{mpInput.left}}px;top:{{mpInput.top}}px;width:{{mpInput.width}}px;height:{{mpInput.height}}px;font-size:{{mpInput.fontSize}}px"
       value="{{mpInput.value}}" cursor="{{mpInput.cursor}}" focus="{{mpInput.focus}}" cursor-color="#00000000"
       adjust-position="{{true}}" hold-keyboard="{{true}}" disable-default-padding="{{true}}"
       data-session="{{mpInput.session}}" bindinput="onMpInput" bindblur="onMpBlur"${inputTiming ? ' bindfocus="onMpFocus"' : ''} />
''';

  final wxss = '''
page { width: 100%; height: 100%; background: #000; }
.flutter-canvas { width: 100vw; height: 100vh; display: block; }
/* 原生组件(video/map/camera)的同层叠加容器:按 native-views.js 算出的裁剪
   矩形定位,overflow 裁掉滚出可见区的部分;圆角走 border-radius(仅
   ClipRRect 等半径裁剪才有意义,普通矩形裁剪 radius 为 0)。原生组件本身
   永远浮在所有 WXML/canvas 内容之上,这里的 z-index 只用于同层内多个原生
   组件之间的层叠顺序,不影响与 canvas 的相对关系(探针文档已确认的限制:
   原生组件不能被 Flutter 内容盖住)。 */
.mp-native-clip { position: fixed; overflow: hidden; z-index: 5; }
.mp-native-item { position: absolute; }
/* 原生输入框只负责接收键盘与输入法:透明、无边框,文字与光标由 Flutter 渲染。
   原生光标要藏两层(否则 iOS 上出现第二根光标,微信默认绿色,位置还和 Flutter
   画的对不上):WXSS 的 caret-color 管 WebView 渲染的输入框(开发者工具、未进入
   原生态时);聚焦后真机由原生控件接管,只认组件属性 cursor-color(基础库
   3.1.0+,iOS 取十六进制色值,这里给全透明 #00000000;安卓只认 default/green,
   设不了透明——安卓默认把原生框放到屏幕外,见 text-bridge.js 与 android_input)。textarea 文档未列 cursor-color,同样带上,不认识时忽略。 */
.mp-input { position: fixed; z-index: 10; background: transparent; color: transparent;
            caret-color: transparent !important; border: none; padding: 0; margin: 0; }
/* WXML 伴生层(可选,--semantics-mirror,默认关,Phase 5 Task 4):只服务微信
   的页面内容索引/无障碍能力,视觉上必须完全隐形、不可交互。 */
.mp-semantics-mirror { position: fixed; opacity: 0; pointer-events: none; overflow: hidden; }
${perfHud ? _perfHudOverlayWxss : ''}${_splashWxss(splashBg)}''';

  // 未捕获错误必须可见。静默失败在小程序里的表现就是一块黑画布,极难倒查。
  final appJs =
      '''
App({
${perfHud ? _perfHudOnLaunch : ''}  onError(msg) { console.error('[mp-flutter] uncaught: ' + msg); },
  onUnhandledRejection(res) {
    const e = res && res.reason;
    // message 与 stack 都要打:只有 message 时定位不到是哪段 dart2js 代码出的错
    console.error('[mp-flutter] unhandled rejection: ' + ((e && e.message) || e) +
        (e && e.stack ? '\\n' + String(e.stack).split('\\n').slice(0, 12).join('\\n') : ''));
  },
});
''';

  return ProjectFiles({
    'app.json': appJson,
    'app.js': appJs,
    'app.wxss': 'page { margin: 0; padding: 0; }\n',
    'project.config.json': projectConfig,
    'sitemap.json': enc.convert({
      'rules': [
        {'action': 'allow', 'page': '*'},
      ],
    }),
    '$entryPagePath.wxml': wxml,
    '$entryPagePath.wxss': wxss,
    '$entryPagePath.json': enc.convert({
      'usingComponents': <String, String>{},
      if (initialRenderingCache) 'initialRenderingCache': 'static',
    }),
    for (final root in subPackageRoots) ...{
      '$root/$kPlaceholderPage.js': 'Page({});\n',
      '$root/$kPlaceholderPage.wxml': '<view/>\n',
      '$root/$kPlaceholderPage.json': '{"usingComponents":{}}\n',
    },
  });
}
