import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:test/test.dart';

import '../bin/mp_flutter.dart';
import 'package:mp_flutter/src/doctor.dart';
import 'package:mp_flutter/src/size_check.dart';

void main() {
  group('runCli —— 参数/退出码(不碰真实文件系统外的东西,不联网)', () {
    test('--help:退出码 0,打印用法', () async {
      final out = StringBuffer();
      final code = await runCli(['--help'], stdoutSink: out);
      expect(code, 0);
      expect(out.toString(), contains('mp_flutter'));
    });

    test('--version:退出码 0,打印包版本号', () async {
      final out = StringBuffer();
      final code = await runCli(['--version'], stdoutSink: out);
      expect(code, 0);
      expect(out.toString().trim(), kPackageVersion);
    });

    test('未知参数:退出码 64,提示错误', () async {
      final err = StringBuffer();
      final code = await runCli(['--not-a-real-flag'], stderrSink: err);
      expect(code, 64);
      expect(err.toString(), contains('参数错误'));
    });

    test('--force-platform 不与 --verify 同用:退出码 64', () async {
      final err = StringBuffer();
      final code =
          await runCli(['--force-platform', 'ios', '--project', '.'], stderrSink: err);
      expect(code, 64);
      expect(err.toString(), contains('--force-platform'));
    });
  });

  group('runCli —— 工程根探测', () {
    test('显式 --project:直接使用该路径,不做向上探测(旧用法不变)', () async {
      late String seenProjectPath;
      final out = StringBuffer();
      final code = await runCli(
        ['--project', '/explicit/path/does/not/need/pubspec', '--output', 'o'],
        stdoutSink: out,
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenProjectPath = projectPath;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenProjectPath, '/explicit/path/does/not/need/pubspec');
    });

    test('缺省 --project 且向上找不到工程根:退出码 64,不调用 pipeline', () async {
      final tmp = Directory.systemTemp.createTempSync('mpf_cli_no_project_');
      addTearDown(() => tmp.deleteSync(recursive: true));
      var pipelineCalled = false;
      final err = StringBuffer();
      final code = await runCli(
        [],
        stderrSink: err,
        currentDir: () => tmp.path,
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          pipelineCalled = true;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 64);
      expect(err.toString(), contains('找不到 Flutter 工程根'));
      expect(pipelineCalled, isFalse);
    });

    test('缺省 --project:从子目录向上找到工程根', () async {
      final tmp = Directory.systemTemp.createTempSync('mpf_cli_project_root_');
      addTearDown(() => tmp.deleteSync(recursive: true));
      final projectDir = Directory(p.join(tmp.path, 'my_app'))..createSync(recursive: true);
      File(p.join(projectDir.path, 'pubspec.yaml'))
          .writeAsStringSync('name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\n');
      final subDir = Directory(p.join(projectDir.path, 'lib', 'src'))..createSync(recursive: true);

      late String seenProjectPath;
      final code = await runCli(
        [],
        currentDir: () => subDir.path,
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenProjectPath = projectPath;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenProjectPath, projectDir.path);
    });

    test('缺省 --project,从子目录跑:默认输出路径锚定到工程根,不是 cwd', () async {
      final tmp = Directory.systemTemp.createTempSync('mpf_cli_default_output_anchor_');
      addTearDown(() => tmp.deleteSync(recursive: true));
      final projectDir = Directory(p.join(tmp.path, 'my_app'))..createSync(recursive: true);
      File(p.join(projectDir.path, 'pubspec.yaml'))
          .writeAsStringSync('name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\n');
      final subDir = Directory(p.join(projectDir.path, 'lib', 'src'))..createSync(recursive: true);

      String? seenOutput;
      final code = await runCli(
        [],
        currentDir: () => subDir.path,
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenOutput = outputPath;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenOutput, p.join(projectDir.path, 'build/weapp'));
    });
  });

  group('runCli —— --no-safe-area / mp_flutter.yaml 的 safe_area(I1)', () {
    late Directory tmp;
    late Directory projectDir;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('mpf_cli_safe_area_');
      projectDir = Directory(p.join(tmp.path, 'app'))..createSync(recursive: true);
      File(p.join(projectDir.path, 'pubspec.yaml'))
          .writeAsStringSync('name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    });
    tearDown(() => tmp.deleteSync(recursive: true));

    Future<int> runWithSafeArea(List<String> extraArgs,
        {required void Function(bool safeArea) onPipeline}) {
      return runCli(
        ['--project', projectDir.path, ...extraArgs],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          onPipeline(safeArea);
          return SizeReport(const {}, const []);
        },
      );
    }

    test('都不传:默认 true(安全区注入默认开)', () async {
      bool? seen;
      final code = await runWithSafeArea([], onPipeline: (v) => seen = v);
      expect(code, 0);
      expect(seen, isTrue);
    });

    test('--no-safe-area:传 false', () async {
      bool? seen;
      final code = await runWithSafeArea(['--no-safe-area'], onPipeline: (v) => seen = v);
      expect(code, 0);
      expect(seen, isFalse);
    });

    test('mp_flutter.yaml 的 safe_area: false:命令行不传时生效', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('safe_area: false\n');
      bool? seen;
      final code = await runWithSafeArea([], onPipeline: (v) => seen = v);
      expect(code, 0);
      expect(seen, isFalse);
    });

    test('命令行 --safe-area 显式传 true:优先于 yaml 的 false', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('safe_area: false\n');
      bool? seen;
      final code = await runWithSafeArea(['--safe-area'], onPipeline: (v) => seen = v);
      expect(code, 0);
      expect(seen, isTrue);
    });
  });

  group('runCli —— --target/-t / mp_flutter.yaml 的 target(M5)', () {
    late Directory tmp;
    late Directory projectDir;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('mpf_cli_target_');
      projectDir = Directory(p.join(tmp.path, 'app'))..createSync(recursive: true);
      File(p.join(projectDir.path, 'pubspec.yaml'))
          .writeAsStringSync('name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    });
    tearDown(() => tmp.deleteSync(recursive: true));

    Future<int> runWithTarget(List<String> extraArgs,
        {String Function()? currentDir, required void Function(String? target) onPipeline}) {
      return runCli(
        ['--project', projectDir.path, ...extraArgs],
        currentDir: currentDir,
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          onPipeline(target);
          return SizeReport(const {}, const []);
        },
      );
    }

    // target 原样透出(不在 CLI 侧提前拼接工程根):相对路径"锚定工程根,不是
    // cwd"这条语义,由唯一的下游解析点(entrypoint.dart 的 writeEntrypoint,
    // 或 --no-safe-area 时 flutter 子进程自己 workingDirectory=projectPath)
    // 保证——这里提前拼一次会在 --project 本身是相对路径时和下游拼接叠加,
    // 拼出错误路径(见下面"双重拼接"一测,对应一个已修复的真实 bug)。

    test('都不传:默认 lib/main.dart(原样透出,由下游相对工程根解析)', () async {
      String? seen;
      final code = await runWithTarget([], onPipeline: (v) => seen = v);
      expect(code, 0);
      expect(seen, 'lib/main.dart');
    });

    test('-t 显式传相对路径:原样透出', () async {
      String? seen;
      final code = await runWithTarget(
        ['-t', 'lib/custom_main.dart'],
        currentDir: () => tmp.path,
        onPipeline: (v) => seen = v,
      );
      expect(code, 0);
      expect(seen, 'lib/custom_main.dart');
    });

    test('mp_flutter.yaml 的 target:命令行不传时生效,同样原样透出', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml'))
          .writeAsStringSync('target: lib/from_yaml_main.dart\n');
      String? seen;
      final code = await runWithTarget([], onPipeline: (v) => seen = v);
      expect(code, 0);
      expect(seen, 'lib/from_yaml_main.dart');
    });

    test('--target 长参数名与 -t 等价', () async {
      String? seen;
      final code = await runWithTarget(
        ['--target', 'lib/other_main.dart'],
        onPipeline: (v) => seen = v,
      );
      expect(code, 0);
      expect(seen, 'lib/other_main.dart');
    });

    test('命令行显式传值:优先于 mp_flutter.yaml 的 target', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml'))
          .writeAsStringSync('target: lib/from_yaml_main.dart\n');
      String? seen;
      final code = await runWithTarget(
        ['-t', 'lib/from_cli_main.dart'],
        onPipeline: (v) => seen = v,
      );
      expect(code, 0);
      expect(seen, 'lib/from_cli_main.dart');
    });

    test('传绝对路径:原样使用', () async {
      String? seen;
      final code = await runWithTarget(
        ['-t', '/abs/other/main.dart'],
        onPipeline: (v) => seen = v,
      );
      expect(code, 0);
      expect(seen, '/abs/other/main.dart');
    });

    test('回归:显式 --project 传相对路径("..")时,target 不会被双重拼接', () async {
      // 曾经的真实 bug:CLI 侧用 anchorToProjectRoot 把 target 提前拼成
      // "../lib/main.dart"(相对 --project 的 ".."),又被 entrypoint.dart
      // 的 writeEntrypoint 按"相对工程根"再拼一次,拼出 "../../lib/main.dart"
      // 这种指向仓库外层目录的错误路径,导致 consumer_smoke_test.dart 在子
      // 目录里跑 `dart run mp_flutter --project ..` 直接构建失败
      // (Target file "../lib/main.dart" not found)。现在 target 原样透出,
      // 双重拼接的可能性从根上消除。
      String? seenProjectPath, seenTarget;
      final code = await runCli(
        ['--project', '..'],
        currentDir: () => p.join(projectDir.path, 'lib'),
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenProjectPath = projectPath;
          seenTarget = target;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenProjectPath, '..'); // 显式 --project:原样使用,旧行为不变
      expect(seenTarget, 'lib/main.dart'); // 不掺 ".." ,交给下游相对 ".." 解析
    });
  });

  group('runCli —— mp_flutter.yaml 优先级合并(命令行 > 配置文件 > 默认值)', () {
    late Directory tmp;
    late Directory projectDir;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('mpf_cli_config_');
      projectDir = Directory(p.join(tmp.path, 'app'))..createSync(recursive: true);
      File(p.join(projectDir.path, 'pubspec.yaml'))
          .writeAsStringSync('name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    });
    tearDown(() => tmp.deleteSync(recursive: true));

    test('配置文件提供值,命令行不传:采用配置文件的值', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('''
appid: wx-from-config
output: out-from-config
require_location: true
''');
      String? seenAppId, seenOutput;
      bool? seenRequireLocation;
      final code = await runCli(
        ['--project', projectDir.path],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenAppId = appId;
          seenOutput = outputPath;
          seenRequireLocation = requireLocation;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenAppId, 'wx-from-config');
      expect(seenOutput, p.join(projectDir.path, 'out-from-config'));
      expect(seenRequireLocation, isTrue);
    });

    test('命令行显式传值:命令行优先于配置文件', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('''
appid: wx-from-config
require_location: true
''');
      String? seenAppId;
      bool? seenRequireLocation;
      final code = await runCli(
        [
          '--project', projectDir.path,
          '--appid', 'wx-from-cli',
          '--no-require-location',
        ],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenAppId = appId;
          seenRequireLocation = requireLocation;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenAppId, 'wx-from-cli');
      expect(seenRequireLocation, isFalse);
    });

    test('都没传:落到内置默认值', () async {
      String? seenAppId, seenOutput;
      final code = await runCli(
        ['--project', projectDir.path],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenAppId = appId;
          seenOutput = outputPath;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenAppId, 'touristappid');
      expect(seenOutput, p.join(projectDir.path, 'build/weapp'));
    });

    test('配置文件含未知键:不失败,stderr 里 warn 一次', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('''
appid: wx-ok
some_unknown_future_key: 1
''');
      final err = StringBuffer();
      final code = await runCli(
        ['--project', projectDir.path],
        stderrSink: err,
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(err.toString(), contains('some_unknown_future_key'));
    });

    test('配置文件里的相对路径(output/flutter/esbuild)锚定到工程根,不是 cwd', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('''
output: relative-out
flutter: tools/flutter/bin/flutter
esbuild: tools/esbuild/bin/esbuild
''');
      String? seenOutput, seenFlutter, seenEsbuild;
      final code = await runCli(
        // 显式 --project 但从别的目录(非工程根)运行,验证锚定不是相对 cwd
        ['--project', projectDir.path],
        currentDir: () => tmp.path, // cwd 是 tmp,不是 projectDir
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenOutput = outputPath;
          seenFlutter = flutterBin;
          seenEsbuild = esbuildPath;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenOutput, p.join(projectDir.path, 'relative-out'));
      expect(seenFlutter, p.join(projectDir.path, 'tools/flutter/bin/flutter'));
      expect(seenEsbuild, p.join(projectDir.path, 'tools/esbuild/bin/esbuild'));
    });

    test('命令行显式传入的相对路径:沿用 CLI 惯例,不被锚定到工程根(原样透传)', () async {
      String? seenOutput;
      final code = await runCli(
        ['--project', projectDir.path, '--output', 'relative-cli-out'],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenOutput = outputPath;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenOutput, 'relative-cli-out');
    });

    test('配置文件解析失败(已知键类型不对):退出码 64,不调用 pipeline', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml'))
          .writeAsStringSync('require_location: not-a-bool\n');
      var pipelineCalled = false;
      final err = StringBuffer();
      final code = await runCli(
        ['--project', projectDir.path],
        stderrSink: err,
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          pipelineCalled = true;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 64);
      expect(pipelineCalled, isFalse);
    });
  });

  group('runCli —— --private-info / mp_flutter.yaml 的 private_infos', () {
    late Directory projectDir;
    setUp(() {
      projectDir = Directory.systemTemp.createTempSync('mpf_cli_privateinfo_');
      File(p.join(projectDir.path, 'pubspec.yaml'))
          .writeAsStringSync('name: x\ndependencies:\n  flutter:\n    sdk: flutter\n');
    });
    tearDown(() => projectDir.deleteSync(recursive: true));

    test('只有 mp_flutter.yaml:按声明顺序透传', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('''
private_infos: [chooseLocation, getFuzzyLocation]
''');
      List<String>? seen;
      final code = await runCli(
        ['--project', projectDir.path],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seen = privateInfos;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seen, ['chooseLocation', 'getFuzzyLocation']);
    });

    test('--private-info 可重复,与 yaml 合并去重,yaml 在前、命令行新增的在后', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('''
private_infos: [chooseLocation]
''');
      List<String>? seen;
      final code = await runCli(
        [
          '--project', projectDir.path,
          '--private-info=chooseLocation', // 与 yaml 重复,不应该出现两次
          '--private-info=choosePoi',
        ],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seen = privateInfos;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seen, ['chooseLocation', 'choosePoi']);
    });

    test('--require-location 向后兼容:补一个 getLocation,与 private_infos 合并去重', () async {
      List<String>? seen;
      final code = await runCli(
        [
          '--project', projectDir.path,
          '--require-location',
          '--private-info=chooseLocation',
        ],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seen = privateInfos;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seen, containsAll(['chooseLocation', 'getLocation']));
    });

    test('mp_flutter.yaml 里 private_infos 含不支持的取值:退出码 64,列出允许值', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('''
private_infos: [notARealApi]
''');
      final err = StringBuffer();
      var pipelineCalled = false;
      final code = await runCli(
        ['--project', projectDir.path],
        stderrSink: err,
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          pipelineCalled = true;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 64);
      expect(pipelineCalled, isFalse);
      expect(err.toString(), contains('notARealApi'));
    });

    test('--private-info 传不支持的取值:退出码 64,不调用 pipeline', () async {
      var pipelineCalled = false;
      final err = StringBuffer();
      final code = await runCli(
        ['--project', projectDir.path, '--private-info=notARealApi'],
        stderrSink: err,
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          pipelineCalled = true;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 64);
      expect(pipelineCalled, isFalse);
    });

    test('getLocation 与 getFuzzyLocation 同时声明:微信不允许,退出码 64', () async {
      var pipelineCalled = false;
      final err = StringBuffer();
      final code = await runCli(
        [
          '--project', projectDir.path,
          '--private-info=getLocation',
          '--private-info=getFuzzyLocation',
        ],
        stderrSink: err,
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          pipelineCalled = true;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 64);
      expect(pipelineCalled, isFalse);
      expect(err.toString(), contains('getFuzzyLocation'));
    });
  });

  group('runCli —— --perf-hud / mp_flutter.yaml 的 perf_hud', () {
    late Directory projectDir;
    setUp(() {
      projectDir = Directory.systemTemp.createTempSync('mpf_cli_perfhud_');
      File(p.join(projectDir.path, 'pubspec.yaml'))
          .writeAsStringSync('name: x\ndependencies:\n  flutter:\n    sdk: flutter\n');
    });
    tearDown(() => projectDir.deleteSync(recursive: true));

    test('默认关闭', () async {
      bool? seenPerfHud;
      final code = await runCli(
        ['--project', projectDir.path],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenPerfHud = perfHud;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenPerfHud, isFalse);
    });

    test('--perf-hud 打开', () async {
      bool? seenPerfHud;
      final code = await runCli(
        ['--project', projectDir.path, '--perf-hud'],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenPerfHud = perfHud;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenPerfHud, isTrue);
    });

    test('mp_flutter.yaml 的 perf_hud: true 生效(无需命令行传参)', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('perf_hud: true\n');
      bool? seenPerfHud;
      final code = await runCli(
        ['--project', projectDir.path],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenPerfHud = perfHud;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenPerfHud, isTrue);
    });

    test('命令行 --no-perf-hud 覆盖配置文件的 true', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('perf_hud: true\n');
      bool? seenPerfHud;
      final code = await runCli(
        ['--project', projectDir.path, '--no-perf-hud'],
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          seenPerfHud = perfHud;
          return SizeReport(const {}, const []);
        },
      );
      expect(code, 0);
      expect(seenPerfHud, isFalse);
    });
  });

  group('runCli —— --dart-define / mp_flutter.yaml 的 dart_define', () {
    late Directory tmp;
    late Directory projectDir;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('mpf_cli_dart_define_');
      projectDir = Directory(p.join(tmp.path, 'app'))..createSync(recursive: true);
      File(p.join(projectDir.path, 'pubspec.yaml'))
          .writeAsStringSync('name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    });
    tearDown(() => tmp.deleteSync(recursive: true));

    Future<int> runWithDartDefines(
      List<String> extraArgs, {
      required void Function(List<String> dartDefines, String? dartDefineFromFile) onPipeline,
      StringSink? stderrSink,
      String Function()? currentDir,
    }) {
      return runCli(
        ['--project', projectDir.path, ...extraArgs],
        stderrSink: stderrSink,
        currentDir: currentDir,
        pipelineRunner: ({
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
          bool licenses = true,
          bool shaderWarmup = true,
          bool shaderWarmupLight = false,
          String? cjkFont = 'level1',
          String? cjkFontBold,
          String? fontBaseUrl,
          String? splashTitle,
          String? splashColor,
          List<String> dartDefines = const [],
          String? dartDefineFromFile,
          bool safeArea = true,
          String? target,
        }) async {
          onPipeline(dartDefines, dartDefineFromFile);
          return SizeReport(const {}, const []);
        },
      );
    }

    test('单个 --dart-define:原样透传', () async {
      List<String>? seen;
      final code = await runWithDartDefines(
        ['--dart-define=API_HOST=https://x.com'],
        onPipeline: (dartDefines, _) => seen = dartDefines,
      );
      expect(code, 0);
      expect(seen, ['API_HOST=https://x.com']);
    });

    test('重复 --dart-define 同一个 KEY:后一个覆盖前一个', () async {
      List<String>? seen;
      final code = await runWithDartDefines(
        ['--dart-define=A=first', '--dart-define=A=second'],
        onPipeline: (dartDefines, _) => seen = dartDefines,
      );
      expect(code, 0);
      expect(seen, ['A=second']);
    });

    test('VALUE 含逗号:不被 --dart-define 的多值切分逻辑拆开', () async {
      List<String>? seen;
      final code = await runWithDartDefines(
        ['--dart-define=LIST=a,b,c'],
        onPipeline: (dartDefines, _) => seen = dartDefines,
      );
      expect(code, 0);
      expect(seen, ['LIST=a,b,c']);
    });

    test('VALUE 含等号:只在第一个 = 处切分', () async {
      List<String>? seen;
      final code = await runWithDartDefines(
        ['--dart-define=TOKEN=a=b=c'],
        onPipeline: (dartDefines, _) => seen = dartDefines,
      );
      expect(code, 0);
      expect(seen, ['TOKEN=a=b=c']);
    });

    test('mp_flutter.yaml 的 dart_define 与命令行合并:命令行覆盖同名 KEY,位置不变', () async {
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('''
dart_define:
  A: from-yaml
  B: keep
''');
      List<String>? seen;
      final code = await runWithDartDefines(
        ['--dart-define=A=from-cli'],
        onPipeline: (dartDefines, _) => seen = dartDefines,
      );
      expect(code, 0);
      expect(seen, ['A=from-cli', 'B=keep']);
    });

    test('命令行 --dart-define 格式错误(缺 =):退出码 64,不调用 pipeline', () async {
      var pipelineCalled = false;
      final err = StringBuffer();
      final code = await runWithDartDefines(
        ['--dart-define=NOEQUALSIGN'],
        stderrSink: err,
        onPipeline: (_, __) => pipelineCalled = true,
      );
      expect(code, 64);
      expect(pipelineCalled, isFalse);
      expect(err.toString(), contains('--dart-define'));
    });

    test('--dart-define-from-file:相对路径相对 cwd 解析,不是相对工程根', () async {
      // cwd(tmp)与工程根(projectDir)故意不同,验证锚定基准是 cwd
      String? seenPath;
      final code = await runWithDartDefines(
        ['--dart-define-from-file=defines.env'],
        currentDir: () => tmp.path,
        onPipeline: (_, dartDefineFromFile) => seenPath = dartDefineFromFile,
      );
      expect(code, 0);
      expect(seenPath, p.join(tmp.path, 'defines.env'));
    });

    test('--dart-define-from-file 传绝对路径:原样透传', () async {
      String? seenPath;
      final code = await runWithDartDefines(
        ['--dart-define-from-file=/abs/defines.env'],
        onPipeline: (_, dartDefineFromFile) => seenPath = dartDefineFromFile,
      );
      expect(code, 0);
      expect(seenPath, '/abs/defines.env');
    });

    test('都不传:dartDefines 为空列表,dartDefineFromFile 为 null', () async {
      List<String>? seenDefines;
      String? seenFile = 'not-set';
      final code = await runWithDartDefines(
        [],
        onPipeline: (dartDefines, dartDefineFromFile) {
          seenDefines = dartDefines;
          seenFile = dartDefineFromFile;
        },
      );
      expect(code, 0);
      expect(seenDefines, isEmpty);
      expect(seenFile, isNull);
    });
  });

  group('runCli —— doctor 子命令', () {
    test('全部检查项 ✓:退出码 0', () async {
      final out = StringBuffer();
      final code = await runCli(
        ['doctor'],
        stdoutSink: out,
        doctorRunner: ({flutterBin, esbuildOverride, projectPath}) async => const [
          DoctorCheck(label: 'Node (≥18)', ok: true, detail: ' 可用'),
          DoctorCheck(label: 'esbuild', ok: true, detail: ' 已就绪'),
        ],
      );
      expect(code, 0);
      expect(out.toString(), contains('✓ Node (≥18)'));
    });

    test('存在 ✗ 项:退出码 1', () async {
      final code = await runCli(
        ['doctor'],
        doctorRunner: ({flutterBin, esbuildOverride, projectPath}) async => const [
          DoctorCheck(label: 'Node (≥18)', ok: false, detail: ' 找不到 node'),
          DoctorCheck(label: 'esbuild', ok: true, detail: ' 已就绪'),
        ],
      );
      expect(code, 1);
    });

    test('只有 warnOnly 项 ✗(M4:微信开发者工具 CLI 缺失):退出码仍是 0', () async {
      final out = StringBuffer();
      final code = await runCli(
        ['doctor'],
        stdoutSink: out,
        doctorRunner: ({flutterBin, esbuildOverride, projectPath}) async => const [
          DoctorCheck(label: 'Node (≥18)', ok: true, detail: ' 可用'),
          DoctorCheck(
              label: '微信开发者工具 CLI', ok: false, warnOnly: true, detail: ' 未在默认路径找到'),
        ],
      );
      expect(code, 0);
      expect(out.toString(), contains('⚠ 微信开发者工具 CLI'));
    });

    test('--flutter/--esbuild:原样透传给 doctorRunner(相对 cwd,不锚定)', () async {
      String? seenFlutter, seenEsbuild;
      final code = await runCli(
        ['doctor', '--flutter', 'my-flutter', '--esbuild', 'my-esbuild'],
        doctorRunner: ({flutterBin, esbuildOverride, projectPath}) async {
          seenFlutter = flutterBin;
          seenEsbuild = esbuildOverride;
          return const [DoctorCheck(label: 'x', ok: true, detail: '')];
        },
      );
      expect(code, 0);
      expect(seenFlutter, 'my-flutter');
      expect(seenEsbuild, 'my-esbuild');
    });

    test('找到工程根且有 mp_flutter.yaml:相对路径的 flutter/esbuild 锚定到工程根', () async {
      final tmp = Directory.systemTemp.createTempSync('mpf_cli_doctor_config_');
      addTearDown(() => tmp.deleteSync(recursive: true));
      final projectDir = Directory(p.join(tmp.path, 'app'))..createSync(recursive: true);
      File(p.join(projectDir.path, 'pubspec.yaml'))
          .writeAsStringSync('name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
      File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync('''
flutter: tools/flutter/bin/flutter
esbuild: tools/esbuild/bin/esbuild
''');

      String? seenFlutter, seenEsbuild;
      final code = await runCli(
        ['doctor'],
        currentDir: () => projectDir.path,
        doctorRunner: ({flutterBin, esbuildOverride, projectPath}) async {
          seenFlutter = flutterBin;
          seenEsbuild = esbuildOverride;
          return const [DoctorCheck(label: 'x', ok: true, detail: '')];
        },
      );
      expect(code, 0);
      expect(seenFlutter, p.join(projectDir.path, 'tools/flutter/bin/flutter'));
      expect(seenEsbuild, p.join(projectDir.path, 'tools/esbuild/bin/esbuild'));
    });

    test('--flutter 命令行显式传入:优先于 mp_flutter.yaml', () async {
      final tmp = Directory.systemTemp.createTempSync('mpf_cli_doctor_config_override_');
      addTearDown(() => tmp.deleteSync(recursive: true));
      final projectDir = Directory(p.join(tmp.path, 'app'))..createSync(recursive: true);
      File(p.join(projectDir.path, 'pubspec.yaml'))
          .writeAsStringSync('name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
      File(p.join(projectDir.path, 'mp_flutter.yaml'))
          .writeAsStringSync('flutter: tools/flutter/bin/flutter\n');

      String? seenFlutter;
      final code = await runCli(
        ['doctor', '--flutter', '/explicit/flutter'],
        currentDir: () => projectDir.path,
        doctorRunner: ({flutterBin, esbuildOverride, projectPath}) async {
          seenFlutter = flutterBin;
          return const [DoctorCheck(label: 'x', ok: true, detail: '')];
        },
      );
      expect(code, 0);
      expect(seenFlutter, '/explicit/flutter');
    });

    test('找不到工程根:不报错,doctorRunner 拿到 null(照常用默认值探测)', () async {
      final tmp = Directory.systemTemp.createTempSync('mpf_cli_doctor_no_project_');
      addTearDown(() => tmp.deleteSync(recursive: true));

      String? seenFlutter, seenEsbuild;
      final err = StringBuffer();
      final code = await runCli(
        ['doctor'],
        currentDir: () => tmp.path,
        stderrSink: err,
        doctorRunner: ({flutterBin, esbuildOverride, projectPath}) async {
          seenFlutter = flutterBin;
          seenEsbuild = esbuildOverride;
          return const [DoctorCheck(label: 'x', ok: true, detail: '')];
        },
      );
      expect(code, 0);
      expect(seenFlutter, isNull);
      expect(seenEsbuild, isNull);
      expect(err.toString(), isEmpty);
    });
  });

  test('kPackageVersion 与 pubspec.yaml 的 version 一致', () {
    final pubspec = File(p.join(Directory.current.path, 'pubspec.yaml')).readAsStringSync();
    final match = RegExp(r'^version:\s*(\S+)', multiLine: true).firstMatch(pubspec);
    expect(match, isNotNull, reason: 'pubspec.yaml 里找不到 version: 这一行');
    expect(kPackageVersion, match!.group(1));
  });
  group('runCli —— 体积选项(--no-licenses / --font-base-url / splash_*)', () {
    late Directory projectDir;
    late Map<String, Object?> seen;
    String? cjkSeen;
    String? boldSeen;
    setUp(() {
      projectDir = Directory.systemTemp.createTempSync('mpf_cli_size_');
      cjkSeen = null;
      boldSeen = null;
      File(p.join(projectDir.path, 'pubspec.yaml'))
          .writeAsStringSync('name: x\ndependencies:\n  flutter:\n    sdk: flutter\n');
      seen = {};
    });
    tearDown(() => projectDir.deleteSync(recursive: true));

    Future<SizeReport> fake({
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
      bool licenses = true,
      bool shaderWarmup = true,
      bool shaderWarmupLight = false,
      String? cjkFont = 'full',
      String? cjkFontBold,
      String? fontBaseUrl,
      String? splashTitle,
      String? splashColor,
      List<String> dartDefines = const [],
      String? dartDefineFromFile,
      bool safeArea = true,
      String? target,
    }) async {
      seen = {
        'licenses': licenses, 'fontBaseUrl': fontBaseUrl,
        'splashTitle': splashTitle, 'splashColor': splashColor,
      };
      cjkSeen = cjkFont;
      boldSeen = cjkFontBold;
      return SizeReport(const {}, const []);
    }

    void yaml(String s) => File(p.join(projectDir.path, 'mp_flutter.yaml')).writeAsStringSync(s);

    test('默认:打包许可证、不用远端字体、启动界面用默认值;成功提示带开发者工具本地设置提醒', () async {
      final out = StringBuffer();
      expect(await runCli(['--project', projectDir.path], stdoutSink: out, pipelineRunner: fake), 0);
      expect(out.toString(), contains('「详情 → 本地设置」'));
      expect(out.toString(), contains('「将 JS 编译成 ES5」和「增强编译」'));
      expect(seen, {'licenses': true, 'fontBaseUrl': null, 'splashTitle': null, 'splashColor': null});
    });

    test('常用汉字合一字体默认 full;--cjk-font=level1 / --no-cjk-font / cjk_font 配置,命令行优先', () async {
      expect(await runCli(['--project', projectDir.path], pipelineRunner: fake), 0);
      expect(cjkSeen, 'full');
      expect(await runCli(['--project', projectDir.path, '--cjk-font=level1'], pipelineRunner: fake), 0);
      expect(cjkSeen, 'level1');
      expect(await runCli(['--project', projectDir.path, '--no-cjk-font'], pipelineRunner: fake), 0);
      expect(cjkSeen, isNull);
      expect(await runCli(['--project', projectDir.path, '--cjk-font=false'], pipelineRunner: fake), 0);
      expect(cjkSeen, isNull);
      yaml('cjk_font: false\n');
      expect(await runCli(['--project', projectDir.path], pipelineRunner: fake), 0);
      expect(cjkSeen, isNull);
      expect(await runCli(['--project', projectDir.path, '--cjk-font=level1'], pipelineRunner: fake), 0);
      expect(cjkSeen, 'level1');
      yaml('cjk_font: full\n');
      expect(await runCli(['--project', projectDir.path], pipelineRunner: fake), 0);
      expect(cjkSeen, 'full');
      yaml('cjk_font: true\n');
      expect(await runCli(['--project', projectDir.path], pipelineRunner: fake), 0);
      expect(cjkSeen, 'full');
      yaml('cjk_font: level2\n');
      expect(await runCli(['--project', projectDir.path], pipelineRunner: fake), 64);
    });

    test('合一字体粗体默认跟随 cjk_font;--cjk-font-bold / cjk_font_bold;档位不一致报错', () async {
      expect(await runCli(['--project', projectDir.path], pipelineRunner: fake), 0);
      expect(boldSeen, 'full');
      expect(await runCli(['--project', projectDir.path, '--cjk-font=level1'], pipelineRunner: fake), 0);
      expect(boldSeen, 'level1');
      expect(await runCli(['--project', projectDir.path, '--cjk-font-bold=false'], pipelineRunner: fake), 0);
      expect((cjkSeen, boldSeen), ('full', null));
      expect(await runCli(['--project', projectDir.path, '--no-cjk-font'], pipelineRunner: fake), 0);
      expect(boldSeen, isNull);
      final err = StringBuffer();
      expect(await runCli(['--project', projectDir.path, '--cjk-font-bold=level1'], stderrSink: err, pipelineRunner: fake), 64);
      expect(err.toString(), contains('同一字表'));
      expect(await runCli(['--project', projectDir.path, '--no-cjk-font', '--cjk-font-bold=full'], pipelineRunner: fake), 64);
      yaml('cjk_font: level1\ncjk_font_bold: false\n');
      expect(await runCli(['--project', projectDir.path], pipelineRunner: fake), 0);
      expect(boldSeen, isNull);
      expect(await runCli(['--project', projectDir.path, '--cjk-font-bold=level1'], pipelineRunner: fake), 0);
      expect(boldSeen, 'level1');
      yaml('cjk_font: level1\ncjk_font_bold: true\n');
      expect(await runCli(['--project', projectDir.path], pipelineRunner: fake), 0);
      expect(boldSeen, 'level1');
      yaml('cjk_font_bold: bold\n');
      expect(await runCli(['--project', projectDir.path], pipelineRunner: fake), 64);
    });

    test('--no-licenses 与 --font-base-url 透传', () async {
      expect(await runCli(['--project', projectDir.path, '--no-licenses', '--font-base-url', 'https://cdn.x.com/f/'],
          pipelineRunner: fake), 0);
      expect(seen['licenses'], false);
      expect(seen['fontBaseUrl'], 'https://cdn.x.com/f/');
    });

    test('yaml 的 licenses/font_base_url/splash_title/splash_color;命令行覆盖 yaml', () async {
      yaml('licenses: false\nfont_base_url: https://a.com/f/\nsplash_title: 小店\nsplash_color: "#123"\n');
      expect(await runCli(['--project', projectDir.path], pipelineRunner: fake), 0);
      expect(seen, {'licenses': false, 'fontBaseUrl': 'https://a.com/f/', 'splashTitle': '小店', 'splashColor': '#123'});
      expect(await runCli(['--project', projectDir.path, '--licenses', '--font-base-url', 'https://b.com/'],
          pipelineRunner: fake), 0);
      expect(seen['licenses'], true);
      expect(seen['fontBaseUrl'], 'https://b.com/');
    });

    test('font_base_url 不是 https / splash_color 不合法:构建前退出码 64', () async {
      final err = StringBuffer();
      expect(await runCli(['--project', projectDir.path, '--font-base-url', 'http://x.com/'],
          stderrSink: err, pipelineRunner: fake), 64);
      expect(err.toString(), contains('https'));
      yaml('splash_color: red\n');
      expect(await runCli(['--project', projectDir.path], stderrSink: err, pipelineRunner: fake), 64);
      expect(err.toString(), contains('splash_color'));
      expect(seen, isEmpty, reason: '参数错误时不应开始构建');
    });
  });
}
