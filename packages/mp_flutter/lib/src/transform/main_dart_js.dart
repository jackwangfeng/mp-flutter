import 'canvaskit_js.dart' show TransformFailure;

const _marker = '// [mp-flutter] module-scope global shadowing';

/// 给 main.dart.js 前置一段 preamble,用**模块级 var** 遮蔽浏览器全局。
///
/// 小程序把每个文件包成 CommonJS 模块,模块级变量会屏蔽同名全局标识符。
/// 这比往 globalThis 注入可靠:两种环境下 globalThis 的可写性**相反** ——
/// 模拟器上 window/document/top 只有 getter 写不进,真机 iOS 上六项全部可写。
/// 模块级遮蔽在两种环境下都成立,是唯一可移植的方案。
///
/// `crypto`(K4,2026-09-28 E2E 实测踩到):dart:math 的 `Random.secure()` 里
/// `nextInt()` 编译出的 JS 直接写裸标识符 `crypto.getRandomValues(...)`(不像
/// `self.crypto` 那样限定作用域)——bare 引用只有靠这条模块级遮蔽才能落到
/// bom-shim 装好的对象上,否则解析到宿主环境本就没有的全局 `crypto`,直接
/// `TypeError: Cannot read properties of undefined`。这里读 `__mp.self.crypto`
/// 而不是单独的 `__mp.crypto` 导出——bom-shim 的 `self`/`window` 是 boot.js
/// 播种完成后才被赋值 `.crypto` 属性的同一个对象,require() 求值时(即
/// `manifest.loadDart()` 被调用、boot.js 已 await 完播种之后)读到的必然是
/// 最新值,不需要 bom-shim 另外导出一个字段。
///
/// [shadowRegExp]:仅 `--verify --force-platform android/android-noIntl` 构建为
/// true,额外遮蔽 `RegExp` 为垫片的包装(`__mp.RegExp`),在模拟器里复现安卓
/// 真机不支持 Unicode 属性转义 `\p{…}` 的行为(见 bom-shim.js engineRegExp)。
/// 正常构建不遮蔽,产物里 `RegExp` 仍是引擎原生构造函数。
String injectPreamble(String source, {String shimPath = './bom-shim.js', bool shadowRegExp = false}) {
  if (source.contains(_marker)) {
    throw const TransformFailure(
      'preamble 重复注入',
      'main.dart.js 已包含 mp-flutter preamble。检查构建管线是否重复处理了同一个文件。',
    );
  }
  final preamble = '''
$_marker
var __mp = require('$shimPath');
var window = __mp.window, document = __mp.document, navigator = __mp.navigator,
    self = __mp.self, location = __mp.location, top = window, parent = window,
    crypto = __mp.self.crypto;
${shadowRegExp ? 'var RegExp = __mp.RegExp;\n' : ''}''';
  return preamble + source;
}
