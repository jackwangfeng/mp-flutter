import 'package:test/test.dart';
import 'package:flutter_miniprogram/src/version_matrix.dart';

const _stableOutput = '''
Flutter 3.41.9 • channel stable • https://github.com/flutter/flutter.git
Framework • revision 00b0c91f06 (5 months ago) • 2026-04-29 10:03:19 -0700
Tools • Dart 3.11.5 • DevTools 2.54.2
''';

const _ohosOutput = '''
Flutter 3.41.10-ohos-0.0.2-beta • channel [user-branch] • https://gitcode.com/openharmony-sig/flutter_flutter.git
Framework • revision 1a8a1745c0 (3 months ago) • 2026-07-04 10:01:57 +0800
Tools • Dart 3.11.5 • DevTools 2.54.1
''';

void main() {
  test('从 flutter --version 输出解析 stable 版本', () {
    final v = FlutterVersion.parse(_stableOutput);
    expect(v.version, '3.41.9');
    expect(v.isOhosFork, isFalse);
  });

  test('识别 flutter_ohos fork', () {
    final v = FlutterVersion.parse(_ohosOutput);
    expect(v.version, '3.41.10-ohos-0.0.2-beta');
    expect(v.isOhosFork, isTrue);
  });

  test('支持的版本通过校验', () {
    expect(() => VersionMatrix.check(FlutterVersion.parse(_stableOutput)), returnsNormally);
    expect(() => VersionMatrix.check(FlutterVersion.parse(_ohosOutput)), returnsNormally);
  });

  test('不支持的版本抛出,且错误信息列出受支持版本', () {
    final v = const FlutterVersion('3.35.0');
    expect(
      () => VersionMatrix.check(v),
      throwsA(isA<UnsupportedFlutterVersion>().having(
        (e) => e.message, 'message', allOf(contains('3.35.0'), contains('3.41.9')))),
    );
  });

  test('解析不出版本号时抛出而非返回空串', () {
    expect(() => FlutterVersion.parse('garbage'), throwsA(isA<FormatException>()));
  });

  test('stable 版本无已知分叉差异', () {
    final v = FlutterVersion.parse(_stableOutput);
    final divergences = VersionMatrix.knownDivergences(v);
    expect(divergences, isEmpty);
  });

  test('ohos 版本包含 shader 分叉差异', () {
    final v = FlutterVersion.parse(_ohosOutput);
    final divergences = VersionMatrix.knownDivergences(v);
    expect(divergences, hasLength(1));
    expect(divergences.first.id, 'missing_material_shaders');
    expect(divergences.first.description, contains('Material shaders'));
    expect(divergences.first.consequence, contains('取不到'));
  });

  test('不支持的版本查询差异时返回空列表', () {
    final v = const FlutterVersion('3.35.0');
    final divergences = VersionMatrix.knownDivergences(v);
    expect(divergences, isEmpty);
  });
}

