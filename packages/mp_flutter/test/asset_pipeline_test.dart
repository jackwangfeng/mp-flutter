import 'dart:convert';
import 'package:test/test.dart';
import 'package:mp_flutter/src/asset_pipeline.dart';

void main() {
  test('单个资源转成可 require 的 base64 模块', () {
    final bundle = buildAssetBundle({
      'assets/fonts/Roboto.ttf': [0, 1, 2, 3, 250],
    });
    expect(bundle.modules, hasLength(1));
    final m = bundle.modules.single;
    expect(m.originalPath, 'assets/fonts/Roboto.ttf');
    expect(m.modulePath, endsWith('.js'));
    expect(m.source, contains('module.exports'));
    expect(m.source, contains(base64Encode([0, 1, 2, 3, 250])));
    expect(m.originalBytes, 5);
  });

  test('模块路径落在所属资源分包下', () {
    final bundle = buildAssetBundle({
      'assets/a.png': [1],
      'assets/b.png': [2],
    });
    for (final m in bundle.modules) {
      expect(m.package, startsWith(kAssetPackagePrefix));
      expect(m.modulePath, startsWith('${m.package}/a/'));
    }
    expect(bundle.packageRoots, ['${kAssetPackagePrefix}0']);
  });

  group('装箱到多个资源分包(单分包上限 2048KB)', () {
    test('总量超过预算时拆成多个分包,且每个分包都不超预算', () {
      // 三个约 1KB 的资源,预算 2.5KB → 至少两个包
      final bundle = buildAssetBundle({
        'assets/x.bin': List.filled(600, 1),
        'assets/y.bin': List.filled(600, 2),
        'assets/z.bin': List.filled(600, 3),
      }, packageBudgetBytes: 2500);
      expect(bundle.packageRoots.length, greaterThan(1));
      final per = <String, int>{};
      for (final m in bundle.modules) {
        per[m.package] = (per[m.package] ?? 0) + m.encodedBytes;
      }
      expect(per.values.every((v) => v <= 2500), isTrue, reason: '$per');
      expect(per.keys.toSet(), bundle.packageRoots.toSet());
    });

    test('单个资源超过分片上限时切片:每片可独立解码,拼接后与原文一致', () {
      final data = List.generate(5000, (i) => i % 251);
      final bundle = buildAssetBundle({'assets/big.bin': data},
          packageBudgetBytes: 4000, maxChunkChars: 2000);
      final chunks = bundle.modules.where((m) => m.originalPath == 'assets/big.bin').toList();
      expect(chunks.length, greaterThan(1));
      expect(chunks.map((c) => c.chunkIndex), List.generate(chunks.length, (i) => i));
      expect(chunks.every((c) => c.chunkCount == chunks.length), isTrue);
      expect(chunks.map((c) => c.modulePath).toSet(), hasLength(chunks.length), reason: '分片模块路径必须互不相同');
      final joined = <int>[];
      for (final c in chunks) {
        final b64 = RegExp(r'module\.exports = "([^"]*)"').firstMatch(c.source)!.group(1)!;
        expect(b64.length % 4, 0, reason: '切点必须对齐 4 字符');
        joined.addAll(base64Decode(b64));
      }
      expect(joined, data);
      expect(chunks.fold<int>(0, (n, c) => n + c.originalBytes), data.length);
    });

    test('默认参数下,超过单分包上限的资源切片后每个包都不超预算', () {
      // 3MB 的资源(模拟未裁剪的 MaterialIcons / 依赖多时的 NOTICES)
      final bundle = buildAssetBundle({'assets/huge.otf': List.filled(3 * 1024 * 1024, 7)});
      final per = <String, int>{};
      for (final m in bundle.modules) {
        per[m.package] = (per[m.package] ?? 0) + m.encodedBytes;
      }
      expect(per.values.every((v) => v <= kAssetPackageBudgetBytes), isTrue, reason: '$per');
      expect(bundle.modules.length, greaterThan(1));
    });

    test('布局只取决于输入:输入顺序不同,结果相同', () {
      final a = {'assets/p.bin': List.filled(700, 1), 'assets/q.bin': List.filled(900, 2),
                 'assets/r.bin': List.filled(300, 3)};
      final b = Map.fromEntries(a.entries.toList().reversed);
      String layout(AssetBundle x) => x.modules.map((m) => m.modulePath).join('|');
      expect(layout(buildAssetBundle(a, packageBudgetBytes: 2000)),
             layout(buildAssetBundle(b, packageBudgetBytes: 2000)));
    });
  });

  test('空资源集产出空 bundle,不报错', () {
    final bundle = buildAssetBundle({});
    expect(bundle.modules, isEmpty);
    expect(bundle.totalEncodedBytes, 0);
  });

  test('记录膨胀率以便体积校验使用', () {
    final bundle = buildAssetBundle({'assets/x.bin': List.filled(3000, 7)});
    final m = bundle.modules.single;
    // base64 膨胀约 4/3
    expect(m.encodedBytes, greaterThan(m.originalBytes));
    expect(m.encodedBytes / m.originalBytes, closeTo(1.34, 0.05));
  });

  group('非 ASCII 与特殊字符路径', () {
    test('中文路径产出合法模块路径', () {
      final path = sanitizeAssetModulePath('assets/图片/商品详情@2x.png');
      expect(path, startsWith('a/'));
      expect(path, endsWith('.js'));
      // 模块路径中不得残留非法字符
      final base = path.split('/').last;
      expect(RegExp(r'^[A-Za-z0-9_]+\.js$').hasMatch(base), isTrue,
          reason: '模块名含非法字符:$base');
    });

    test('清洗后会撞名的两个路径仍映射到不同模块', () {
      final a = sanitizeAssetModulePath('assets/图片/a.png');
      final b = sanitizeAssetModulePath('assets/图片_a.png');
      expect(a, isNot(equals(b)), reason: '清洗后撞名,会互相覆盖');
    });

    test('中文路径的资源内容能正确往返', () {
      const path = 'assets/字体/思源黑体.ttf';
      final bundle = buildAssetBundle({path: [0, 255, 128]});
      final m = bundle.modules.single;
      expect(m.originalPath, path);
      expect(m.source, contains(base64Encode([0, 255, 128])));
      // encodedBytes 必须用 UTF-8 字节数,不能用 String.length (UTF-16 code unit)
      expect(m.encodedBytes, equals(utf8.encode(m.source).length),
          reason: '中文注释导致 String.length 低估 ~30%,必须用 utf8.encode 口径');
    });

    test('空格与括号路径', () {
      final p = sanitizeAssetModulePath('assets/my image (1).png');
      expect(RegExp(r'^[A-Za-z0-9_]+\.js$').hasMatch(p.split('/').last), isTrue);
    });
  });
  group('资源分组(启动必需 / NOTICES / 回退字体 / 其他)', () {
    final fontManifest = utf8.encode(jsonEncode([
      {'family': 'MaterialIcons', 'fonts': [{'asset': 'fonts/MaterialIcons-Regular.otf'}]},
      {'family': 'packages/cupertino_icons/CupertinoIcons',
       'fonts': [{'asset': 'packages/cupertino_icons/assets/CupertinoIcons.ttf'}]},
    ]));
    Map<String, List<int>> sample() => {
      'assets/FontManifest.json': fontManifest,
      'assets/AssetManifest.bin': [1],
      'assets/AssetManifest.bin.json': [2],
      'assets/fonts/MaterialIcons-Regular.otf': List.filled(100, 3),
      'assets/packages/cupertino_icons/assets/CupertinoIcons.ttf': List.filled(100, 4),
      'assets/NOTICES': List.filled(1000, 5),
      'assets/shaders/ink_sparkle.frag': [6],
      'assets/images/a.png': [7],
      'mp-fonts/roboto/v32/R.woff2': List.filled(50, 8),
      'mp-fonts/notosanssc/v37/s.1.woff2': [9],
      'mp-fonts/notosanssc/v37/s.2.woff2': [10],
    };
    Map<String, List<String>> byGroup(List<AssetGroup> gs) => {for (final g in gs) g.name: g.paths};

    test('清单文件、FontManifest 声明的字体、回退 Roboto 进启动组;其余按需', () {
      final g = byGroup(planAssetGroups(sample()));
      expect(g[kBootAssetPackage], unorderedEquals([
        'assets/FontManifest.json', 'assets/AssetManifest.bin', 'assets/AssetManifest.bin.json',
        'assets/fonts/MaterialIcons-Regular.otf',
        'assets/packages/cupertino_icons/assets/CupertinoIcons.ttf',
        'mp-fonts/roboto/v32/R.woff2',
      ]));
      expect(g[kNoticesPackage], ['assets/NOTICES']);
      expect(g[kFontPackagePrefix], ['mp-fonts/notosanssc/v37/s.1.woff2', 'mp-fonts/notosanssc/v37/s.2.woff2']);
      expect(g[kAssetPackagePrefix], ['assets/images/a.png', 'assets/shaders/ink_sparkle.frag']);
    });

    test('只有启动组的分包是 bootPackageRoots', () {
      final b = buildAssetBundle(sample(), groups: planAssetGroups(sample()));
      expect(b.bootPackageRoots, [kBootAssetPackage]);
      expect(b.packageRoots, [kBootAssetPackage, kNoticesPackage, '${kFontPackagePrefix}0', '${kAssetPackagePrefix}0']);
      final notices = b.modules.singleWhere((m) => m.originalPath == 'assets/NOTICES');
      expect(notices.package, kNoticesPackage);
    });

    test('FontManifest 自己声明了 Roboto:回退 Roboto 不会被引擎启动时下载,不进启动组', () {
      final a = sample()
        ..['assets/FontManifest.json'] = utf8.encode(jsonEncode([
          {'family': 'Roboto', 'fonts': [{'asset': 'fonts/Roboto.ttf'}]},
        ]))
        ..['assets/fonts/Roboto.ttf'] = [1];
      final g = byGroup(planAssetGroups(a));
      expect(g[kBootAssetPackage], contains('assets/fonts/Roboto.ttf'));
      expect(g[kBootAssetPackage], isNot(contains('mp-fonts/roboto/v32/R.woff2')));
      expect(g[kFontPackagePrefix], contains('mp-fonts/roboto/v32/R.woff2'));
    });

    test('空占位 NOTICES(licenses: false)放启动组,不单独占一个分包', () {
      final a = sample()..['assets/NOTICES'] = const [];
      final g = byGroup(planAssetGroups(a));
      expect(g[kBootAssetPackage], contains('assets/NOTICES'));
      expect(g.containsKey(kNoticesPackage), isFalse);
    });

    test('远端字体模式:回退字体分片不进任何组,Roboto 仍在启动组', () {
      final g = byGroup(planAssetGroups(sample(), excludeFallbackFonts: true));
      expect(g.containsKey(kFontPackagePrefix), isFalse);
      expect(g[kBootAssetPackage], contains('mp-fonts/roboto/v32/R.woff2'));
    });

    test('回退字体按码位排名排序,依次装进约 512KB 的按需分包(码位相近的同包)', () {
      final a = <String, List<int>>{
        for (var i = 0; i < 6; i++) 'mp-fonts/notosanssc/v37/s.$i.woff2': List.filled(200 * 1024, i),
      };
      // 排名打乱:5,3,1 码位小,0,2,4 码位大
      final rank = {
        for (var i = 0; i < 6; i++) 'mp-fonts/notosanssc/v37/s.$i.woff2': i.isOdd ? 100 - i : 1000 + i,
      };
      final b = buildAssetBundle(a, groups: planAssetGroups(a, fontRank: rank));
      String pkgOf(int i) => b.modules.firstWhere((m) => m.originalPath.endsWith('s.$i.woff2')).package;
      // base64 后每个约 267KB,512KB 预算下每包 1 个……两个放不下,验证顺序与分组
      expect(b.packageRoots.every((r) => r.startsWith(kFontPackagePrefix)), isTrue);
      final order = [5, 3, 1, 0, 2, 4].map(pkgOf).toList();
      expect(order, List.of(order)..sort((x, y) => int.parse(x.split('-').last).compareTo(int.parse(y.split('-').last))),
          reason: '包编号必须随码位排名单调');
      final per = <String, int>{};
      for (final m in b.modules) {
        per[m.package] = (per[m.package] ?? 0) + m.encodedBytes;
      }
      expect(per.values.every((v) => v <= kOnDemandPackageBudgetBytes), isTrue, reason: '$per');
    });

    test('小分片按顺序凑满一个按需包再开下一个', () {
      final a = <String, List<int>>{
        for (var i = 0; i < 10; i++) 'mp-fonts/notosanssc/v37/s.$i.woff2': List.filled(100 * 1024, i),
      };
      final b = buildAssetBundle(a, groups: planAssetGroups(a));
      // 每个 base64 约 134KB,512KB 装 3 个 → 4 个包
      expect(b.packageRoots, ['${kFontPackagePrefix}0', '${kFontPackagePrefix}1', '${kFontPackagePrefix}2', '${kFontPackagePrefix}3']);
    });

    test('FontManifest 解析失败:警告,字体按普通资源处理,不崩', () {
      final warns = <String>[];
      final a = sample()..['assets/FontManifest.json'] = utf8.encode('not json');
      final g = byGroup(planAssetGroups(a, warn: warns.add));
      expect(warns.single, contains('FontManifest.json 解析失败'));
      expect(g[kAssetPackagePrefix], contains('assets/fonts/MaterialIcons-Regular.otf'));
    });
  });

  group('placeBootAssets(冷启动 boot_assets)', () {
    final assets = <String, List<int>>{
      'assets/FontManifest.json': utf8.encode('[]'),
      'assets/AssetManifest.bin': List.filled(3000, 1),
      'assets/images/a.png': List.filled(100, 2),
    };
    final groups = planAssetGroups(assets);
    final bootBytes = estimateGroupBytes(assets, groups.firstWhere((g) => g.boot).paths);

    test('estimateGroupBytes 与实际装箱字节一致', () {
      final b = buildAssetBundle(assets, groups: groups);
      final actual = b.modules.where((m) => m.package == kBootAssetPackage).fold<int>(0, (n, m) => n + m.encodedBytes);
      expect(bootBytes, actual);
    });

    test('auto:放得下就进主包,不再有 pkg-assets-boot 分包,模块在主包目录下', () {
      final r = placeBootAssets(groups, assets, mode: 'auto', mainBytes: 500 * 1024,
          dartPackageBytes: {'pkg-dart-0': 1700 * 1024});
      expect(r.where, 'main');
      final b = buildAssetBundle(assets, groups: r.groups);
      expect(b.bootPackageRoots, isEmpty);
      expect(b.packageRoots, isNot(contains(kBootAssetPackage)));
      final m = b.modules.firstWhere((m) => m.originalPath == 'assets/FontManifest.json');
      expect(m.package, 'main');
      expect(m.modulePath, startsWith('$kMainBootAssetDir/'));
    });

    test('主包放不下:并进最小的 dart 分包;dart 也放不下:保持单独分包', () {
      final r = placeBootAssets(groups, assets, mode: 'auto', mainBytes: kBootAssetsMainCeilingBytes,
          dartPackageBytes: {'pkg-dart-0': 1700 * 1024, 'pkg-dart-1': 700 * 1024});
      expect(r.where, 'pkg-dart-1');
      final b = buildAssetBundle(assets, groups: r.groups);
      final m = b.modules.firstWhere((m) => m.originalPath == 'assets/FontManifest.json');
      expect(m.package, 'pkg-dart-1');
      expect(m.modulePath, startsWith('pkg-dart-1/boot/'));
      expect(b.packageRoots, isNot(contains('pkg-dart-1')), reason: 'dart 分包本来就在分包表里,不重复');
      final none = placeBootAssets(groups, assets, mode: 'auto', mainBytes: kBootAssetsMainCeilingBytes,
          dartPackageBytes: {'pkg-dart-0': kBootAssetsDartCeilingBytes});
      expect(none.where, kBootAssetPackage);
      expect(identical(none.groups, groups), isTrue);
    });

    test('dart 模式跳过主包;package 模式保持 0.2.3 行为', () {
      expect(placeBootAssets(groups, assets, mode: 'dart', mainBytes: 0,
          dartPackageBytes: {'pkg-dart-0': 100}).where, 'pkg-dart-0');
      expect(placeBootAssets(groups, assets, mode: 'dart', mainBytes: 0).where, kBootAssetPackage);
      expect(placeBootAssets(groups, assets, mode: 'package', mainBytes: 0).where, kBootAssetPackage);
    });
  });
}
