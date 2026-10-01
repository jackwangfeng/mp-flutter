import 'dart:convert';

import 'asset_pipeline.dart';
import 'cjk_font.dart' show kCjkFontFamily;

/// 加载表在产物里的路径(主包根目录)。
const kLoaderManifestPath = 'mp-manifest.js';

/// 每个分包里的就位探针模块(相对分包 root)。
///
/// 小程序没有 `wx.loadSubpackage`(那是小游戏 API,模拟器实测
/// `wx.loadSubpackage is not a function`)。不跳页就把分包拉下来的唯一办法是
/// `require.async` 该包里的某个 JS——pkg-wasm 里只有 .wasm.br 没有 JS,
/// 所以给每个分包放一个空模块专门用来触发下载。
const kReadyModule = 'mp-ready.js';
const kReadyModuleSource =
    '// [mp-flutter] 分包就位探针:require.async 它即可触发本分包下载。\nmodule.exports = true;\n';

/// 生成主包里的加载表 `mp-manifest.js`。
///
/// 为什么需要它:微信**不允许主包同步 require 分包里的 JS**——模拟器实测报
/// `module 'pkg-assets/manifest.js' is not defined`,页面直接起不来。跨分包
/// 只能走 `require.async`。
///
/// 为什么每条都写成字面量路径而不是运行时拼接:开发者工具靠静态分析决定
/// 哪些文件属于哪个包、哪些是"未使用文件";`require.async('./' + x)` 这种
/// 动态路径分析不到,既可能被当成无用文件剔除,也会让报错指向错误的位置。
/// 这里生成的是一张查找表,每个条目都是一个返回 Promise 的函数;资源条目
/// resolve 为 base64 字符串数组(未切片的资源数组长度为 1)。
///
/// [dartModulePaths] 是 `main.dart.js` 各分片的产物路径,**必须串行加载**:
/// 后一片从共享作用域读取前一片导出的名字;
/// [subPackages] 是**首帧前**要确保就位的分包(dart 分片、wasm、启动资源包),
/// boot 会并行加载它们的就位探针;其余资源分包不在这里,由各资源条目自己的
/// require.async 在引擎真正 fetch 时按需下载(微信分包是整包下载的,提前
/// 探针一次就等于把整包拉进首帧前的关键路径)。
///
/// [remoteFontBaseUrl]/[remoteFonts](`font_base_url`):不进包、运行时从 CDN
/// 拉取并缓存到本地文件的回退字体分片,key 与资源条目同形(`mp-fonts/...`)。
///
/// [cjkFont](`cjk_font`):常用汉字合一字体——引擎请求的资源 key、所在分包、
/// 分包里的 brotli 文件。boot 一开始就 require.async 该分包的就位探针,就位后
/// 用 readCompressedFile 读出字节,引擎请求 key 时直接应答。
///
/// [cjkFontBold](`cjk_font_bold`):合一字体的粗体,字段同 [cjkFont]。boot 在
/// dart/wasm 分包请求发出之后才开始读;引擎取用时没到就按 404 应答,到了再补注册。
///
/// [deferredSubPackages]:[subPackages] 里不必挡在 CanvasKit 初始化前的分包
/// (启动资源包,引擎初始化取字体时才用),boot 让它们与 CanvasKit/Dart 并行
/// 下载,initializeEngine 之前等齐。
///
/// [wasmSubPackage](冷启动 `early_wasm`):[subPackages] 里装 CanvasKit wasm 的
/// 分包。boot 看到它就把这个分包单独拆出来,一到就编译 CanvasKit,不等 dart
/// 分包;不写(或关掉 early_wasm)时 boot 等全部首帧前分包就位再编译。
///
/// 主包里的资源(`boot_assets` 并进主包时)不经分包门控,直接 require.async。
String buildLoaderManifest({
  required List<String> dartModulePaths,
  required List<String> subPackages,
  required AssetBundle assets,
  String? remoteFontBaseUrl,
  List<String> remoteFonts = const [],
  ({String asset, String package, String file})? cjkFont,
  ({String asset, String package, String file})? cjkFontBold,
  List<String> deferredSubPackages = const [],
  String? wasmSubPackage,
}) {
  final b = StringBuffer()
    ..writeln('// [mp-flutter] 加载表(构建期生成,勿手改)。')
    ..writeln('// 主包不能同步 require 分包 JS,跨包加载一律走 require.async,且路径必须是字面量。')
    ..writeln('function dartChunkFailed(label) {')
    ..writeln('  return function (e) {')
    ..writeln(
      '    throw new Error(label + "加载/执行失败: " + ((e && (e.message || e.errMsg)) || e));',
    )
    ..writeln('  };')
    ..writeln('}')
    // 按需分包单飞:同一个未下载的分包同一时刻只发一次 require.async。
    // 依据基础库源码(开发者工具 3.17.3 WASubContext.js 的 require.async):模块
    // 所在分包没加载时,每次调用都各自走一次原生 appLoadSubpackage,JS 侧不去重;
    // 一批回退字体同时 fetch 时同一分包会被并发请求十几次。安卓真机上这类请求
    // 里后到的几个恰好等 1001–1003ms 才回来(疑似原生层对重复加载的 1s 轮询)。
    // 这里让第一个请求去触发下载,同包其余请求等它落地后再 require.async
    // (包已就位,基础库直接 setTimeout 0 返回)。失败不缓存,下次重新发起。
    ..writeln('var pkgGate = {};')
    ..writeln('function inPkg(roots, load) {')
    ..writeln('  var waits = [];')
    ..writeln(
      '  for (var i = 0; i < roots.length; i++) if (pkgGate[roots[i]]) waits.push(pkgGate[roots[i]]);',
    )
    ..writeln('  var p = Promise.all(waits).then(load);')
    ..writeln('  var gate = p.then(function () {}, function () {});')
    ..writeln('  var mine = [];')
    ..writeln(
      '  for (var j = 0; j < roots.length; j++) if (!pkgGate[roots[j]]) { pkgGate[roots[j]] = gate; mine.push(roots[j]); }',
    )
    ..writeln(
      '  p.catch(function () { mine.forEach(function (r) { if (pkgGate[r] === gate) delete pkgGate[r]; }); });',
    )
    ..writeln('  return p;')
    ..writeln('}')
    ..writeln('module.exports = {')
    ..writeln('  subPackages: {');
  for (final root in subPackages) {
    b.writeln(
      '    ${jsonEncode(root)}: '
      'function () { return require.async(${_lit('$root/$kReadyModule')}); },',
    );
  }
  b.writeln('  },');
  if (wasmSubPackage != null) {
    b.writeln('  wasmSubPackage: ${jsonEncode(wasmSubPackage)},');
  }
  if (deferredSubPackages.isNotEmpty) {
    b.writeln('  deferredSubPackages: ${jsonEncode(deferredSubPackages)},');
  }
  // 每片单独 .catch 并点名(第几片、路径),风格与 boot.js 的 loadSubpackages 一致;
  // 否则分片缺失/执行抛错时只看到一句笼统的 require.async 失败,无从定位。
  // 错误只在出错那一片包一次:后续 .then 被跳过,不会重复包装。
  final n = dartModulePaths.length;
  String load(int i) {
    final path = dartModulePaths[i];
    final label = jsonEncode('main.dart.js 分片 ${i + 1}/$n(./$path)');
    return 'require.async(${_lit(path)}).catch(dartChunkFailed($label))';
  }

  final chain = StringBuffer(load(0));
  for (var i = 1; i < n; i++) {
    chain.write('.then(function () { return ${load(i)}; })');
  }
  b.writeln('  loadDart: function () { return $chain; },');
  b.writeln('  assets: {');
  // 一个资源一条;切了片的资源并行加载各分片,按序返回 base64 字符串数组
  final byAsset = <String, List<AssetModule>>{};
  for (final m in assets.modules) {
    (byAsset[m.originalPath] ??= []).add(m);
  }
  final bootRoots = subPackages.toSet();
  byAsset.forEach((path, chunks) {
    chunks.sort((a, b) => a.chunkIndex.compareTo(b.chunkIndex));
    final loads = chunks
        .map((c) => 'require.async(${_lit(c.modulePath)})')
        .join(', ');
    final lazy = {
      for (final c in chunks)
        if (!bootRoots.contains(c.package) && c.package != 'main') c.package,
    }.toList()..sort();
    final body = 'Promise.all([$loads])';
    b.writeln(
      lazy.isEmpty
          ? '    ${jsonEncode(path)}: function () { return $body; },'
          : '    ${jsonEncode(path)}: function () { return inPkg(${jsonEncode(lazy)}, function () { return $body; }); },',
    );
  });
  b.writeln('  },');
  void font(String name, ({String asset, String package, String file}) f) {
    b
      ..writeln('  $name: {')
      ..writeln('    key: ${jsonEncode(f.asset)},')
      ..writeln('    family: ${jsonEncode(kCjkFontFamily)},')
      ..writeln('    file: ${jsonEncode('/${f.package}/${f.file}')},')
      ..writeln(
        '    load: function () { return require.async(${_lit('${f.package}/$kReadyModule')}); },',
      )
      ..writeln('  },');
  }

  if (cjkFont != null) font('cjkFont', cjkFont);
  if (cjkFont != null && cjkFontBold != null) font('cjkFontBold', cjkFontBold);
  if (remoteFontBaseUrl != null && remoteFonts.isNotEmpty) {
    b
      ..writeln('  remoteFonts: {')
      ..writeln('    baseUrl: ${jsonEncode(remoteFontBaseUrl)},')
      ..writeln('    files: {');
    for (final k in remoteFonts) {
      b.writeln('      ${jsonEncode(k)}: 1,');
    }
    b
      ..writeln('    },')
      ..writeln('  },');
  }
  b.writeln('};');
  return b.toString();
}

/// 相对加载表所在目录(产物根)的模块路径字面量。
String _lit(String modulePath) => jsonEncode('./$modulePath');
