import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';
import 'package:flutter_miniprogram/src/fonts.dart';

// 合法 woff2 头 + 若干字节
const woff2 = [0x77, 0x4F, 0x46, 0x32, 1, 2, 3];

void main() {
  group('extractFallbackFontPaths', () {
    const js = 'x="roboto/v32/KFOmCnqEu92Fr1Me4GZLCzYlKw.woff2",'
        'y="notosanssc/v37/k3kCo84M.4.woff2",z="notosansjp/v53/abc.1.woff2",'
        'w="notosanssc/v37/k3kCo84M.5.woff2",dup="roboto/v32/KFOmCnqEu92Fr1Me4GZLCzYlKw.woff2"';

    test('只保留默认家族(roboto + 简体中文),去重排序', () {
      expect(extractFallbackFontPaths(js), [
        'notosanssc/v37/k3kCo84M.4.woff2',
        'notosanssc/v37/k3kCo84M.5.woff2',
        'roboto/v32/KFOmCnqEu92Fr1Me4GZLCzYlKw.woff2',
      ]);
    });

    test('版本号从产物里抽,不写死(升级后 v33 也能认)', () {
      expect(extractFallbackFontPaths('"roboto/v33/New.woff2"'), ['roboto/v33/New.woff2']);
    });
  });

  group('fetchFallbackFonts', () {
    late Directory cache;
    late HttpServer server;
    late int hits;
    setUp(() async {
      cache = Directory.systemTemp.createTempSync('mpf_font_cache_');
      hits = 0;
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) {
        hits++;
        if (req.uri.path.endsWith('missing.woff2')) {
          req.response.statusCode = 404;
        } else if (req.uri.path.endsWith('portal.woff2')) {
          req.response.add('<html>请先登录</html>'.codeUnits);
        } else {
          req.response.add(woff2);
        }
        req.response.close();
      });
    });
    tearDown(() async {
      await server.close(force: true);
      cache.deleteSync(recursive: true);
    });
    String base() => 'http://127.0.0.1:${server.port}/s/';

    test('首次下载并落缓存;key 带 mp-fonts/ 前缀', () async {
      final r = await fetchFallbackFonts(['roboto/v32/a.woff2'],
          cacheDir: cache.path, baseUrl: base());
      expect(r, {'${kFontPrefix}roboto/v32/a.woff2': woff2});
      expect(File(p.join(cache.path, 'roboto/v32/a.woff2')).existsSync(), isTrue);
    });

    test('缓存命中时不再联网', () async {
      final cached = [...woff2, 9];
      File(p.join(cache.path, 'roboto/v32/a.woff2'))
        ..createSync(recursive: true)
        ..writeAsBytesSync(cached);
      final r = await fetchFallbackFonts(['roboto/v32/a.woff2'],
          cacheDir: cache.path, baseUrl: base());
      expect(r.values.single, cached);
      expect(hits, 0);
    });

    test('返回 200 但不是 woff2(代理/登录页):报错且不写缓存', () async {
      await expectLater(
        fetchFallbackFonts(['roboto/v32/portal.woff2'], cacheDir: cache.path, baseUrl: base()),
        throwsA(isA<FontFetchFailure>().having((e) => e.message, 'message', contains('woff2'))),
      );
      expect(cache.listSync(recursive: true).whereType<File>(), isEmpty);
    });

    test('缓存里的坏文件会被删掉重下,而不是被永久命中', () async {
      File(p.join(cache.path, 'roboto/v32/a.woff2'))
        ..createSync(recursive: true)
        ..writeAsStringSync('<html>');
      final r = await fetchFallbackFonts(['roboto/v32/a.woff2'],
          cacheDir: cache.path, baseUrl: base());
      expect(r.values.single, woff2);
      expect(hits, 1);
    });

    test('下载失败抛 FontFetchFailure 带出 URL,且不在缓存里留半个文件', () async {
      await expectLater(
        fetchFallbackFonts(['roboto/v32/missing.woff2'], cacheDir: cache.path, baseUrl: base()),
        throwsA(isA<FontFetchFailure>()
            .having((e) => e.message, 'message', allOf(contains('missing.woff2'), contains('404')))),
      );
      expect(cache.listSync(recursive: true).whereType<File>(), isEmpty);
    });
  });
  group('decodeFallbackFontRank(回退字体分片的码位中位数)', () {
    // 合成的最小字体表:font0 覆盖 U+4E00..U+4E0F,font1 覆盖 U+9000..U+900F
    const src = """
List<NotoFont> getFallbackFontList() => <NotoFont>[
  NotoFont(
    'Noto Sans SC 0',
    'notosanssc/v37/s.0.woff2',
  ),
  NotoFont('Noto Sans SC 1', 'notosanssc/v37/s.1.woff2'),
  NotoFont('Noto Sans SC 2', 'notosanssc/v37/s.2.woff2'),
];
const String encodedFontSets =
    // #0: 0 fonts.
    ','
    // #1
    'a,'
    'b,'
    'c'
    ;
const String encodedFontSetRanges =
    '767yA' // 0-4dff
    'oB' // 4e00-4e0f
    'D' // 4e10:font2
    '649dA' // gap
    'oC' // 9000-900f
    'lA' // 9010-901c
    'D' // 901d:font2(与 4e10 相距很远:散布型)
    ;
""";
    test('按引擎的编码格式解出每个分片覆盖码点的中位数', () {
      final r = decodeFallbackFontRank(src);
      expect(r['mp-fonts/notosanssc/v37/s.0.woff2'], 0x4E08);
      expect(r['mp-fonts/notosanssc/v37/s.1.woff2'], 0x9008);
    });

    test('码位散布整个 CJK 区的(常用字)分片排在最前,保持引擎顺序', () {
      final r = decodeFallbackFontRank(src);
      expect(r['mp-fonts/notosanssc/v37/s.2.woff2'], lessThan(0));
      final order = r.keys.toList()..sort((a, b) => r[a]!.compareTo(r[b]!));
      expect(order, ['mp-fonts/notosanssc/v37/s.2.woff2', 'mp-fonts/notosanssc/v37/s.0.woff2',
          'mp-fonts/notosanssc/v37/s.1.woff2']);
    });

    test('SDK 不存在或格式不对:返回空表(调用方按路径排序)', () {
      expect(fallbackFontCodepointRank(null), isEmpty);
      expect(fallbackFontCodepointRank('/nonexistent/sdk'), isEmpty);
    });

    final sdk = Platform.environment['FLUTTER_ROOT'] ?? p.join(Platform.environment['HOME'] ?? '', 'development/flutter');
    test('真实 SDK(3.41.9):notosanssc 101 个分片都有排名,生僻字分片按码位单调', () {
      final r = fallbackFontCodepointRank(sdk);
      final sc = r.keys.where((k) => k.contains('notosanssc/')).toList();
      expect(sc, hasLength(101));
      // 常用字分片(Google 文件名 .100–.119)共 20 个,排名为负、排在最前
      final hot = sc.where((k) => r[k]! < 0).toList();
      expect(hot, hasLength(20));
      expect(hot.every((k) => RegExp(r'\.1[01]\d\.woff2$').hasMatch(k)), isTrue, reason: '$hot');
    }, skip: File(p.join(sdk, kFontFallbackDataPath)).existsSync() ? false : '本机没有 Flutter SDK');
  });

  group('normalizeFontBaseUrl', () {
    test('末尾补 /', () {
      expect(normalizeFontBaseUrl('https://cdn.x.com/fonts'), 'https://cdn.x.com/fonts/');
      expect(normalizeFontBaseUrl('https://cdn.x.com/fonts/'), 'https://cdn.x.com/fonts/');
    });
    test('非 https、缺主机、带查询串:拒绝', () {
      for (final bad in ['http://cdn.x.com/', 'cdn.x.com/f', 'https:///f', 'https://c.com/f?v=1']) {
        expect(() => normalizeFontBaseUrl(bad), throwsFormatException, reason: bad);
      }
    });
  });
}
