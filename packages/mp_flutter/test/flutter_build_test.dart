import 'package:test/test.dart';
import 'package:flutter_miniprogram/src/flutter_build.dart';

void main() {
  group('flutterSdkFromPackageConfig(D1)—— 从 package_config.json 反推 flutter SDK', () {
    String pkgConfig(String flutterRootUri) => '''
{
  "configVersion": 2,
  "packages": [
    {"name": "flutter", "rootUri": "$flutterRootUri", "packageUri": "lib/"},
    {"name": "path", "rootUri": "file:///opt/pub-cache/path-1.0.0", "packageUri": "lib/"}
  ]
}
''';

    test('rootUri 是 file:// 绝对 URI:反推出 <sdk>', () {
      final sdk = flutterSdkFromPackageConfig(
        '/repo/app',
        fileExists: (path) => path == '/repo/app/.dart_tool/package_config.json',
        readFile: (_) => pkgConfig('file:///opt/flutter-sdk/packages/flutter'),
      );
      expect(sdk, '/opt/flutter-sdk');
    });

    test('package_config.json 不存在:返回 null', () {
      final sdk = flutterSdkFromPackageConfig('/repo/app', fileExists: (_) => false);
      expect(sdk, isNull);
    });

    test('不是合法 JSON:返回 null,不抛异常', () {
      final sdk = flutterSdkFromPackageConfig(
        '/repo/app',
        fileExists: (_) => true,
        readFile: (_) => 'not json at all',
      );
      expect(sdk, isNull);
    });

    test('packages 里没有 name=="flutter" 的项:返回 null', () {
      final sdk = flutterSdkFromPackageConfig(
        '/repo/app',
        fileExists: (_) => true,
        readFile: (_) => '{"packages": [{"name": "path", "rootUri": "file:///x"}]}',
      );
      expect(sdk, isNull);
    });

    test('rootUri 形状不是 <sdk>/packages/flutter(比如本地 path 依赖覆盖):返回 null,不强猜', () {
      final sdk = flutterSdkFromPackageConfig(
        '/repo/app',
        fileExists: (_) => true,
        readFile: (_) => pkgConfig('file:///somewhere/else/my_flutter_fork'),
      );
      expect(sdk, isNull);
    });
  });

  group('resolveFlutterBin(D1)—— 双 SDK 一致性', () {
    test('无 override、无 projectPath:退回旧的探测顺序(不碰 package_config)', () {
      final bin = resolveFlutterBin(null);
      expect(bin, isNotEmpty);
    });

    test('无 override、projectPath 能反推出 SDK:优先用该 SDK 的 bin/flutter', () {
      final bin = resolveFlutterBin(
        null,
        projectPath: '/repo/app',
        fileExists: (path) => path == '/repo/app/.dart_tool/package_config.json',
        readFile: (_) => '''
{"packages": [{"name": "flutter", "rootUri": "file:///sdk/flutter/packages/flutter"}]}
''',
      );
      expect(bin, '/sdk/flutter/bin/flutter');
    });

    test('显式 override 与 package_config 推出的 SDK 一致:直接返回 override', () {
      final bin = resolveFlutterBin(
        '/sdk/flutter/bin/flutter',
        projectPath: '/repo/app',
        fileExists: (path) => path == '/repo/app/.dart_tool/package_config.json',
        readFile: (_) => '''
{"packages": [{"name": "flutter", "rootUri": "file:///sdk/flutter/packages/flutter"}]}
''',
      );
      expect(bin, '/sdk/flutter/bin/flutter');
    });

    test('显式 override 与 package_config 推出的 SDK 不一致:抛 FlutterSdkMismatch', () {
      expect(
        () => resolveFlutterBin(
          '/sdk/flutter_ohos/bin/flutter',
          projectPath: '/repo/app',
          fileExists: (path) => path == '/repo/app/.dart_tool/package_config.json',
          readFile: (_) => '''
{"packages": [{"name": "flutter", "rootUri": "file:///sdk/flutter_stable/packages/flutter"}]}
''',
        ),
        throwsA(isA<FlutterSdkMismatch>()),
      );
    });

    test('FlutterSdkMismatch 消息带出两个 SDK,并提示先 pub get', () {
      const e = FlutterSdkMismatch('/a/bin/flutter', '/b/bin/flutter');
      expect(e.message, allOf(contains('/a/bin/flutter'), contains('/b/bin/flutter'),
          contains('pub get')));
    });

    test('override 是裸命令名(不含路径分隔符):跳过一致性校验,直接返回', () {
      final bin = resolveFlutterBin(
        'flutter',
        projectPath: '/repo/app',
        fileExists: (path) => path == '/repo/app/.dart_tool/package_config.json',
        readFile: (_) => '''
{"packages": [{"name": "flutter", "rootUri": "file:///sdk/flutter_stable/packages/flutter"}]}
''',
      );
      expect(bin, 'flutter');
    });

    test('projectPath 反推不出 SDK(没跑过 pub get):退回旧探测顺序,不报错', () {
      final bin = resolveFlutterBin(
        null,
        projectPath: '/repo/app',
        fileExists: (_) => false,
      );
      expect(bin, isNotEmpty);
    });
  });


  test('FlutterBuildFailure 原样透出 Flutter 的 stderr', () {
    const f = FlutterBuildFailure(1, 'Target dart2js failed: ...');
    expect(f.message, contains('Target dart2js failed'));
  });

  test('错误信息提示"该工程需先支持 web target"', () {
    const f = FlutterBuildFailure(1, 'whatever');
    expect(f.message, contains('web'));
  });

  group('用户工程本身构建失败时必须可诊断', () {
    test('原样保留 Flutter 的错误文本,不吞不改写', () {
      const raw = "Error: Dart library 'dart:io' is not available on this platform.";
      const f = FlutterBuildFailure(1, raw);
      expect(f.message, contains(raw), reason: 'Flutter 的原始错误必须原样透出');
    });

    test('提示指向用户工程而非 flutter_miniprogram', () {
      const f = FlutterBuildFailure(1, 'anything');
      expect(f.message, contains('flutter build web --release'),
          reason: '应给出用户可自行复现的命令');
      expect(f.message, anyOf(contains('dart:io'), contains('platform channel'), contains('插件')),
          reason: '应列出常见原因');
    });

    test('构建声称成功但产物缺失也报同一类错误', () {
      const f = FlutterBuildFailure(0, 'flutter build web 声称成功,但 build/web 不存在');
      expect(f.message, contains('不存在'));
      expect(f.exitCode, 0);
    });

    test('退出码在 CLI 中与其他失败类型区分', () {
      // 版本不支持=3,构建失败=4,变换失败=5 —— 便于 CI 按类型分流
      const f = FlutterBuildFailure(1, 'x');
      expect(f.exitCode, isNot(3));
    });
  });

  group('buildFlutterBuildArgs —— flutter build web 参数构造(不真的跑 flutter)', () {
    test('默认(release):--release -O4', () {
      final args = buildFlutterBuildArgs(profile: false);
      expect(args, ['build', 'web', '--release', '-O4']);
    });

    test('target:-t <入口> 紧跟优化参数(K1 入口包装)', () {
      final args = buildFlutterBuildArgs(
          profile: false, target: '.dart_tool/flutter_miniprogram/entrypoint.dart', dartDefines: ['A=1']);
      expect(args, ['build', 'web', '--release', '-O4',
        '-t', '.dart_tool/flutter_miniprogram/entrypoint.dart', '--dart-define=A=1']);
    });

    test('profile:--profile -O1', () {
      final args = buildFlutterBuildArgs(profile: true);
      expect(args, ['build', 'web', '--profile', '-O1']);
    });

    test('单个 dart-define:作为单独一个 list 元素追加', () {
      final args = buildFlutterBuildArgs(profile: false, dartDefines: ['API_HOST=x']);
      expect(args, ['build', 'web', '--release', '-O4', '--dart-define=API_HOST=x']);
    });

    test('多个 dart-define(含重复 KEY,由调用方决定去重):按传入顺序原样透出', () {
      final args = buildFlutterBuildArgs(
        profile: false,
        dartDefines: ['A=1', 'B=2', 'A=1'],
      );
      expect(args, [
        'build', 'web', '--release', '-O4',
        '--dart-define=A=1',
        '--dart-define=B=2',
        '--dart-define=A=1',
      ]);
    });

    test('VALUE 含逗号:不被拆成多个参数,原样进同一个 --dart-define= 元素', () {
      final args = buildFlutterBuildArgs(profile: false, dartDefines: ['LIST=a,b,c']);
      expect(args.length, 5);
      expect(args.last, '--dart-define=LIST=a,b,c');
    });

    test('VALUE 含等号:原样透出,不被二次切分', () {
      final args = buildFlutterBuildArgs(profile: false, dartDefines: ['TOKEN=a=b=c']);
      expect(args.last, '--dart-define=TOKEN=a=b=c');
    });

    test('dart-define-from-file:作为独立参数追加在最后', () {
      final args = buildFlutterBuildArgs(
        profile: false,
        dartDefines: ['A=1'],
        dartDefineFromFile: '/abs/path/defines.env',
      );
      expect(args, [
        'build', 'web', '--release', '-O4',
        '--dart-define=A=1',
        '--dart-define-from-file=/abs/path/defines.env',
      ]);
    });

    test('都不传 dart-define 相关参数:参数列表与旧版一致(不多不少)', () {
      final args = buildFlutterBuildArgs(profile: true);
      expect(args, ['build', 'web', '--profile', '-O1']);
    });
  });
}
