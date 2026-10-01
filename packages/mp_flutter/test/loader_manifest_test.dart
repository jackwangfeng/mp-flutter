import 'dart:io';

import 'package:test/test.dart';
import 'package:flutter_miniprogram/src/asset_pipeline.dart';
import 'package:flutter_miniprogram/src/loader_manifest.dart';

void main() {
  final bundle = buildAssetBundle({
    'assets/FontManifest.json': [1, 2],
    'assets/字体/思源黑体.ttf': [3],
  });
  final src = buildLoaderManifest(
    dartModulePaths: ['pkg-dart-0/dart.js'],
    subPackages: ['pkg-dart', 'pkg-wasm', ...bundle.packageRoots],
    assets: bundle,
  );

  test('main.dart.js 经 require.async 加载(主包不能同步 require 分包)', () {
    expect(src, contains("require.async(\"./pkg-dart-0/dart.js\")"));
    expect(src, isNot(contains('require(')),
        reason: '加载表里不得出现同步 require');
  });

  test('多个 Dart 分片按顺序串行加载(后一片依赖前一片导出的共享作用域)', () {
    final s = buildLoaderManifest(
      dartModulePaths: ['pkg-dart-0/dart.js', 'pkg-dart-1/dart.js', 'pkg-dart-2/dart.js'],
      subPackages: const [], assets: buildAssetBundle({}));
    expect(s, contains(
        'loadDart: function () { return require.async("./pkg-dart-0/dart.js")'
        '.catch(dartChunkFailed("main.dart.js 分片 1/3(./pkg-dart-0/dart.js)"))'
        '.then(function () { return require.async("./pkg-dart-1/dart.js")'
        '.catch(dartChunkFailed("main.dart.js 分片 2/3(./pkg-dart-1/dart.js)")); })'
        '.then(function () { return require.async("./pkg-dart-2/dart.js")'
        '.catch(dartChunkFailed("main.dart.js 分片 3/3(./pkg-dart-2/dart.js)")); }); },'));
  });

  test('分片加载/执行失败时报错点名第几片与路径,且只包装一次、后续分片不再加载', () async {
    final s = buildLoaderManifest(
      dartModulePaths: ['pkg-dart-0/dart.js', 'pkg-dart-1/dart.js', 'pkg-dart-2/dart.js'],
      subPackages: const [], assets: buildAssetBundle({}));
    final dir = Directory.systemTemp.createTempSync('mpf_manifest_');
    addTearDown(() => dir.deleteSync(recursive: true));
    File('${dir.path}/mp-manifest.js').writeAsStringSync(s);
    // 模拟 require.async:第 2 片执行抛错
    File('${dir.path}/run.js').writeAsStringSync('''
const src = require('fs').readFileSync(__dirname + '/mp-manifest.js', 'utf8');
const loaded = [];
const req = { async: (p) => { loaded.push(p);
  return p.indexOf('pkg-dart-1') >= 0 ? Promise.reject(new Error('boom')) : Promise.resolve(); } };
const m = { exports: {} };
new Function('module', 'require', src)(m, req);
m.exports.loadDart().then(() => console.log('RESOLVED'),
  (e) => console.log(e.message + ' | ' + loaded.join(',')));
''');
    final r = await Process.run('node', ['${dir.path}/run.js']);
    expect(r.stdout.toString().trim(),
        'main.dart.js 分片 2/3(./pkg-dart-1/dart.js)加载/执行失败: boom'
        ' | ./pkg-dart-0/dart.js,./pkg-dart-1/dart.js');
  });

  test('每个资源一条 require.async,路径是字面量', () {
    for (final m in bundle.modules) {
      expect(src, contains('require.async("./${m.modulePath}")'));
    }
    // 不允许运行时拼接路径 —— 开发者工具的静态分析看不到
    expect(src, isNot(contains("+ '")));
  });

  test('切了片的资源:一条清单项并行加载全部分片,按分片序排列', () {
    final big = buildAssetBundle({'assets/big.bin': List.filled(3000, 1)},
        packageBudgetBytes: 4000, maxChunkChars: 1000);
    final s = buildLoaderManifest(
        dartModulePaths: ['pkg-dart-0/dart.js'], subPackages: const [], assets: big);
    final paths = big.modules.map((m) => 'require.async("./${m.modulePath}")').join(', ');
    final roots = (big.modules.map((m) => m.package).toSet().toList()..sort()).map((r) => '"$r"').join(',');
    expect(s, contains('"assets/big.bin": function () { return inPkg([$roots], '
        'function () { return Promise.all([$paths]); }); }'));
    expect('"assets/big.bin"'.allMatches(s), hasLength(1));
  });

  test('清单 key 是引擎查找用的原始资源路径(含中文原样保留)', () {
    expect(src, contains('"assets/FontManifest.json":'));
    expect(src, contains('"assets/字体/思源黑体.ttf":'));
  });

  test('每个分包一条就位探针的 require.async(小程序没有 wx.loadSubpackage)', () {
    for (final root in ['pkg-dart', 'pkg-wasm', 'pkg-assets-0']) {
      expect(src, contains('"$root": function () { return require.async("./$root/$kReadyModule"); }'));
    }
    expect(src, isNot(contains('loadSubpackage')));
  });
  test('subPackages 只列传入的(首帧前)分包;按需分包不出现在探针表里,只在资源条目里', () {
    final b = buildAssetBundle({'assets/FontManifest.json': [1], 'assets/NOTICES': [2]},
        groups: planAssetGroups({'assets/FontManifest.json': [1], 'assets/NOTICES': [2]}));
    final s = buildLoaderManifest(dartModulePaths: ['pkg-dart-0/dart.js'],
        subPackages: ['pkg-dart-0', 'pkg-wasm', ...b.bootPackageRoots], assets: b);
    expect(s, contains('"$kBootAssetPackage": function () { return require.async("./$kBootAssetPackage/$kReadyModule"); }'));
    expect(s, isNot(contains('"$kNoticesPackage": function')));
    expect(s, contains('require.async("./$kNoticesPackage/'));
  });

  test('启动分包里的资源直接 require.async;按需分包里的资源经 inPkg 单飞', () {
    final b = buildAssetBundle({'assets/FontManifest.json': [1], 'assets/NOTICES': [2]},
        groups: planAssetGroups({'assets/FontManifest.json': [1], 'assets/NOTICES': [2]}));
    final s = buildLoaderManifest(dartModulePaths: ['pkg-dart-0/dart.js'],
        subPackages: ['pkg-dart-0', 'pkg-wasm', ...b.bootPackageRoots], assets: b);
    expect(s, matches(RegExp(r'"assets/FontManifest.json": function \(\) \{ return Promise.all')));
    expect(s, contains('"assets/NOTICES": function () { return inPkg(["$kNoticesPackage"], function () {'));
  });

  test('inPkg:同一未下载分包同时只发一次 require.async,其余等它落地后再发;失败不缓存', () async {
    final files = {'mp-fonts/a.woff2': [1], 'mp-fonts/b.woff2': [2], 'mp-fonts/c.woff2': [3]};
    final b = buildAssetBundle(files, groups: planAssetGroups(files));
    final s = buildLoaderManifest(dartModulePaths: ['pkg-dart-0/dart.js'], subPackages: const [], assets: b);
    final dir = Directory.systemTemp.createTempSync('mpf_manifest_gate_');
    addTearDown(() => dir.deleteSync(recursive: true));
    File('${dir.path}/mp-manifest.js').writeAsStringSync(s);
    File('${dir.path}/run.js').writeAsStringSync('''
const src = require('fs').readFileSync(__dirname + '/mp-manifest.js', 'utf8');
function run(failFirst) {
  const ev = [];
  let n = 0;
  const req = { async: (p) => { const id = n++; ev.push('s' + id);
    return new Promise((ok, bad) => setTimeout(() => { ev.push('e' + id);
      if (failFirst && id === 0) bad(new Error('x')); else ok('M'); }, 5)); } };
  const m = { exports: {} };
  new Function('module', 'require', src)(m, req);
  const A = m.exports.assets;
  return Promise.allSettled(Object.keys(A).map((k) => A[k]()))
    .then((r) => r.map((x) => x.status[0]).join('') + ':' + ev.join(','));
}
run(false).then((a) => run(true).then((b) => console.log(a + ' ' + b)));
''');
    final r = await Process.run('node', ['${dir.path}/run.js']);
    // 成功:第一个请求落地(e0)之后其余两个才发出;失败:第一个失败不缓存,
    // 其余两个等它落地后照常各自发起(包仍未下载,由它们重新触发)
    expect(r.stdout.toString().trim(), 'fff:s0,e0,s1,s2,e1,e2 rff:s0,e0,s1,s2,e1,e2');
  });

  test('远端字体:加载表带 remoteFonts(baseUrl + 文件表);未配置时不出现', () {
    final s = buildLoaderManifest(dartModulePaths: ['pkg-dart-0/dart.js'], subPackages: const [],
        assets: buildAssetBundle({}), remoteFontBaseUrl: 'https://cdn.x.com/f/',
        remoteFonts: ['mp-fonts/notosanssc/v37/a.1.woff2']);
    expect(s, contains('remoteFonts: {'));
    expect(s, contains('baseUrl: "https://cdn.x.com/f/"'));
    expect(s, contains('"mp-fonts/notosanssc/v37/a.1.woff2": 1,'));
    expect(src, isNot(contains('remoteFonts')));
  });

  test('deferredSubPackages(启动资源包)与 cjkFont / cjkFontBold 只在给了时出现', () {
    final s = buildLoaderManifest(dartModulePaths: ['pkg-dart-0/dart.js'], subPackages: ['pkg-dart-0', 'pkg-assets-boot'],
        assets: buildAssetBundle({}), deferredSubPackages: ['pkg-assets-boot'],
        cjkFont: (asset: 'assets/mp-cjk/F.ttf', package: 'pkg-cjk', file: 'f.ttf.br'),
        cjkFontBold: (asset: 'assets/mp-cjk/B.ttf', package: 'pkg-cjkb', file: 'b.ttf.br'));
    expect(s, contains('deferredSubPackages: ["pkg-assets-boot"],'));
    expect(s, contains('cjkFont: {\n    key: "assets/mp-cjk/F.ttf",\n    family: "MpNotoSansSC",\n    file: "/pkg-cjk/f.ttf.br",\n'
        '    load: function () { return require.async("./pkg-cjk/mp-ready.js"); },\n  },'));
    expect(s, contains('cjkFontBold: {\n    key: "assets/mp-cjk/B.ttf",\n    family: "MpNotoSansSC",\n    file: "/pkg-cjkb/b.ttf.br",\n'
        '    load: function () { return require.async("./pkg-cjkb/mp-ready.js"); },\n  },'));
    expect(src, isNot(contains('deferredSubPackages')));
    expect(src, isNot(contains('cjkFont')));
    // 没有常规合一字体时粗体无从挂靠,不出现
    final noRegular = buildLoaderManifest(dartModulePaths: ['pkg-dart-0/dart.js'], subPackages: const [],
        assets: buildAssetBundle({}), cjkFontBold: (asset: 'assets/mp-cjk/B.ttf', package: 'pkg-cjkb', file: 'b.ttf.br'));
    expect(noRegular, isNot(contains('cjkFontBold')));
  });

  test('加载表整体是合法 JS(node --check)', () async {
    final dir = Directory.systemTemp.createTempSync('mpf_manifest_chk_');
    addTearDown(() => dir.deleteSync(recursive: true));
    final f = File('${dir.path}/m.js')..writeAsStringSync(buildLoaderManifest(
        dartModulePaths: ['pkg-dart-0/dart.js'], subPackages: ['pkg-wasm'], assets: bundle,
        remoteFontBaseUrl: 'https://c/', remoteFonts: ['mp-fonts/a.woff2']));
    final r = await Process.run('node', ['--check', f.path]);
    expect(r.exitCode, 0, reason: r.stderr.toString());
  });

  test('wasmSubPackage 写进加载表(boot 据此一到 wasm 就编译 CanvasKit);不传就不写', () {
    final s = buildLoaderManifest(dartModulePaths: ['pkg-dart-0/dart.js'],
        subPackages: const ['pkg-dart-0', 'pkg-wasm'], assets: buildAssetBundle({}), wasmSubPackage: 'pkg-wasm');
    expect(s, contains('wasmSubPackage: "pkg-wasm",'));
    expect(src, isNot(contains('wasmSubPackage')));
  });

  test('并进主包的启动资源直接 require.async,不经分包门控', () {
    final assets = {'assets/FontManifest.json': [1], 'assets/a.png': [2]};
    final r = placeBootAssets(planAssetGroups(assets), assets, mode: 'main', mainBytes: 0);
    final b = buildAssetBundle(assets, groups: r.groups);
    final s = buildLoaderManifest(dartModulePaths: ['pkg-dart-0/dart.js'],
        subPackages: const ['pkg-dart-0', 'pkg-wasm'], assets: b);
    final line = s.split('\n').firstWhere((l) => l.contains('"assets/FontManifest.json"'));
    expect(line, contains('require.async("./$kMainBootAssetDir/'));
    expect(line, isNot(contains('inPkg')));
    expect(s, isNot(contains('deferredSubPackages')));
  });
}
