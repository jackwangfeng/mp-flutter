import 'dart:convert';
import 'package:test/test.dart';
import 'package:flutter_miniprogram/src/emit_project.dart';
import 'package:flutter_miniprogram/src/config.dart';
import '../bin/flutter_miniprogram.dart';
import 'package:flutter_miniprogram/src/pipeline.dart';

void main() {
  test(
    'platform YAML is validated and invalid CLI platform fails early',
    () async {
      final config = loadConfig(
        '/app',
        fileExists: (_) => true,
        readFile: (_) => 'platform: douyin\ncjk_font: false\n',
      );
      expect(config.targetPlatform, 'douyin');
      expect(config.cjkFont, 'false');
      expect(
        () => loadConfig(
          '/app',
          fileExists: (_) => true,
          readFile: (_) => 'platform: unknown',
        ),
        throwsA(isA<ConfigParseFailure>()),
      );
      final error = StringBuffer();
      expect(await runCli(['--platform', 'unknown'], stderrSink: error), 64);
    },
  );
  test('Douyin emits TT templates and asynchronous common packages', () {
    final files = emitProject(
      appId: 'tt123',
      targetPlatform: 'douyin',
      subPackageRoots: const ['pkg-wasm', 'pkg-dart'],
      entryPagePath: 'pages/flutter/flutter',
    ).textFiles;
    final app = jsonDecode(files['app.json']!) as Map;
    expect(app['subpackages'], [
      {'root': 'pkg-wasm', 'pages': [], 'common': true},
      {'root': 'pkg-dart', 'pages': [], 'common': true},
    ]);
    expect(app['window']['navigationStyle'], 'default');
    expect(app.containsKey('subPackages'), false);
    expect(app.containsKey('sitemapLocation'), false);
    expect(app.containsKey('lazyCodeLoading'), false);
    expect(
      jsonDecode(files['project.config.json']!)['douyinProjectType'],
      'native',
    );
    expect(files['pages/flutter/flutter.ttml'], contains('tt:if'));
    expect(files['pages/flutter/flutter.ttml'], isNot(contains('<map')));
    expect(
      files.keys.any((key) => key.endsWith('.wxml') || key.endsWith('.wxss')),
      false,
    );
    expect(files.keys, contains('pages/flutter/flutter.ttss'));
    expect(files.keys, isNot(contains('sitemap.json')));
  });
  test(
    'Douyin host page selects explicit host and disables native image path',
    () {
      final js = buildHostPageJs(targetPlatform: 'douyin', verify: true);
      expect(js, contains("getHost('douyin')"));
      expect(js, contains("__mpHost.selectCanvas('#flutter-canvas'"));
      expect(js, contains('host: __mpHost'));
      expect(js, contains('nativeImage: false'));
      expect(js, contains("menus: ['share']"));
      expect(js, isNot(contains("menus: ['shareAppMessage'")));
    },
  );
}
