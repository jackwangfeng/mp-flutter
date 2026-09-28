import 'dart:convert';

/// 资源分包的 root 前缀:`pkg-assets-0`、`pkg-assets-1`……(按需加载的一般资源)
const kAssetPackagePrefix = 'pkg-assets-';

/// 启动必需资源的分包(首帧前加载):`pkg-assets-boot`,放不下时溢出到
/// `pkg-assets-boot-1`……
const kBootAssetPackage = 'pkg-assets-boot';

/// NOTICES(许可证全文)的按需分包。
const kNoticesPackage = 'pkg-notices';

/// 回退字体分片的按需分包前缀:`pkg-fonts-0`、`pkg-fonts-1`……
const kFontPackagePrefix = 'pkg-fonts-';

/// 按需分包的目标粒度。
///
/// 微信的分包是整包下载的:require.async 分包里任意一个模块都会把整个分包
/// 拉下来。按需分包做小,引擎要一个字形/一张图时就不用顺带下载 2MB。
/// 微信没有公开的分包数量上限(只限单包 2MB、总包 30MB,服务商代开发
/// 20MB),但每个分包各有一次下载往返和一个占位页,也不宜切得太碎——
/// 取约 512KB。
const kOnDemandPackageBudgetBytes = 512 * 1024;

/// 引擎初始化时(首帧之前)一定会 fetch 的资源清单文件。
///
/// 依据 Flutter 3.41.9 源码:
///  · 引擎 `initializeEngineServices` → `_downloadAssetFonts` 取
///    `FontManifest.json`,并下载其中声明的**全部**字体(canvaskit/fonts.dart
///    `loadAssetFonts`);清单里没声明 Roboto 时还会下载回退 Roboto。
///  · 框架 `AssetManifest.loadFromAssetBundle`(`Image.asset` 解析分辨率变体时)
///    读 `AssetManifest.bin.json`(web);首屏有 Image.asset 就会在首帧前读到。
///    `.bin`/`.json` 两个变体很小,一并放进启动包。
///  · shaders(ink_sparkle / stretch_effect)只在对应效果第一次出现时经
///    `FragmentProgram.fromAsset` 加载,不在启动路径;NOTICES 只在
///    `LicenseRegistry.licenses` 被监听(打开许可证页)时加载。
const kBootManifestAssets = <String>{
  'assets/FontManifest.json',
  'assets/AssetManifest.bin',
  'assets/AssetManifest.bin.json',
  'assets/AssetManifest.json',
};

const kNoticesAsset = 'assets/NOTICES';

/// 单个资源分包的装箱预算。
///
/// 微信单分包上限 2048KB(按源码大小计),这里留出约 48KB 给占位页和
/// 余量——装箱只按资源模块本身计,占位页是 emitProject 后加的。
const kAssetPackageBudgetBytes = 2000 * 1024;

/// 一个资源(或资源的一个分片)对应的 base64 JS 模块。
///
/// 单个资源 base64 后可能超过单分包上限(未裁剪的 MaterialIcons 2142KB、
/// 依赖多时的 NOTICES),这时切成若干分片,各自成模块、可落在不同分包,
/// 运行时并行加载后按 [chunkIndex] 顺序拼接。
class AssetModule {
  final String originalPath;   // 如 assets/fonts/Roboto.ttf
  final String package;        // 如 pkg-assets-0
  final String modulePath;     // 如 pkg-assets-0/a/assets_fonts_Roboto_ttf_xxx.js
  final String source;
  final int originalBytes;     // 本分片解码后的字节数
  final int encodedBytes;
  final int chunkIndex;
  final int chunkCount;
  const AssetModule({
    required this.originalPath,
    required this.package,
    required this.modulePath,
    required this.source,
    required this.originalBytes,
    required this.encodedBytes,
    this.chunkIndex = 0,
    this.chunkCount = 1,
  });
}

class AssetBundle {
  final List<AssetModule> modules;

  /// 实际用到的资源分包 root(启动分包在前,其余按组、按编号)。
  final List<String> packageRoots;

  /// 其中首帧前必须就位的分包(boot.js 启动时并行拉取);其余分包只在引擎
  /// 真正 fetch 其中某个资源时,经该资源自己的 require.async 按需下载。
  final List<String> bootPackageRoots;
  const AssetBundle(this.modules, this.packageRoots, {this.bootPackageRoots = const []});

  int get totalEncodedBytes =>
      modules.fold(0, (sum, m) => sum + m.encodedBytes);
}

/// 把任意资源路径变成一个合法、唯一的模块文件路径(相对所在分包 root)。
///
/// 小程序的模块路径只接受有限字符集,而 Flutter 的 assets 路径可能含中文、
/// 空格、`@2x` 之类。策略:非 `[A-Za-z0-9_]` 一律转下划线,再追加原始路径的
/// 哈希后缀保证唯一(避免 `图片/a.png` 与 `图片_a.png` 撞名)。
String sanitizeAssetModulePath(String assetPath) {
  final safe = assetPath.replaceAll(RegExp(r'[^A-Za-z0-9_]'), '_');
  final hash = _fnv1a(assetPath).toRadixString(36);
  return 'a/${safe}_$hash.js';
}

int _fnv1a(String s) {
  var h = 0x811c9dc5;
  for (final b in utf8.encode(s)) {
    h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF;
  }
  return h;
}

/// 资源的一个装箱组:同组资源装进同一串分包。
class AssetGroup {
  /// 分包 root 的命名:[numbered] 为 true 时是 `$name$i`(如 `pkg-fonts-0`),
  /// 否则第一个包叫 [name],溢出的叫 `$name-1`、`$name-2`……
  final String name;
  final bool numbered;

  /// 本组分包是否首帧前必须就位。
  final bool boot;

  /// 单个分包的装箱预算。
  final int budgetBytes;

  /// true:严格按 [paths] 顺序依次装(相邻资源落在同一包,用于按码位邻近
  /// 分组的字体、按目录聚类的图片);false:first-fit decreasing,包数最少。
  final bool sequential;

  final List<String> paths;

  const AssetGroup({
    required this.name,
    required this.paths,
    this.numbered = false,
    this.boot = false,
    this.budgetBytes = kAssetPackageBudgetBytes,
    this.sequential = false,
  });

  String rootFor(int i) => numbered ? '$name$i' : (i == 0 ? name : '$name-$i');
}

/// 把资源分成启动必需 / NOTICES / 回退字体 / 其他四组。
///
/// [fontRank] 给回退字体(`mp-fonts/` 下)排序:值小的在前,相邻的落进同一
/// 个按需分包;没有排名的按路径排在最后。[excludeFallbackFonts] 为 true
/// (`font_base_url` 远端字体)时回退字体分片不进包(Roboto 除外,见下)。
///
/// Roboto:FontManifest 没声明 Roboto 家族时,引擎初始化会无条件下载回退
/// Roboto——它在启动路径上,必须放启动包,远端模式下也保留在包内(启动不能
/// 依赖 CDN)。声明了 Roboto 时回退 Roboto 就只是普通回退字体。
List<AssetGroup> planAssetGroups(
  Map<String, List<int>> assets, {
  Map<String, num> fontRank = const {},
  bool excludeFallbackFonts = false,
  void Function(String message)? warn,
}) {
  final declared = parseFontManifest(assets['assets/FontManifest.json'], warn: warn);
  final bootFontAssets = {for (final f in declared.assets) 'assets/$f'};
  final robotoDeclared = declared.families.contains('Roboto');

  final boot = <String>[];
  final notices = <String>[];
  final fonts = <String>[];
  final other = <String>[];
  for (final path in assets.keys) {
    if (kBootManifestAssets.contains(path) || bootFontAssets.contains(path)) {
      boot.add(path);
    } else if (path == kNoticesAsset) {
      // 空的占位 NOTICES(licenses: false)只有百余字节,放启动包省一次分包下载
      (assets[path]!.isEmpty ? boot : notices).add(path);
    } else if (path.startsWith('mp-fonts/')) {
      if (!robotoDeclared && path.startsWith('mp-fonts/roboto/')) {
        boot.add(path);
      } else if (!excludeFallbackFonts) {
        fonts.add(path);
      }
    } else {
      other.add(path);
    }
  }
  num rankOf(String path) => fontRank[path] ?? double.infinity;
  fonts.sort((a, b) {
    final c = rankOf(a).compareTo(rankOf(b));
    return c != 0 ? c : a.compareTo(b);
  });
  boot.sort();
  other.sort(); // 按路径:同目录(同类)资源相邻,落进同一个按需分包

  return [
    if (boot.isNotEmpty) AssetGroup(name: kBootAssetPackage, boot: true, paths: boot),
    if (notices.isNotEmpty) AssetGroup(name: kNoticesPackage, paths: notices),
    if (fonts.isNotEmpty)
      AssetGroup(name: kFontPackagePrefix, numbered: true, sequential: true,
          budgetBytes: kOnDemandPackageBudgetBytes, paths: fonts),
    if (other.isNotEmpty)
      AssetGroup(name: kAssetPackagePrefix, numbered: true, sequential: true,
          budgetBytes: kOnDemandPackageBudgetBytes, paths: other),
  ];
}

/// `FontManifest.json` 里声明的家族名与字体资源路径(相对 `assets/`)。
({Set<String> families, List<String> assets}) parseFontManifest(List<int>? bytes,
    {void Function(String message)? warn}) {
  final families = <String>{};
  final out = <String>[];
  if (bytes == null) return (families: families, assets: out);
  try {
    final doc = jsonDecode(utf8.decode(bytes));
    for (final fam in doc as List) {
      families.add('${(fam as Map)['family']}');
      for (final f in (fam['fonts'] as List? ?? const [])) {
        out.add('${(f as Map)['asset']}');
      }
    }
  } catch (e) {
    warn?.call('⚠️  FontManifest.json 解析失败($e),其中的字体按普通资源按需加载;'
        '引擎启动时会等这些字体,首帧会因此多等一次分包下载。');
  }
  return (families: families, assets: out);
}

/// 把资源转成 base64 模块,并装箱到若干资源分包里。
///
/// base64 超过 [maxChunkChars] 的资源先切片(切点对齐 4 字符,每片可独立
/// 解码)。[groups] 缺省时全部资源作为一组 `pkg-assets-N`,first-fit
/// decreasing 装箱(先大后小,放进第一个装得下的包);给了 [groups] 时逐组
/// 装箱(见 [AssetGroup]),不在任何组里的资源不进包。结果只取决于输入,
/// 同一份资源每次构建得到同样的布局。
AssetBundle buildAssetBundle(
  Map<String, List<int>> assets, {
  int packageBudgetBytes = kAssetPackageBudgetBytes,
  int? maxChunkChars,
  List<AssetGroup>? groups,
}) {
  // 留 1KB 给模块头部注释与 module.exports 包装
  final chunkChars = maxChunkChars ?? ((packageBudgetBytes - 1024) ~/ 4) * 4;
  assert(chunkChars > 0 && chunkChars % 4 == 0);

  final plan = groups ??
      [
        AssetGroup(
            name: kAssetPackagePrefix,
            numbered: true,
            budgetBytes: packageBudgetBytes,
            paths: (assets.keys.toList()..sort())),
      ];

  final modules = <AssetModule>[];
  final roots = <String>[];
  final bootRoots = <String>[];
  for (final g in plan) {
    final pending = <_Pending>[
      for (final p in g.paths) ..._encode(p, assets[p]!, chunkChars),
    ];
    if (!g.sequential) {
      pending.sort((a, b) {
        final bySize = b.encoded.compareTo(a.encoded);
        if (bySize != 0) return bySize;
        final byPath = a.path.compareTo(b.path);
        return byPath != 0 ? byPath : a.index.compareTo(b.index);
      });
    }
    // 单个模块超过组预算(比如 1MB 的图片进 512KB 的按需组)时独占一个新包;
    // 模块本身已按单分包硬预算切过片,不会超过微信上限。
    final used = <int>[];
    for (final m in pending) {
      int idx;
      if (g.sequential) {
        idx = used.isEmpty ? -1 : used.length - 1;
        if (idx >= 0 && used[idx] > 0 && used[idx] + m.encoded > g.budgetBytes) idx = -1;
      } else {
        idx = used.indexWhere((u) => u + m.encoded <= g.budgetBytes);
      }
      if (idx < 0) {
        used.add(0);
        idx = used.length - 1;
      }
      used[idx] += m.encoded;
      final pkg = g.rootFor(idx);
      var file = sanitizeAssetModulePath(m.path);
      if (m.count > 1) file = file.replaceFirst(RegExp(r'\.js$'), '_p${m.index}.js');
      modules.add(AssetModule(
        originalPath: m.path,
        package: pkg,
        modulePath: '$pkg/$file',
        source: m.source,
        originalBytes: base64Decode(m.b64).length,
        encodedBytes: m.encoded,
        chunkIndex: m.index,
        chunkCount: m.count,
      ));
    }
    for (var i = 0; i < used.length; i++) {
      roots.add(g.rootFor(i));
      if (g.boot) bootRoots.add(g.rootFor(i));
    }
  }
  modules.sort((a, b) {
    final byPath = a.originalPath.compareTo(b.originalPath);
    return byPath != 0 ? byPath : a.chunkIndex.compareTo(b.chunkIndex);
  });

  return AssetBundle(modules, roots, bootPackageRoots: bootRoots);
}

class _Pending {
  final String path;
  final int index;
  final int count;
  final String b64;
  final String source;
  final int encoded;
  _Pending(this.path, this.index, this.count, this.b64, this.source, this.encoded);
}

List<_Pending> _encode(String p, List<int> bytes, int chunkChars) {
  final b64 = base64Encode(bytes);
  final count = b64.isEmpty ? 1 : (b64.length + chunkChars - 1) ~/ chunkChars;
  return [
    for (var i = 0; i < count; i++)
      () {
        final part = b64.substring(i * chunkChars,
            (i + 1) * chunkChars > b64.length ? b64.length : (i + 1) * chunkChars);
        final source =
            '// [mp-flutter] asset: $p${count > 1 ? ' (分片 ${i + 1}/$count)' : ''}\n'
            '// 小程序代码包内的二进制文件无法用 FileSystemManager 读取,故 base64 内嵌。\n'
            'module.exports = "$part";\n';
        return _Pending(p, i, count, part, source, utf8.encode(source).length);
      }(),
  ];
}
