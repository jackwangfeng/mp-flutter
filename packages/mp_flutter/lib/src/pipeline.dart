import 'dart:convert';
import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:yaml/yaml.dart';

import 'asset_pipeline.dart';
import 'cjk_font.dart';
import 'emit_project.dart';
import 'entrypoint.dart';

import 'esbuild_resolver.dart';
import 'flutter_build.dart';
import 'fonts.dart';
import 'loader_manifest.dart';
import 'package_root.dart';
import 'size_check.dart';
import 'toolchain.dart';
import 'transform/canvaskit_js.dart';
import 'transform/canvaskit_wasm.dart';
import 'transform/font_fallback.dart';
import 'transform/main_dart_js.dart';
import 'transform/split_main_dart_js.dart';
import 'version_matrix.dart';


export 'toolchain.dart' show ToolchainMissing;

/// main.dart.js 单个分片的默认预算(上限 2048KB 的 85%)。
const kDartChunkBudgetBytes = kPackageLimitBytes * 85 ~/ 100;

const _entryPage = 'pages/flutter/flutter';

/// `main.dart.js` 分片后所在分包的前缀,分片依次落进 `pkg-dart-0..N`。
///
/// 不能留在主包:默认 counter demo 的 main.dart.js 就有 1818KB,主包
/// (上限 2048KB)只剩几十 KB 余量,真实 App 必然放不下;真实 App 甚至可能
/// 单个分包(2048KB)也放不下,所以要分片到多个分包。进分包后主包只剩
/// 运行时与 canvaskit.js(约 200KB)。
const _dartPackagePrefix = 'pkg-dart-';
const _wasmPackage = 'pkg-wasm';

/// 打包哪个 CanvasKit 变体:`flutter build web` 产物里的 `canvaskit/`(完整版,
/// wasm 内嵌 ICU),不是 `canvaskit/chromium/`(不带 ICU)。
///
/// chromium 版把断字/断词/换行交给 JS 侧的 `Intl.Segmenter` 与 V8 独有的
/// `Intl.v8BreakIterator`:iOS 小程序(JavaScriptCore)没有后者,首次排版即
/// 白屏;部分安卓微信的 JS 引擎连 Intl 都没有。完整版不依赖任何 Intl API,
/// iOS/安卓/模拟器统一用它,只打这一个变体。体积与瘦身见 transform/canvaskit_wasm.dart。
const _canvasKitDir = 'canvaskit';

/// 跑一整条管线:`flutter build web` → 变换 → 分包 → 体积校验 → 落盘。
///
/// 失败路径全部通过异常向上抛(`UnsupportedFlutterVersion` /
/// `FlutterBuildFailure` / `TransformFailure` / `StateError`),由调用方
/// (CLI)决定退出码,这里不做任何"降级尝试凑合过"的处理。
Future<SizeReport> runPipeline({
  required String projectPath,
  required String outputPath,
  required String appId,
  String? flutterBin,
  String? esbuildPath,
  bool profile = false,
  bool verify = false,
  int? dartChunkBudgetBytes,
  String? forcePlatform,
  bool requireLocation = false,
  List<String> privateInfos = const [],
  bool semanticsMirror = false,
  bool perfHud = false,
  List<String> dartDefines = const [],
  String? dartDefineFromFile,
  bool safeArea = true,
  String? target,
  bool licenses = true,
  String? cjkFont = 'full',
  String? cjkFontBold,
  String? fontBaseUrl,
  String? splashTitle,
  String? splashColor,
}) async {
  // 参数错误在构建前暴露,不白等一次 flutter build
  buildHostPageJs(verify: verify, forcePlatform: forcePlatform, semanticsMirror: semanticsMirror, perfHud: perfHud);
  final remoteBase = fontBaseUrl == null ? null : normalizeFontBaseUrl(fontBaseUrl);
  final splashBg = normalizeSplashColor(splashColor ?? kDefaultSplashColor);
  final bin = resolveFlutterBin(flutterBin, projectPath: projectPath);

  // 1. 版本校验 —— 不匹配直接失败,绝不静默尝试
  final version = FlutterVersion.parse(await readFlutterVersion(bin));
  VersionMatrix.check(version);
  stdout.writeln(
      'Flutter ${version.version}${version.isOhosFork ? ' (ohos fork)' : ''}');

  // 2. 预检外部工具链(brotli / Node / esbuild)。都不是 Dart/Flutter 生态
  //    自带的工具,很多机器第一次跑就会缺——放在 `flutter build web` 之前
  //    检查,不然用户要白等一次构建才发现缺工具,且原本这几处失败会抛未捕获
  //    的 ProcessException(原始 Dart 栈 + 退出码 255),现在统一成
  //    ToolchainMissing,由 CLI 给出针对性安装指引和专属退出码。
  //    顺序(M8):先 Node 再 esbuild——esbuild 解析失败时的报错(退出码 6)
  //    应该已经确认过 Node 本身没问题,不然用户会先去纠结 esbuild、其实缺的
  //    是 Node(`main.dart.js` 分片器 `tools/dart-split` 依赖 Node 运行)。
  checkBrotliAvailable();
  checkNodeAvailable();
  final esbuildBin = await resolveEsbuild(override: esbuildPath);
  if (esbuildBin == 'esbuild') {
    // 只在"从 PATH 解析"(见 resolveEsbuild 文档第 3 步)时检查版本:自动
    // 安装/显式指定的路径要么钉死版本、要么是用户自己的选择,不需要提醒。
    await warnIfEsbuildVersionMismatch(esbuildBin);
  }
  final splitTool = await resolveDartSplitTool();

  // 3. 调 flutter build web。入口换成构建期生成的包装(K1:注入小程序安全区,
  //    见 entrypoint.dart);工程形状不符合时退回 [target](缺省
  //    `lib/main.dart`),只是安全区不生效。[safeArea] 为 false(I1
  //    `--no-safe-area`)时不生成/不尝试入口包装,直接把 [target] 传给
  //    `flutter build web -t`——用于工程自带绑定子类、与入口包装的
  //    `_MpBinding` 冲突(release 下注入悄悄不生效、profile 下启动即崩
  //    "Extension already registered")的场景,业务侧显式选择放弃安全区注入。
  final entryTargetRelPath = target ?? 'lib/main.dart';
  String? buildTarget;
  if (!safeArea) {
    buildTarget = entryTargetRelPath;
  } else {
    try {
      buildTarget = writeEntrypoint(projectPath, targetRelPath: entryTargetRelPath);
    } on EntrypointSkipped catch (e) {
      stderr.writeln('⚠️  跳过安全区入口包装(SafeArea 在小程序里不会避开状态栏):${e.reason}');
      buildTarget = entryTargetRelPath;
    }
  }
  final webDir = await runFlutterWebBuild(
      projectPath: projectPath,
      flutterBin: bin,
      profile: profile,
      dartDefines: dartDefines,
      dartDefineFromFile: dartDefineFromFile,
      target: buildTarget);

  // 分片依赖"顶层名不被重新绑定",而 dart2js 的延迟加载会在
  // initializeDeferredHunk 里改写顶层变量 x;两者不能同时用。
  final deferredParts = webDir.listSync().whereType<File>()
      .where((f) => p.basename(f.path).startsWith('main.dart.js_')).toList();
  if (deferredParts.isNotEmpty) {
    throw TransformFailure('main.dart.js 分片',
        '检测到 dart2js 延迟加载产物(${p.basename(deferredParts.first.path)} 等),'
        '目前不支持与分片同时使用。请去掉 `deferred as` 导入。');
  }

  final out = Directory(outputPath);
  if (out.existsSync()) out.deleteSync(recursive: true);
  out.createSync(recursive: true);

  final entries = <PackageEntry>[];
  void emitText(String relPath, String content, String package) {
    final f = File(p.join(outputPath, relPath))..createSync(recursive: true);
    f.writeAsStringSync(content);
    // 微信按源码字节数计包体积。必须用 utf8.encode:
    // String.length 是 UTF-16 code unit 数,含中文的文件会把体积算少约 30%。
    entries.add(PackageEntry(
        path: relPath, sourceBytes: utf8.encode(content).length, package: package));
  }

  void emitBytes(String relPath, List<int> bytes, String package) {
    final f = File(p.join(outputPath, relPath))..createSync(recursive: true);
    f.writeAsBytesSync(bytes);
    entries.add(PackageEntry(path: relPath, sourceBytes: bytes.length, package: package));
  }

  // 3. canvaskit.js 变换:先 ESM→CJS + 摘 Safari workaround,再降级到 es2017。
  //    顺序固定不能换:摘 workaround 的正则匹配的是原始结构,esbuild 重写过
  //    的代码结构不同,反过来做会让那条正则徒增失配风险
  //    (transform/canvaskit_js.dart 顶部文档已明确要求这个顺序)。
  //
  //    降级这一步不能省:上游 canvaskit.js 含 ES2021+ 写法(`||=`/`&&=`/
  //    `??=`/`?.`/`??`),微信上传校验器认不出这些语法会直接拒绝整个文件,
  //    `project.config.json` 里的 `es6:true` 只是让开发者工具本地预览时凑合,
  //    不能替代这一步(emit_project.dart 的注释也这么写)。
  final ckJs = File(p.join(webDir.path, _canvasKitDir, 'canvaskit.js'));
  final ckPatched = transformCanvasKitJs(ckJs.readAsStringSync());
  final ckDowngraded = await downgradeToEs2017(
    ckPatched,
    esbuildPath: esbuildBin,
  );
  emitText('canvaskit.js', ckDowngraded, 'main');

  // 4. main.dart.js 分片后放进 pkg-dart-0..N;每片注入 preamble(垫片在主包
  //    根目录,分包可以同步 require 主包 JS)。
  // dart 分片预算取上限的 85%:开发者工具界面「预览/真机调试」计的 JS 源码
  // 尺寸比 cli preview 多约 6–8%(真实电商小程序实测同一产物 2045457B → 2166KB),
  // 原因未明(疑似调试注入),留足余量。
  final mainJsRaw = File(p.join(webDir.path, 'main.dart.js')).readAsStringSync();
  // 常用汉字合一字体(cjk_font,默认 full):引擎把它当作 Roboto 之后的第一个
  // 回退字体、缺字检测时算上它(见 transform/font_fallback.dart)
  if (cjkFont != null && !kCjkFontSources.containsKey(cjkFont)) {
    throw ArgumentError.value(cjkFont, 'cjkFont', '只能是 ${kCjkFontSources.keys.join(' / ')}');
  }
  // 粗体(cjk_font_bold):调用方传的是已生效档位(CLI 用 resolveCjkBoldLevel 算好);
  // 这里只防组合不合法(与常规不同档会出豆腐块,见 cjk_font.dart)
  if (cjkFontBold != null) resolveCjkBoldLevel(cjkFont, cjkFontBold);
  final mainJsSource = cjkFont != null ? patchFontFallback(mainJsRaw, family: kCjkFontFamily) : mainJsRaw;
  final preambleProbe = injectPreamble('', shimPath: '../bom-shim.js');
  final chunkBudget = (dartChunkBudgetBytes ?? kDartChunkBudgetBytes) -
      utf8.encode(preambleProbe).length;
  final dartChunks = await splitMainDartJs(mainJsSource,
      budgetBytes: chunkBudget, scopeRequire: '../$kDartScopePath', toolPath: splitTool);
  final dartPackages = <String>[];
  final dartModulePaths = <String>[];
  for (var i = 0; i < dartChunks.length; i++) {
    final pkg = '$_dartPackagePrefix$i';
    dartPackages.add(pkg);
    dartModulePaths.add('$pkg/dart.js');
    emitText('$pkg/dart.js', injectPreamble(dartChunks[i], shimPath: '../bom-shim.js'), pkg);
  }
  emitText(kDartScopePath,
      '// [mp-flutter] Dart 分片共享作用域:各分片经它传递 dart2js 的顶层名。\nmodule.exports = {};\n',
      'main');

  // 5. wasm → 分包(brotli 压缩)。WXWebAssembly.instantiate 能直接加载
  //    brotli 压缩过的 .wasm.br(真机与模拟器均已验证,见 docs/architecture.md)。
  //    完整版 wasm 先清零 ICU 断词词典(否则 brotli 后超出单分包上限,见
  //    transform/canvaskit_wasm.dart),再压缩。
  final wasmTmpDir = Directory.systemTemp.createTempSync('mp_flutter_wasm_');
  final stripped = stripIcuDictionaries(
      File(p.join(webDir.path, _canvasKitDir, 'canvaskit.wasm')).readAsBytesSync());
  final wasm = File(p.join(wasmTmpDir.path, 'canvaskit.wasm'))..writeAsBytesSync(stripped.bytes);
  final brTmp = File(p.join(wasmTmpDir.path, 'canvaskit.wasm.br'));
  final br = Process.runSync('brotli', ['-q', '11', '-f', wasm.path, '-o', brTmp.path]);
  if (br.exitCode != 0) {
    throw StateError('brotli 压缩 canvaskit.wasm 失败:${br.stderr}');
  }
  emitBytes('$_wasmPackage/canvaskit.wasm.br', brTmp.readAsBytesSync(), _wasmPackage);
  wasmTmpDir.deleteSync(recursive: true);

  // 6. 资源 → base64 模块,装箱到 pkg-assets-0..N
  final assetsDir = Directory(p.join(webDir.path, 'assets'));
  final assets = <String, List<int>>{};
  if (assetsDir.existsSync()) {
    for (final f in assetsDir.listSync(recursive: true).whereType<File>()) {
      final rel = p.relative(f.path, from: webDir.path);
      assets[rel] = f.readAsBytesSync();
    }
  }
  // 回退字体(Roboto + 简体中文 Noto)一并打包,路径从 main.dart.js 里抽
  final fontPaths = extractFallbackFontPaths(mainJsSource);
  if (!fontPaths.any((f) => f.startsWith('roboto/'))) {
    // 不能只警告:拉不到 Roboto 引擎启动即崩(Null check),产物构建成功但运行时黑屏
    throw const TransformFailure(
      '回退字体表:main.dart.js 里找不到 Roboto 路径',
      '引擎默认字体 Roboto 缺失时启动即崩(Null check operator used on a null value)。'
      '引擎的字体表写法可能随 Flutter 升级变了,需更新 fonts.dart 的 extractFallbackFontPaths。',
    );
  }
  if (!fontPaths.any((f) => f.startsWith('notosanssc/'))) {
    stderr.writeln('⚠️  main.dart.js 里没找到简体中文回退字体(notosanssc)路径,中文将无法显示。'
        '引擎的字体表写法可能变了,请更新 fonts.dart。');
  }
  assets.addAll(await fetchFallbackFonts(fontPaths));

  // 合一字体经 FontManifest 注册:引擎初始化时(首帧前)取清单里的全部字体并
  // 注册,首帧前注册不发 fontsChange。字体本身不进资源分包,brotli 压缩后放进
  // 独立分包 pkg-cjk,boot 一开始就读(见 cjk_font.dart kCjkFontPackage)。
  // 粗体(cjk_font_bold)同一家族、单独分包 pkg-cjkb:boot 在 dart/wasm 分包请求
  // 发出后才开始读它;引擎取字体时还没到就先按 404 应答(首帧不等它),到了再经
  // 入口包装的 loadFontFromList 补注册(见 runtime/cjk-font.js createCjkBold)。
  if (cjkFont != null) {
    assets['assets/FontManifest.json'] =
        addCjkFontToManifest(assets['assets/FontManifest.json'], bold: cjkFontBold != null);
    final root = await resolvePackageRoot();
    void emitFont(List<int> raw, String package, String file) {
      final tmp = Directory.systemTemp.createTempSync('mp_flutter_cjk_');
      try {
        final src = File(p.join(tmp.path, 'cjk.ttf'))..writeAsBytesSync(raw);
        final dst = File(p.join(tmp.path, 'cjk.ttf.br'));
        final r = Process.runSync('brotli', ['-q', '11', '-f', src.path, '-o', dst.path]);
        if (r.exitCode != 0) throw StateError('brotli 压缩常用汉字合一字体失败:${r.stderr}');
        emitBytes('$package/$file', dst.readAsBytesSync(), package);
      } finally {
        tmp.deleteSync(recursive: true);
      }
      emitText('$package/$kReadyModule', kReadyModuleSource, package);
    }

    emitFont(readCjkFont(root, level: cjkFont), kCjkFontPackage, kCjkFontFile);
    if (cjkFontBold != null) {
      emitFont(readCjkFont(root, level: cjkFontBold, bold: true), kCjkFontBoldPackage, kCjkFontBoldFile);
    }
  }

  // 许可证(licenses: false / --no-licenses):NOTICES 换成空占位。完全不给的话
  // 框架 LicenseRegistry 读 NOTICES 失败会在 StreamController.onListen 里抛出、
  // 流永不结束,showLicensePage 一直转圈(见 docs/troubleshooting.md);空内容
  // 解析出一条没有包名的条目,许可证页只显示应用自身信息,不报错。
  if (!licenses && assets.containsKey(kNoticesAsset)) {
    assets[kNoticesAsset] = const <int>[];
  }

  // 资源分组:启动必需 → pkg-assets-boot(首帧前加载);NOTICES、回退字体
  // (按码位邻近分组)、其余资源 → 按需分包。
  final fontRank = fallbackFontCodepointRank(flutterRootFromBin(bin));
  final groups = planAssetGroups(assets,
      fontRank: fontRank, excludeFallbackFonts: remoteBase != null, warn: stderr.writeln);
  final bundle = buildAssetBundle(assets, groups: groups);
  for (final m in bundle.modules) {
    emitText(m.modulePath, m.source, m.package);
  }

  // 远端字体(font_base_url):不进包的回退字体分片原样写到待上传目录,
  // 由用户上传到 CDN;不计入包体积。
  final packed = {for (final g in groups) ...g.paths};
  final remoteFonts = remoteBase == null
      ? const <String>[]
      : (assets.keys.where((k) => k.startsWith(kFontPrefix) && !packed.contains(k)).toList()..sort());
  for (final k in remoteFonts) {
    final f = File(p.join(outputPath, kRemoteFontDir, k.substring(kFontPrefix.length)))
      ..createSync(recursive: true);
    f.writeAsBytesSync(assets[k]!);
  }
  if (remoteFonts.isNotEmpty) {
    stdout.writeln('远端字体:${remoteFonts.length} 个回退字体分片未打包,已写到 '
        '${p.join(outputPath, kRemoteFontDir)}/,请原样上传到 $remoteBase'
        '(该域名须加入小程序后台 request 合法域名)。');
  }

  final subPackages = [
    ...dartPackages, _wasmPackage, if (cjkFont != null) kCjkFontPackage,
    if (cjkFont != null && cjkFontBold != null) kCjkFontBoldPackage, ...bundle.packageRoots,
  ];
  // 首帧前必需的分包:只有这些在 boot 时并行拉取;按需分包由资源条目的
  // require.async 在引擎 fetch 时才触发下载
  final bootSubPackages = [...dartPackages, _wasmPackage, ...bundle.bootPackageRoots];
  for (final root in bootSubPackages) {
    emitText('$root/$kReadyModule', kReadyModuleSource, root);
  }
  emitText(
    kLoaderManifestPath,
    buildLoaderManifest(
      dartModulePaths: dartModulePaths,
      subPackages: bootSubPackages,
      assets: bundle,
      remoteFontBaseUrl: remoteBase,
      remoteFonts: remoteFonts,
      cjkFont: cjkFont == null
          ? null
          : (asset: kCjkFontAsset, package: kCjkFontPackage, file: kCjkFontFile),
      cjkFontBold: cjkFont == null || cjkFontBold == null
          ? null
          : (asset: kCjkFontBoldAsset, package: kCjkFontBoldPackage, file: kCjkFontBoldFile),
      deferredSubPackages: bundle.bootPackageRoots,
    ),
    'main',
  );

  // 7. 运行时 JS 原样拷入(bom-shim / canvaskit-loader / boot)
  //
  // 用 resolvePackageRoot 而不是 Platform.script 上溯:`dart run mp_flutter`
  // 在消费者工程里跑的是编译好的 snapshot,Platform.script 指向消费者
  // `.dart_tool` 下的临时产物,不在本包源码树下,固定上溯层数会跳到无关目录。
  final runtimeDir =
      Directory(p.join(await resolvePackageRoot(), 'runtime'));
  for (final name in [
    'bom-shim.js',
    'canvaskit-loader.js',
    'net.js',
    'font-cache.js',
    'typeface-memo.js',
    'cjk-font.js',
    'xhr.js',
    'storage.js',
    'image.js',
    'wechat.js',
    'safe-area.js',
    'crypto.js',
    'boot.js',
    'touch-bridge.js',
    'text-bridge.js',
    'native-views.js',
    'semantics-mirror.js',
  ]) {
    emitText(name, File(p.join(runtimeDir.path, name)).readAsStringSync(), 'main');
  }
  // perf-hud.js 只在 --perf-hud 打开时才写进产物(M3):关闭时该文件完全不
  // 出现在包体积里,承载页也不会 require 到它(见 buildHostPageJs)。
  if (perfHud) {
    emitText('perf-hud.js',
        File(p.join(runtimeDir.path, 'perf-hud.js')).readAsStringSync(), 'main');
  }

  // 8. 工程骨架(app.json / project.config.json / 承载页模板 / 分包占位页)。
  //    预下载额度只有 2MB:按 wasm → 启动资源包 → dart 的顺序贪心挑,放不下的
  //    由启动器 require.async 各分包的就位探针显式拉取。按需分包不预下载——
  //    预下载了就又回到"不管用不用得到都先下载"。
  final packageBytes = <String, int>{};
  for (final e in entries) {
    packageBytes[e.package] = (packageBytes[e.package] ?? 0) + e.sourceBytes;
  }
  final proj = emitProject(
    appId: appId,
    subPackageRoots: subPackages,
    entryPagePath: _entryPage,
    // 占位页是 emitProject 之后才计入各包的,额度留 8KB 余量
    preloadRoots: selectPreloadPackages(
        [
          _wasmPackage, ...bundle.bootPackageRoots, if (cjkFont != null) kCjkFontPackage, ...dartPackages,
          if (cjkFont != null && cjkFontBold != null) kCjkFontBoldPackage,
        ], packageBytes,
        quotaBytes: kPreloadQuotaBytes - 8 * 1024),
    requireLocation: requireLocation,
    privateInfos: privateInfos,
    perfHud: perfHud,
    splashTitle: splashTitle ?? _pubspecName(projectPath) ?? '',
    splashColor: splashBg,
    ignoreDirs: remoteFonts.isEmpty ? const [] : const [kRemoteFontDir],
  );
  proj.textFiles.forEach((rel, content) {
    final root = rel.split('/').first;
    emitText(rel, content, subPackages.contains(root) ? root : 'main');
  });

  // 承载页逻辑(见 buildHostPageJs)
  emitText('$_entryPage.js',
      buildHostPageJs(verify: verify, forcePlatform: forcePlatform, semanticsMirror: semanticsMirror,
          perfHud: perfHud, bootStages: bootSubPackages.length + 4),
      'main');

  // 9. flutter_ohos 已知分叉差异 → 构建期警告(是 warning 不是 error,
  //    大量 App 不会触发 InkSparkle / stretch overscroll 这两个 shader)。
  for (final d in VersionMatrix.knownDivergences(version)) {
    if (d.id == 'missing_material_shaders') {
      final hasShaders = assets.keys.any((k) => k.contains('shaders/'));
      if (!hasShaders) {
        stderr.writeln('⚠️  ${d.description}\n'
            '    后果:${d.consequence}\n'
            '    绕法:把 .frag 源文件拷进 App 目录并在 pubspec 的 flutter: shaders: 下声明。');
      }
    }
  }

  // 10. 体积校验
  final report = checkSizes(entries);
  stdout.writeln(report.render());
  return report;
}

/// 启动界面应用名的缺省值:工程 pubspec.yaml 的 `name`。
String? _pubspecName(String projectPath) {
  try {
    final doc = loadYaml(File(p.join(projectPath, 'pubspec.yaml')).readAsStringSync());
    final name = doc is Map ? doc['name'] : null;
    return name is String && name.isNotEmpty ? name : null;
  } catch (_) {
    return null;
  }
}

/// `--force-platform` 允许的取值(仅 --verify 构建,E2E 在开发者工具里覆盖真机平台)。
///
/// 开发者工具模拟器跑在 V8 上,Intl 齐全;真机的 JS 引擎不是:
///   · `ios`:iOS 小程序跑在 JavaScriptCore 上,没有 `Intl.v8BreakIterator`
///     (V8 独有),垫片同时遮蔽 `Intl.Segmenter`,按"两者都没有"模拟;
///   · `android-noIntl`:部分安卓微信的 JS 引擎整个没有 `Intl`(真机实测
///     `ReferenceError: Intl is not defined`),垫片把 Intl 遮蔽成不存在,平台按 android;
///   · `android`:只覆盖平台(UA/原生组件几何),不模拟缺失能力。
const kForcePlatforms = ['ios', 'android', 'android-noIntl'];

/// `--force-platform` 取值 → (传给 boot 的平台, 垫片要模拟的缺失能力)。
({String platform, String? simulate}) _forcePlatformArgs(String forcePlatform) {
  switch (forcePlatform) {
    case 'ios':
      return (platform: 'ios', simulate: 'ios');
    case 'android-noIntl':
      return (platform: 'android', simulate: 'android-noIntl');
    default:
      return (platform: forcePlatform, simulate: null);
  }
}

/// 生成承载页 `pages/flutter/flutter.js`。
///
/// ★ 绝不在模块顶层 require 重型产物(boot.js → canvaskit.js / main.dart.js)。
///   真机实测:顶层 require 一旦抛异常,Page() 注册不上,整页不渲染、零提示、
///   纯黑屏,页面内所有诊断代码都跑不到。必须惰性加载并把失败上屏。
///
/// [forcePlatform] 只能与 [verify] 同用:把它作为 boot 的平台覆盖传入,让开发者
/// 工具里的 E2E 覆盖安卓 UA 路径;非 verify 构建产物不受影响。
///
/// [bootStages] 是首帧前 boot() 会报的阶段数(每个启动分包一个,加
/// canvaskit/crypto/dart-chunks/dart-main 四个),原生启动界面按已完成阶段数
/// 估算进度条;`first-frame` 阶段移除启动界面。
String buildHostPageJs({
  required bool verify,
  String? forcePlatform,
  bool semanticsMirror = false,
  bool perfHud = false,
  int bootStages = 8,
}) {
  if (forcePlatform != null) {
    if (!verify) {
      throw ArgumentError.value(forcePlatform, 'forcePlatform', '只能与 --verify 同用');
    }
    if (!kForcePlatforms.contains(forcePlatform)) {
      throw ArgumentError.value(forcePlatform, 'forcePlatform', '只支持 ${kForcePlatforms.join('/')}');
    }
  }
  final forced = forcePlatform == null ? null : _forcePlatformArgs(forcePlatform);
  final platformArg = forced == null
      ? ''
      : ',\n        platform: ${jsonEncode(forced.platform)}'
          '${forced.simulate == null ? '' : ',\n        simulate: ${jsonEncode(forced.simulate)}'}';
  // --perf-hud:把冷启动阶段计时器接进 boot() 的可选 onStage 钩子(见 boot.js
  // 文件头注释——这几个调用点本身只有一次 typeof 判断,发生在应用整个生命
  // 周期里个位数次,不是热路径,不影响 --perf-hud 关闭时的运行时开销)。
  //
  // 原生启动界面(默认开)同样经 onStage 推进度条、在首帧提交时移除,所以
  // onStage 总是传入;perf-hud 关闭时只多一次函数调用,全生命周期个位数次。
  final perfHudStageArg = perfHud
      ? "if (__mpBootTimer) { __mpBootTimer.mark(stage); if (stage === 'first-frame') __mpBootTimer.finish(); } "
      : '';
  final stageArg = ',\n        onStage: (stage) => { $perfHudStageArg'
      'this.mpBootStage(stage); }'
      '${perfHud ? ',\n        perfLog: (line) => console.log(line)' : ''}';
  return '''
Page({
  data: { mpError: '', mpInput: { visible: false }, mpNative: {}, mpNativeList: [], mpSemantics: [],
    mpPerf: { visible: false, fps: 0, avg: 0 },
    mpSplash: { visible: true, progress: 0, error: '' } },
  // 原生启动界面:boot() 每完成一个阶段推一次进度(按阶段数估算,首帧前最多
  // 到 95%),首帧提交('first-frame')即移除——之前画布还是黑的。
  mpBootStage(stage) {
    const sp = this.data.mpSplash || {};
    if (!sp.visible) return;
    if (stage === 'first-frame') { this.setData({ mpSplash: Object.assign({}, sp, { visible: false }) }); return; }
    this.mpStagesDone = (this.mpStagesDone || 0) + 1;
    const progress = Math.min(95, Math.round(this.mpStagesDone / $bootStages * 100));
    if (progress !== sp.progress) this.setData({ mpSplash: Object.assign({}, sp, { progress }) });
  },
  fail(msg) {
    const s = String(msg).slice(0, 400);
    console.error('[mp-flutter] ' + s);
    // 启动界面还在(首帧前失败)时把错误写在界面上,不留一块黑屏;首帧之后的
    // 失败不盖住已经画出来的页面,只靠弹窗
    const sp = this.data.mpSplash || {};
    this.setData(sp.visible ? { mpError: s, mpSplash: Object.assign({}, sp, { error: s }) } : { mpError: s });
    try { wx.showModal({ title: 'mp-flutter 启动失败', content: s.slice(0, 200), showCancel: false }); } catch (e) {}
  },
  onMpTouch(e) { if (this.mpTouch) this.mpTouch.handle(e); },
  onMpInput(e) {
    if (this.mpView) this.mpView.nativeInput(e.detail.value);
    if (this.mpText) this.mpText.nativeInput({ value: e.detail.value, cursor: e.detail.cursor });
  },
  onMpConfirm() { if (this.mpText) this.mpText.nativeConfirm(); },
  onMpNativeEvent(e) {
    // 微信原生组件(video/map/camera)的事件对象没有 e.currentTarget.dataset
    // 以外的办法认出是哪个占位元素——同步层按这个 id 反查、在垫片里的对应
    // div 上转发一个 mpnative CustomEvent,供 Flutter 侧(Task 3)监听回读。
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    if (this.mpNative) this.mpNative.dispatchEvent(ds.mpid, e.type, e.detail);
  },
  onMpBlur(e) {
    // 只转发当前会话原生框的 blur:焦点 A→B 时被销毁的 A 框的 blur 可能晚于 B 聚焦
    // 才到,转发会让 B 立刻失焦(会话比对在桥里做)
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    if (this.mpText) this.mpText.nativeBlur(ds.session);
  },
  onHide() {
    // 切到后台时所有正在按住的手指状态必然丢失(不会再收到 touchend/
    // touchcancel),不清理会让引擎以为手指仍按着,回前台后行为错乱。
    if (this.mpTouch) this.mpTouch.cancelAll();
    // 后台不必每 16ms 轮询引擎输入元素
    if (this.mpText) this.mpText.pause();
  },
  onShow() {
    if (this.mpText) this.mpText.resume();
  },
  onUnload() {
    // 引擎是 JS 上下文单例、不随页面销毁;桥的轮询定时器与焦点订阅必须解除,
    // 否则会对已销毁的页面继续 setData
    if (this.mpText) { this.mpText.dispose(); this.mpText = null; }
    if (this.mpTouch) { this.mpTouch.cancelAll(); this.mpTouch = null; }
    if (this.mpNative) { this.mpNative.stop(); this.mpNative = null; }
    if (this.mpSemantics) { this.mpSemantics.stop(); this.mpSemantics = null; }
    if (this.mpPerf) { this.mpPerf.stop(); this.mpPerf = null; }
  },
  onShareAppMessage() {
    // 分享信息由业务代码经 self.__mpWechat.setShareInfo(json) 设置(见 wechat.js);
    // 未设置时不给 title,让微信用小程序名兜底(与直接返回 {} 的默认行为一致)。
    const info = (this.mpShim && this.mpShim.wechat && this.mpShim.wechat.getShareInfo()) || {};
    return Object.assign({ path: '/$_entryPage' }, info.title ? { title: info.title } : {},
      info.path ? { path: info.path } : {}, info.imageUrl ? { imageUrl: info.imageUrl } : {});
  },
  onShareTimeline() {
    // 分享到朋友圈不支持 path(固定为当前页面),只取已设置字段
    const info = (this.mpShim && this.mpShim.wechat && this.mpShim.wechat.getShareInfo()) || {};
    const out = {};
    ['title', 'query', 'imageUrl'].forEach((k) => { if (info[k]) out[k] = info[k]; });
    return out;
  },
  onLoad(options) {
    // 重入重启后带 mpRestarted=1 回来;若仍检测到重入就不再重启,避免无限重启循环
    const restarted = !!(options && options.mpRestarted);
    // 旧基础库(过低版本)没有 showShareMenu;不存在时忽略,不影响其余启动流程
    try { if (wx.showShareMenu) wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] }); } catch (e) { /* 旧基础库忽略 */ }
    wx.createSelectorQuery().select('#flutter-canvas').node((res) => {
      const canvas = res && res.node;
      if (!canvas) { this.fail('拿不到画布节点(selectorQuery 返回空)'); return; }
      let boot, manifest, acquireGlContext;
      try { boot = require('../../boot.js').boot; }
      catch (e) { this.fail('require boot.js 失败: ' + ((e && e.message) || e)); return; }
      try { manifest = require('../../$kLoaderManifestPath'); }
      catch (e) { this.fail('require 加载表失败: ' + ((e && e.message) || e)); return; }
      try { acquireGlContext = require('../../canvaskit-loader.js').acquireGlContext; }
      catch (e) { this.fail('require canvaskit-loader.js 失败: ' + ((e && e.message) || e)); return; }
      const info = wx.getWindowInfo();
      canvas.width = info.windowWidth * info.pixelRatio;
      canvas.height = info.windowHeight * info.pixelRatio;
${perfHud ? _perfHudBootTimerSnippet : ''}
${verify ? _consoleStateBufferSnippet : ''}
      boot({ canvas, wasmPath: '/$_wasmPackage/canvaskit.wasm.br', manifest,
        cssWidth: info.windowWidth, cssHeight: info.windowHeight$platformArg$stageArg })
        .then((r) => {
          this.mpShim = r.shim;
          // 兜底:首帧钩子没报上来(Surface.flush 包装失败等)时,runApp 之后
          // 3 秒也移除启动界面,不能让它永远盖在画面上
          setTimeout(() => this.mpBootStage('first-frame'), 3000);
          try {
            const { createTouchBridge } = require('../../touch-bridge.js');
            this.mpTouch = createTouchBridge({ shim: r.shim, cssWidth: info.windowWidth });
          } catch (e) { this.fail('触摸桥初始化失败: ' + ((e && e.message) || e)); }
          try {
            const { createTextBridge, createViewSync } = require('../../text-bridge.js');
            // 视图同步负责"推送值等于页面旧数据时也要真正生效"(见 createViewSync)
            this.mpView = createViewSync((patch, cb) => this.setData(patch, cb));
            this.mpText = createTextBridge({ shim: r.shim, cssWidth: info.windowWidth,
              onState: (s) => this.mpView.apply(s) });
          } catch (e) { this.fail('文本输入桥初始化失败: ' + ((e && e.message) || e)); }
          try {
            const { createNativeViews } = require('../../native-views.js');
            this.mpNative = createNativeViews({
              shim: r.shim, wx: r.shim.wx,
              setData: (patch, cb) => this.setData(patch, cb),
              raf: (cb) => r.shim.window.requestAnimationFrame(cb),
            });
          } catch (e) { this.fail('原生视图同步层初始化失败: ' + ((e && e.message) || e)); }
${semanticsMirror ? _semanticsMirrorInitSnippet : ''}
${perfHud ? _perfHudInitSnippet : ''}
${verify ? _verifySnippet : ''}
        })
        .catch((e) => {
          // 引擎是 JS 上下文单例:承载页重入时无法把引擎迁到新画布,重启小程序
          // 得到干净的上下文(等价于用户重新进入)。restartMiniProgram 本身也
          // 可能失败(同步抛出,或走 fail 回调)——两条路都必须落到 this.fail,
          // 否则用户停在无提示的画面上,查不出原因。
          if (e && e.code === 'MP_REENTRY' && restarted) {
            this.fail('重启后仍检测到引擎重入,已停止自动重启(避免循环);请手动关闭小程序后重新打开'
              + '(原始错误:' + ((e && e.stack) || e) + ')');
            return;
          }
          if (e && e.code === 'MP_REENTRY' && typeof wx.restartMiniProgram === 'function') {
            const onRestartFail = (err) => {
              this.fail('重入后重启小程序失败: ' + ((err && (err.errMsg || err.message)) || err)
                + '(原始错误:' + ((e && e.stack) || e) + ')');
            };
            try {
              wx.restartMiniProgram({ path: '/$_entryPage?mpRestarted=1', fail: onRestartFail });
            } catch (err) {
              onRestartFail(err);
            }
            return;
          }
          this.fail('启动失败: ' + ((e && e.stack) || e));
        });
    }).exec();
  },
});
''';
}

/// --semantics-mirror(默认关,见 `semantics-mirror.js` 文件头的裁定与理由):
/// boot 成功、原生视图同步层初始化之后才创建——依赖同一个 `r.shim`。失败
/// 只报 fail,不影响其余功能(WXML 伴生层是纯增量能力)。
const _semanticsMirrorInitSnippet = '''
          try {
            const { createSemanticsMirror } = require('../../semantics-mirror.js');
            this.mpSemantics = createSemanticsMirror({ shim: r.shim,
              setData: (patch, cb) => this.setData(patch, cb) });
            this.mpSemantics.start();
          } catch (e) { this.fail('WXML 伴生层初始化失败: ' + ((e && e.message) || e)); }
''';

/// --perf-hud(默认关):承载页 onLoad 一进来就建冷启动计时器(以 App.onLaunch
/// 记的时间戳 `app.__mpBootT0` 为 t0,见 `emit_project.dart` 的 `appJs`),先打
/// 一行 `onLoad` 阶段;随后经 `boot()` 的 `onStage` 钩子(见上面
/// `perfHudStageArg`)接住 boot.js 内部各阶段(分包/canvaskit/crypto/dart
/// 分片/dart main/首帧),每个阶段一行 `[mp-boot]`,首帧提交时再补一行
/// `[mp-boot] total`。计时失败只 console.error,不影响其余启动流程(纯诊断
/// 功能,不应该因为它失败就弹 `this.fail` 的用户可见弹窗)。
const _perfHudBootTimerSnippet = '''
      let __mpBootTimer = null;
      try {
        const { createBootTimer } = require('../../perf-hud.js');
        const app = getApp();
        __mpBootTimer = createBootTimer({ t0: (app && app.__mpBootT0) || Date.now() });
        __mpBootTimer.mark('onLoad');
      } catch (e) { console.error('[mp-perf] 启动计时初始化失败: ' + ((e && e.message) || e)); }
''';

/// --perf-hud(默认关):boot 成功后启动稳态性能采样(fps/帧耗时/gl 调用/
/// 图片解码/长任务,每秒一行 `[mp-perf]`,外加左上角浮层)。同 WXML 伴生层
/// 一样,依赖同一个 `r.shim`/`r.CK`/`canvas`,失败只 console.error(诊断功能,
/// 不弹用户可见的错误弹窗)。
const _perfHudInitSnippet = '''
          try {
            const { createPerfHud } = require('../../perf-hud.js');
            // gl:CanvasKit 实际在用的上下文(垫片 getContext 交给引擎的那个);
            // glAlt:acquireGlContext 缓存的那个——不是同一对象时两个都包(见 perf-hud.js)
            this.mpPerf = createPerfHud({ canvas: canvas, CK: r.CK,
              gl: r.shim.glContext || acquireGlContext(canvas), glAlt: acquireGlContext(canvas),
              images: r.shim.images, fetchHosts: [r.shim.window, r.shim.self],
              typefaceMemo: r.shim.typefaceMemo,
              fontInfo: { cjkBold: r.shim.cjkBold, fetch: r.shim.window && r.shim.window.fetch },
              setData: (patch, cb) => this.setData(patch, cb) });
            this.mpPerf.start();
          } catch (e) { console.error('[mp-perf] 初始化失败: ' + ((e && e.message) || e)); }
''';

/// --verify:E2E 用 drive.js 跳过 reLaunch(引擎是 JS 上下文单例,重入不会
/// 重新启动),这意味着 App 首帧的 `print('STATE|...')`(走 console.log)可能
/// 在 E2E 的 console 监听器挂上之前就打出来,单靠监听会丢。这里在 boot() 之前
/// 把 console.log 包一层:凡是含 `STATE|` 的行,原样打印之外再顺手推进
/// `getApp().__mpVerify`(与下面 _verifySnippet 用的是同一个缓冲区),E2E 结束
/// 后用 mp.evaluate 一次性取回(见 drive.js)。只在 --verify 下启用,不影响
/// 正常构建的 console 行为。
///
/// console.error 同理包一层,每条以 `ERROR|<前 3 行>` 进缓冲(App.onError 的
/// `[mp-flutter] uncaught:` 也走 console.error):E2E 断言"本次运行控制台无
/// error"只能信这条缓冲——console 监听通道会混入开发者工具重放的上一次运行
/// 历史(K5 路由切换断言用它)。
const _consoleStateBufferSnippet = '''
      (function () {
        const app = getApp();
        app.__mpVerify = app.__mpVerify || [];
        const origLog = console.log;
        console.log = function () {
          origLog.apply(console, arguments);
          try {
            const line = Array.prototype.map.call(arguments, String).join(' ');
            if (line.indexOf('STATE|') >= 0) app.__mpVerify.push(line);
          } catch (e) { /* 缓冲失败不应影响原始日志 */ }
        };
        const origError = console.error;
        console.error = function () {
          origError.apply(console, arguments);
          try {
            const line = Array.prototype.map.call(arguments, String).join(' ');
            app.__mpVerify.push('ERROR|' + line.split('\\n').slice(0, 3).join(' / '));
          } catch (e) { /* 同上 */ }
        };
      })();
''';

/// --verify:在承载页注入像素上报,供 E2E 做渲染断言。
///
/// 两条硬性要求都要满足:
///   1. 必须紧贴引擎 flush 在同一 JS turn 内读取 —— preserveDrawingBuffer
///      默认 false,晚读(比如等到下一个 rAF)恒为 0,0,0,0。
///   2. 必须用 acquireGlContext(canvas) 复用 boot() 建立时缓存的同一个上下文,
///      不能再次调用 canvas.getContext —— canvaskit-loader.js 里已验证:
///      真机 iOS 上 canvas.getContext 第二次调用直接返回 null
///      (模拟器是幂等返回同一对象,掩盖了这个问题)。
const _verifySnippet = '''
          // 像素上报必须紧贴 surface.flush:preserveDrawingBuffer 为 false,
          // runApp 返回时首帧还没画(读到全 0),晚读又会被合成清掉。
          // 包住 CanvasKit 的 Surface.flush,每帧都读,但每个采样点只在值与上次
          // 上报不同时才上报(变化即上报):异步内容(如 Image.network 解码后)
          // 可能在很多帧之后才上屏,固定只报前几帧会漏掉;E2E 取每点最后一次。
          // 遥测同时缓冲到 App 实例上:E2E 的 console 监听可能晚于首帧挂上
          // (不 reLaunch 时启动日志已经打完),结束后用 evaluate 一次性取回
          const app = getApp();
          app.__mpVerify = app.__mpVerify || [];
          const emit = (line) => { console.log(line); app.__mpVerify.push(line); };
          try {
            const gl = acquireGlContext(canvas);
            const proto = r.CK.Surface.prototype;
            const origFlush = proto.flush;
            // frames 只作计数(调试时可看已 flush 多少帧),不再限制上报帧数
            let frames = 0;
            const last = {};   // 每个采样点上次上报的值
            const px = new Uint8Array(4);
            const read = (x, y) => { gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return px.join(','); };
            const report = (name, v) => { if (last[name] !== v) { last[name] = v; emit('PIXEL|' + name + '|' + v); } };
            proto.flush = function () {
              const ret = origFlush.apply(this, arguments);
              frames++;
              report('center', read(Math.round(gl.drawingBufferWidth / 2), Math.round(gl.drawingBufferHeight / 2)));
              report('corner', read(4, 4));
              return ret;
            };
          } catch (e) { emit('PIXEL|error|' + ((e && e.message) || e)); }
          // 垫片覆盖:首帧后引擎触达过哪些未实现的宿主 API,供 E2E 与基线比对。
          // 静态页可能只画一两帧,不能挂在 flush 计数上,按时间延后上报。
          // 末尾的 __end__ 是完整性标记:E2E 没收到它(上报没跑到/超时)就判失败,
          // 不能把"没有数据"当成"没有新增未实现 API"。
          setTimeout(() => {
            try {
              const lines = require('../../bom-shim.js').report();
              lines.forEach((l) => emit('TOUCH|' + l));
              emit('TOUCH|__end__ ' + lines.length);
            } catch (e) { emit('TOUCH|__error__ ' + ((e && e.message) || e)); }
            // 原生视图同步层(Phase 5 Task 2)的几何断言:不能用
            // automator 的 page.data() 直接读——JS 线程忙的时候会把那次调用
            // 卡住(本文件其余 E2E 相关注释也在强调这一点)。这里改成在
            // "本来就在跑"的小程序 JS 线程里自己读 this.data.mpNative,
            // 经同一条 __mpVerify 缓冲区带出去,E2E 结束后 evaluate 一次性取回,
            // 与 PIXEL/STATE/TOUCH 走的是同一条安全通道。
            try {
              emit('MPNATIVE|' + JSON.stringify(this.data.mpNative || {}));
            } catch (e) { emit('MPNATIVE|__error__ ' + ((e && e.message) || e)); }
          }, 3000);
''';
