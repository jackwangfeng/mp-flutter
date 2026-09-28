@Tags(['slow'])
library;

import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';

/// Phase 6 Task 1 消费者冒烟(对应 Review Focus 1、4、5):
///
///   1. 路径含空格与中文 → 构建正常(所有子进程参数以列表传递,不拼 shell 字符串)
///   4.(部分覆盖)在工程子目录(lib/)里执行命令,用 `--project ..` 显式指定
///      工程根 —— 向上自动探测工程根是 Phase 6 Task 2 的范围,这里只验证
///      "显式指定时子目录执行不受影响"
///   5. `dart run mp_flutter` 走编译好的 snapshot,`Platform.script` 指向消费者
///      工程的 `.dart_tool`,pipeline.dart 已改用 `resolvePackageRoot()`
///      (`Isolate.resolvePackageUri`)定位 `runtime/`/`js/`,不再依赖
///      `Platform.script` 上溯——这里验证仍能找到并落盘运行时 JS
///
/// 很慢(`flutter create` + `flutter pub get` + 完整 `flutter build web` +
/// 可能触发 esbuild 首次自动安装),默认不跑(见 dart_test.yaml 里的
/// `tags: {slow: {skip: ...}}`)。手动运行:
///   dart test --run-skipped -t slow test/consumer_smoke_test.dart
void main() {
  test(
    '作为 dev_dependency(path)被路径含空格/中文的工程消费,在 lib/ 子目录跑 dart run mp_flutter',
    () async {
      // `dart test` 的工作目录固定是包根(packages/mp_flutter)。
      final packageRoot = Directory.current.path;

      // 优先用仓库里已知装好的 stable Flutter(见 flutter_build.dart 的
      // resolveFlutterBin),不依赖 PATH 上可能是 flutter_ohos fork 的那个,
      // 保证这个冒烟测试的可重复性。
      final home = Platform.environment['HOME'] ?? '';
      final flutterCandidate = p.join(home, 'development/flutter/bin/flutter');
      final flutterBin = File(flutterCandidate).existsSync() ? flutterCandidate : 'flutter';

      final workDir =
          Directory.systemTemp.createTempSync('mpf 消费者冒烟 with space ');
      addTearDown(() {
        if (workDir.existsSync()) workDir.deleteSync(recursive: true);
      });

      // 路径本身再嵌一层含空格/中文的目录,双重覆盖 Review Focus 1。
      final projectDir = Directory(p.join(workDir.path, '含 中文 的 app 目录'));

      final create = await Process.run(
        flutterBin,
        [
          'create',
          '--platforms=web',
          '--project-name',
          'consumer_smoke_app',
          projectDir.path,
        ],
      );
      expect(create.exitCode, 0,
          reason: 'flutter create 失败:\n${create.stdout}\n${create.stderr}');

      // 把 mp_flutter 加成 dev_dependency(path,指向本包根)。
      final pubspecFile = File(p.join(projectDir.path, 'pubspec.yaml'));
      final original = pubspecFile.readAsStringSync();
      final patched = original.replaceFirst(
        RegExp(r'dev_dependencies:\s*\n'),
        'dev_dependencies:\n'
        '  mp_flutter:\n'
        '    path: "${packageRoot.replaceAll('"', '\\"')}"\n',
      );
      expect(patched, isNot(equals(original)),
          reason: '没找到 dev_dependencies: 这一行,flutter create 的模板可能变了');
      pubspecFile.writeAsStringSync(patched);

      final pubGet = await Process.run(
        flutterBin,
        ['pub', 'get'],
        workingDirectory: projectDir.path,
      );
      expect(pubGet.exitCode, 0,
          reason: 'flutter pub get 失败:\n${pubGet.stdout}\n${pubGet.stderr}');

      // 核心断言:在 lib/ 子目录(不是工程根)里执行 dart run mp_flutter,
      // 显式 --project .. 指向工程根,--output 落到工程根下的 build/weapp。
      final libDir = p.join(projectDir.path, 'lib');
      final outputRel = p.join('..', 'build', 'weapp');
      final outputAbs = p.join(projectDir.path, 'build', 'weapp');

      final run = await Process.run(
        'dart',
        [
          'run',
          'mp_flutter',
          '--project',
          '..',
          '--output',
          outputRel,
          '--appid',
          'touristappid',
        ],
        workingDirectory: libDir,
      );
      expect(run.exitCode, 0,
          reason: 'dart run mp_flutter 失败:\n${run.stdout}\n${run.stderr}');

      // 产物断言:app.json(工程骨架)与运行时 JS(证明 resolvePackageRoot
      // 在 snapshot 运行下仍能找到随包分发的 runtime/)都落了盘。
      expect(File(p.join(outputAbs, 'app.json')).existsSync(), isTrue);
      expect(File(p.join(outputAbs, 'boot.js')).existsSync(), isTrue);
      expect(File(p.join(outputAbs, 'bom-shim.js')).existsSync(), isTrue);
      expect(File(p.join(outputAbs, 'canvaskit.js')).existsSync(), isTrue);
    },
    timeout: const Timeout(Duration(minutes: 15)),
  );
}
