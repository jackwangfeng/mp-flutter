import 'dart:io';
import 'dart:math' show sqrt;
import 'dart:typed_data';

import 'package:path/path.dart' as p;

/// 回退字体在产物资源里的前缀;启动时把引擎的 `fontFallbackBaseUrl` 指向它。
///
/// Flutter Web 引擎默认从 `https://fonts.gstatic.com/s/` 拉 Roboto 与 Noto
/// 回退字体。小程序里这条路不通(资源 fetch 只认打包进来的文件,且国内访问
/// 不到 gstatic),拉不到 Roboto 时引擎直接崩在 `Null check operator used on a
/// null value`。改为构建期下载、打包,运行时经资源 fetch 按原相对路径供给。
const kFontPrefix = 'mp-fonts/';

/// 默认打包的回退字体家族。
///
/// `roboto` 是引擎的默认字体,缺了必崩;`notosanssc` 是简体中文回退。
/// GB2312 的字分散在 notosanssc 的 97/101 个分片里(分片按字频切,不按
/// GB2312 切),挑分片省不下什么,干脆整套打包(约 2.4MB,base64 后约 3.1MB)。
/// 其余家族(日/韩/繁/emoji)不打包:引擎请求会得到 404,相应字符不显示,
/// 但不影响启动。
const kDefaultFontFamilies = ['roboto', 'notosanssc'];

/// woff2 文件魔数 `wOF2`。
const _woff2Magic = [0x77, 0x4F, 0x46, 0x32];

bool _isWoff2(List<int> b) =>
    b.length >= 4 &&
    b[0] == _woff2Magic[0] &&
    b[1] == _woff2Magic[1] &&
    b[2] == _woff2Magic[2] &&
    b[3] == _woff2Magic[3];

/// 单个字体文件的下载总时限(含读正文)。`connectionTimeout` 只管建连,
/// 服务器发完响应头后停住时 `await for` 会永远挂住,构建无声卡死。
const _downloadTimeout = Duration(seconds: 60);

/// 字体下载失败(无网络且本地缓存里没有)。
class FontFetchFailure implements Exception {
  final String url;
  final String reason;
  const FontFetchFailure(this.url, this.reason);

  String get message =>
      '回退字体下载失败:$url\n'
      '$reason\n'
      '字体只在首次构建时下载,之后走本地缓存(${defaultFontCacheDir()})。\n'
      '请检查网络或代理(会读取 HTTPS_PROXY / HTTP_PROXY 环境变量;不支持 ALL_PROXY/socks)后重试。';

  @override
  String toString() => 'FontFetchFailure: $message';
}

/// 从 `main.dart.js` 里抽出引擎内置的回退字体相对路径(如
/// `roboto/v32/KFOm....woff2`),只保留 [families] 里的家族。
///
/// 路径从产物里抽而不是写死:字体版本号(`v32`、`v37`)随 Flutter 版本变,
/// 写死的列表会在升级后静默失配。
List<String> extractFallbackFontPaths(
  String mainDartJs, {
  List<String> families = kDefaultFontFamilies,
}) {
  final re = RegExp(r'"([a-z0-9]+/v\d+/[A-Za-z0-9_\-]+(?:\.\d+)?\.woff2)"');
  final out = <String>{};
  for (final m in re.allMatches(mainDartJs)) {
    final path = m.group(1)!;
    if (families.contains(path.split('/').first)) out.add(path);
  }
  return out.toList()..sort();
}

String defaultFontCacheDir() {
  final xdg = Platform.environment['XDG_CACHE_HOME'];
  final home =
      Platform.environment['HOME'] ??
      Platform.environment['USERPROFILE'] ??
      '.';
  return p.join(xdg ?? p.join(home, '.cache'), 'mp_flutter', 'fonts');
}

/// 取齐 [paths] 对应的字体文件:缓存命中直接读,否则从 [baseUrl] 下载并落缓存。
///
/// 返回 `mp-fonts/<相对路径>` → 字节,可直接并入资源管线。
Future<Map<String, List<int>>> fetchFallbackFonts(
  List<String> paths, {
  String? cacheDir,
  String baseUrl = 'https://fonts.gstatic.com/s/',
}) async {
  final dir = cacheDir ?? defaultFontCacheDir();
  final out = <String, List<int>>{};
  HttpClient? client;
  try {
    for (final rel in paths) {
      final cached = File(p.join(dir, rel));
      // 缓存里的坏文件(比如代理返回 200 的 HTML 页)会被永久命中,
      // Roboto 解码失败同样让引擎启动即崩——命中也要校验,坏了删掉重下
      if (cached.existsSync() && !_isWoff2(cached.readAsBytesSync())) {
        cached.deleteSync();
      }
      if (!cached.existsSync()) {
        client ??= HttpClient()
          ..findProxy = HttpClient.findProxyFromEnvironment
          ..connectionTimeout = const Duration(seconds: 20);
        final url = '$baseUrl$rel';
        final bytes = await _download(client, url).timeout(
          _downloadTimeout,
          onTimeout: () => throw FontFetchFailure(
            url,
            '下载超时(${_downloadTimeout.inSeconds}s)',
          ),
        );
        if (!_isWoff2(bytes)) {
          throw FontFetchFailure(url, '返回内容不是 woff2 字体(可能是代理/登录页),未写入缓存');
        }
        cached.parent.createSync(recursive: true);
        // 先写临时文件再改名:下载中断不会在缓存里留下半个字体;
        // 临时名带 pid,并发构建不会互相截断
        final tmp = File('${cached.path}.$pid.part')..writeAsBytesSync(bytes);
        tmp.renameSync(cached.path);
      }
      out['$kFontPrefix$rel'] = cached.readAsBytesSync();
    }
  } finally {
    client?.close(force: true);
  }
  return out;
}

Future<List<int>> _download(HttpClient client, String url) async {
  try {
    final req = await client.getUrl(Uri.parse(url));
    final res = await req.close();
    if (res.statusCode != 200) {
      throw FontFetchFailure(url, 'HTTP ${res.statusCode}');
    }
    final b = BytesBuilder(copy: false);
    await for (final chunk in res) {
      b.add(chunk);
    }
    return b.takeBytes();
  } on FontFetchFailure {
    rethrow;
  } on Exception catch (e) {
    throw FontFetchFailure(url, '$e');
  }
}

/// 引擎回退字体表在 Flutter SDK 里的位置(相对 SDK 根)。
const kFontFallbackDataPath =
    'bin/cache/flutter_web_sdk/lib/_engine/engine/font_fallback_data.dart';

/// 从 flutter 可执行文件路径反推 SDK 根;裸命令名时沿 PATH 查找。找不到返回 null。
String? flutterRootFromBin(String flutterBin) {
  String? bin = flutterBin;
  if (!flutterBin.contains(Platform.pathSeparator)) {
    bin = null;
    final sep = Platform.isWindows ? ';' : ':';
    for (final dir in (Platform.environment['PATH'] ?? '').split(sep)) {
      if (dir.isEmpty) continue;
      final c = File(p.join(dir, flutterBin));
      if (c.existsSync()) {
        bin = c.resolveSymbolicLinksSync();
        break;
      }
    }
    if (bin == null) return null;
  }
  return p.dirname(p.dirname(p.normalize(p.absolute(bin))));
}

/// 给回退字体分片算排序值,按它依次装箱,让"一起被用到"的分片落进同一个
/// 按需分包。
///
/// 数据来自 SDK 里引擎自带的回退字体表(`font_fallback_data.dart` 的
/// `getFallbackFontList` / `encodedFontSets` / `encodedFontSetRanges`,解码
/// 算法照搬 `font_fallbacks.dart` 的 `_decodeFontSet` 与
/// `_UnicodePropertyLookup.fromPackedData`)。notosanssc 的 101 个分片解出来
/// 分两类,特征泾渭分明(3.41.9 实测 CJK 区码点标准差:前者 60–150,后者
/// 约 4000–6300):
///  · **码位段分片**(引擎编号约 3–76):各覆盖一段连续码位,多是生僻字。
///    按覆盖码点的**中位数**排序 → 码位相近的分到同一个包("码位邻近分组");
///  · **常用字分片**(引擎编号 77–96,Google 文件名 .100–.119):每片约 190 个
///    高频字,码位散布整个 CJK 区,中位数和码位段分片混在一起。若也按中位数
///    排,常用字分片会和生僻字分片交错装箱,一段普通中文就要拉 4–6 个包。
///    所以它们排在最前、保持引擎顺序,聚成"常用字"几个包。
///
/// 用一个真实电商小程序的界面文案(833 个不同汉字)按引擎的贪心选字体算法模拟:纯中位数
/// 分组要下载 4/7 个包(1.92MB),常用字优先 + 码位邻近分组只要 2/7(0.95MB)。
///
/// 返回 `mp-fonts/<相对路径>` → 排序值(小的在前)。数据文件不存在或格式变了
/// 返回空表(调用方退回按路径排序,只影响分组质量,不影响正确性)。
Map<String, num> fallbackFontCodepointRank(String? flutterRoot) {
  if (flutterRoot == null) return const {};
  final f = File(p.join(flutterRoot, kFontFallbackDataPath));
  if (!f.existsSync()) return const {};
  try {
    return decodeFallbackFontRank(f.readAsStringSync());
  } catch (_) {
    return const {};
  }
}

const _cjkStart = 0x3400;
const _cjkEnd = 0xA000;

/// CJK 码点标准差超过它即视为"散布全区"的常用字分片。3.41.9 实测:码位段
/// 分片 ≤150,常用字分片 3975–6354;另有一个兼容区/扩展 A 的杂项分片(引擎
/// 编号 67)约 2550,不属于常用字,阈值取 3000 把它留在码位段一侧。
const _scatteredSdThreshold = 3000;

/// [fallbackFontCodepointRank] 的纯函数部分(便于单测)。
Map<String, num> decodeFallbackFontRank(String src) {
  final fonts = [
    for (final m in RegExp(
      r"NotoFont\(\s*'([^']*)',\s*'([^']*)',?\s*\)",
    ).allMatches(src))
      m.group(2)!,
  ];
  String constant(String name) {
    final i = src.indexOf('const String $name =');
    if (i < 0) throw const FormatException('missing constant');
    final body = src.substring(i, src.indexOf(';', i));
    final b = StringBuffer();
    for (final line in body.split('\n').skip(1)) {
      final m = RegExp(r"^\s*'([^']*)'").firstMatch(line);
      if (m != null) b.write(m.group(1));
    }
    return b.toString();
  }

  final sets = constant('encodedFontSets');
  final ranges = constant('encodedFontSetRanges');
  final components = <List<int>>[];
  for (final cd in sets.split(',')) {
    final res = <int>[];
    var prev = -1, prefix = 0;
    for (final c in cd.codeUnits) {
      if (c >= 97 && c < 123) {
        final idx = prev + prefix * 26 + (c - 97) + 1;
        res.add(idx);
        prev = idx;
        prefix = 0;
      } else if (c >= 48 && c < 58) {
        prefix = prefix * 10 + (c - 48);
      } else {
        throw const FormatException('bad font set');
      }
    }
    components.add(res);
  }
  // 每个字体覆盖的 [start, end) 区间
  final cover = <int, List<(int, int)>>{};
  var start = 0, prefix = 0, size = 1;
  for (final c in ranges.codeUnits) {
    if (c >= 65 && c < 91) {
      final idx = prefix * 26 + (c - 65);
      for (final f in components[idx]) {
        (cover[f] ??= []).add((start, start + size));
      }
      start += size;
      prefix = 0;
      size = 1;
    } else if (c >= 97 && c < 123) {
      size = prefix * 26 + (c - 97) + 2;
      prefix = 0;
    } else if (c >= 48 && c < 58) {
      prefix = prefix * 10 + (c - 48);
    } else {
      throw const FormatException('bad range');
    }
  }
  final out = <String, num>{};
  cover.forEach((fontIndex, spans) {
    if (fontIndex >= fonts.length) return;
    final total = spans.fold<int>(0, (n, s) => n + (s.$2 - s.$1));
    if (total == 0) return;
    // CJK 区(U+3400–U+9FFF)内覆盖码点的标准差:散布全区的是常用字分片
    var n = 0;
    var sum = 0.0, sumSq = 0.0;
    for (final (a0, b0) in spans) {
      final a = a0 < _cjkStart ? _cjkStart : a0;
      final b = b0 > _cjkEnd ? _cjkEnd : b0;
      for (var x = a; x < b; x++) {
        n++;
        sum += x;
        sumSq += x.toDouble() * x;
      }
    }
    final sd = n > 1 ? sqrt((sumSq / n - (sum / n) * (sum / n)).abs()) : 0.0;
    final key = '$kFontPrefix${fonts[fontIndex]}';
    if (sd > _scatteredSdThreshold) {
      out[key] = -1000000 + fontIndex; // 常用字分片:最前,保持引擎顺序
      return;
    }
    // 中位数:走到第 total/2 个码点
    var remaining = total ~/ 2;
    for (final (a, b) in spans) {
      if (remaining < b - a) {
        out[key] = a + remaining;
        break;
      }
      remaining -= b - a;
    }
  });
  return out;
}

/// 远端字体分片在产物里的待上传目录(相对产物根)。不属于小程序代码包,
/// project.config.json 的 packOptions.ignore 会把它排除在预览/上传之外。
const kRemoteFontDir = 'mp-fonts-remote';

/// 校验并规范化 `font_base_url`:必须是 https(真机 wx.request 只允许
/// https 合法域名),末尾补 `/`。不合法抛 [FormatException]。
String normalizeFontBaseUrl(String url) {
  final u = url.trim();
  final uri = Uri.tryParse(u);
  if (uri == null || uri.scheme != 'https' || uri.host.isEmpty) {
    throw FormatException(
      'font_base_url 必须是 https:// 开头的完整 URL'
      '(真机 wx.request 只允许后台配置过的 https 合法域名),实际是:$url',
    );
  }
  if (uri.hasQuery || uri.hasFragment) {
    throw FormatException(
      'font_base_url 不能带查询串或 #片段(运行时直接在后面拼字体相对路径),实际是:$url',
    );
  }
  return u.endsWith('/') ? u : '$u/';
}
