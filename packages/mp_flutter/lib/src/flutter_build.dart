import 'dart:convert';
import 'dart:io';
import 'package:path/path.dart' as p;

/// 显式指定的 Flutter SDK(`--flutter`/`mp_flutter.yaml` 的 `flutter`)与工程
/// `.dart_tool/package_config.json` 解析所用的 SDK 不一致(D1)。
///
/// 两个 SDK 都能各自独立跑通,但 dart2js 编译时用的是 [inferredFromPackageConfig]
/// 解析出的 `package:flutter` 源码(pub 早已按那个 SDK 解析并写进
/// package_config.json),引擎却是 [explicit] 的——两者内部形状不一致,报出的错误
/// 通常是 `Member not found: 'xxx'` 这类看不出根因的怪错误。宁可在这里显式拒绝,
/// 也不要让它跑到 dart2js 那步才失败。
class FlutterSdkMismatch implements Exception {
  final String explicit;
  final String inferredFromPackageConfig;
  const FlutterSdkMismatch(this.explicit, this.inferredFromPackageConfig);

  String get message =>
      '指定的 Flutter SDK 与工程 .dart_tool/package_config.json 解析时用的 SDK 不一致:\n'
      '  显式指定:$explicit\n'
      '  package_config.json 里的 flutter 包来自:$inferredFromPackageConfig\n'
      '两者内部形状可能不同,dart2js 编译很可能报出无法理解的错误(如 "Member not found")。\n'
      '请先用 $inferredFromPackageConfig 执行一次 `flutter pub get`(切换到该 SDK 重新解析依赖),'
      '或者把 --flutter / mp_flutter.yaml 的 flutter 改成指向 $inferredFromPackageConfig。';

  @override
  String toString() => 'FlutterSdkMismatch: $message';
}

/// 从工程 `.dart_tool/package_config.json` 里 `name == "flutter"` 的包项解出它
/// 所在的 Flutter SDK 根目录(`<sdk>/packages/flutter` → `<sdk>`)。
///
/// 找不到 package_config.json、JSON 解析失败、没有 `flutter` 包项,或者
/// `rootUri` 的形状不是预期的 `.../packages/flutter`(比如工程用 path 依赖
/// 覆盖了 flutter 包这种非常规写法),都返回 null——调用方退回旧的探测逻辑,
/// 不强行猜测。
///
/// [fileExists]/[readFile] 仅供测试注入。
String? flutterSdkFromPackageConfig(
  String projectPath, {
  bool Function(String path)? fileExists,
  String Function(String path)? readFile,
}) {
  final exists = fileExists ?? (path) => File(path).existsSync();
  final read = readFile ?? (path) => File(path).readAsStringSync();

  final path = p.join(projectPath, '.dart_tool', 'package_config.json');
  if (!exists(path)) return null;

  Object? doc;
  try {
    doc = jsonDecode(read(path));
  } on FormatException {
    return null;
  }
  if (doc is! Map) return null;
  final packages = doc['packages'];
  if (packages is! List) return null;

  for (final pkg in packages) {
    if (pkg is! Map || pkg['name'] != 'flutter') continue;
    final rootUri = pkg['rootUri'];
    if (rootUri is! String) return null;

    String rootPath;
    if (rootUri.startsWith('file://')) {
      try {
        rootPath = Uri.parse(rootUri).toFilePath();
      } on FormatException {
        return null;
      }
    } else if (p.isAbsolute(rootUri)) {
      rootPath = rootUri;
    } else {
      // package_config.json 里的相对 rootUri 相对该文件自身所在目录解析。
      rootPath = p.join(projectPath, '.dart_tool', rootUri);
    }
    final normalized = p.normalize(rootPath);
    // 预期形状 <sdk>/packages/flutter——不符合就不强行猜测(比如本地 path
    // 依赖直接指向了别的目录)。
    if (p.basename(normalized) != 'flutter' ||
        p.basename(p.dirname(normalized)) != 'packages') {
      return null;
    }
    return p.dirname(p.dirname(normalized));
  }
  return null;
}

/// 子进程调用 flutter/dart 前必须去掉的环境变量。
///
/// `flutter`/`dart` 官方启动脚本会把 `FLUTTER_ROOT` export 出来,子进程继承。
/// 双 SDK 机器上,如果外层 shell 之前用另一套 SDK 跑过 flutter/dart 命令,
/// `FLUTTER_ROOT` 会残留指向那一套——即便这里选中的可执行文件路径是另一套
/// SDK,pub 解析 `package:flutter` 源码时优先信这个环境变量,导致"引擎是 A、
/// 编译的却是 B 的 packages/flutter 源码"这种版本错配(dart2js 报
/// `Member not found` 之类的怪错误)。做法与 `tools/ci/check.sh` 一致:调用前
/// 显式去掉它,不依赖调用方 shell 有没有记得 unset。
Map<String, String> _environmentWithoutFlutterRoot() {
  final env = Map<String, String>.of(Platform.environment);
  env.remove('FLUTTER_ROOT');
  return env;
}

/// `flutter build web` 失败。
///
/// 必须原样透出 Flutter 自己的输出:绝大多数情况下问题在用户工程
/// (用了 dart:io / platform channel / 不支持 web 的插件),
/// 把它伪装成 mp_flutter 的失败会让人查错方向。
class FlutterBuildFailure implements Exception {
  final int exitCode;
  final String stderr;
  const FlutterBuildFailure(this.exitCode, this.stderr);

  String get message =>
      'flutter build web 失败(exit $exitCode)。\n'
      '--- Flutter 输出 ---\n$stderr\n'
      '--- 提示 ---\n'
      'mp_flutter 基于 Flutter 的 web target。请先确认该工程本身能跑通\n'
      '  flutter build web --release\n'
      '常见原因:直接使用了 dart:io、platform channel,或依赖了不支持 web 的插件。';

  @override
  String toString() => 'FlutterBuildFailure: $message';
}

/// 探测 flutter 可执行文件路径(D1)。
///
/// 解析顺序:
///
///  1. 若 [projectPath] 非空且工程已跑过 `flutter pub get`
///     (`.dart_tool/package_config.json` 存在且含 `flutter` 包项),优先用它
///     的 `rootUri` 反推出的 SDK——这就是 dart2js 实际会编译的
///     `package:flutter` 源码所在的那一套,与它保持一致才不会出现"引擎是
///     A、编译的却是 B 的 packages/flutter 源码"这种版本错配。
///  2. 调用方显式传入的 [override](`--flutter`/`mp_flutter.yaml` 的
///     `flutter`)——若与第 1 步推出的 SDK 不一致,直接抛
///     [FlutterSdkMismatch](绝不静默选其中一个);[override] 是裸命令名
///     (不含路径分隔符,比如显式传了 `--flutter flutter` 依赖 PATH 探测)时
///     无法反推 SDK 根目录,跳过这项校验。
///  3. 都没有(通常是还没 `pub get` 过,或不在工程上下文里跑,比如
///     `doctor` 在工程外执行)时,退回旧的探测顺序:
///     `$HOME/development/flutter/bin/flutter`、`/usr/local/bin/flutter`,
///     最后是 PATH 里的 `flutter`。
///
/// [projectPath] 为 null 时完全跳过第 1/2 步的 package_config 校验,行为与
/// 旧版一致——`doctor` 在找不到工程根时就是这样调用的。[fileExists]/
/// [readFile] 仅供测试注入。
String resolveFlutterBin(
  String? override, {
  String? projectPath,
  bool Function(String path)? fileExists,
  String Function(String path)? readFile,
}) {
  final inferredSdk = projectPath == null
      ? null
      : flutterSdkFromPackageConfig(
          projectPath,
          fileExists: fileExists,
          readFile: readFile,
        );

  if (override != null) {
    if (inferredSdk != null && override.contains(Platform.pathSeparator)) {
      final overrideSdk = p.normalize(
        p.dirname(p.dirname(p.normalize(p.absolute(override)))),
      );
      if (overrideSdk != p.normalize(inferredSdk)) {
        throw FlutterSdkMismatch(
          override,
          p.join(inferredSdk, 'bin', 'flutter'),
        );
      }
    }
    return override;
  }

  if (inferredSdk != null) return p.join(inferredSdk, 'bin', 'flutter');

  final home = Platform.environment['HOME'] ?? '';
  final candidates = [
    p.join(home, 'development/flutter/bin/flutter'),
    '/usr/local/bin/flutter',
    'flutter',
  ];
  for (final c in candidates) {
    if (c == 'flutter' || File(c).existsSync()) return c;
  }
  return 'flutter';
}

Future<String> readFlutterVersion(String flutterBin) async {
  final r = await Process.run(
    flutterBin,
    ['--version'],
    environment: _environmentWithoutFlutterRoot(),
    includeParentEnvironment: false,
  );
  if (r.exitCode != 0) {
    throw StateError('无法执行 $flutterBin --version:${r.stderr}');
  }
  return r.stdout as String;
}

/// 构造 `flutter build web` 的完整参数列表。
///
/// 抽成纯函数供单测直接断言(不需要真的跑 flutter):每个
/// `--dart-define=KEY=VALUE` 是单独的 list 元素——VALUE 可能含逗号/`=`,
/// 拼进一个字符串再交给 shell 解析会被错误切分,所以调用方(
/// [Process.run])必须原样传入 list,绝不能先 `join(' ')` 再拆。
List<String> buildFlutterBuildArgs({
  required bool profile,
  List<String> dartDefines = const [],
  String? dartDefineFromFile,
  String? target,
}) {
  final args = profile
      ? ['build', 'web', '--profile', '-O1']
      : ['build', 'web', '--release', '-O4'];
  if (target != null) args.addAll(['-t', target]);
  for (final d in dartDefines) {
    args.add('--dart-define=$d');
  }
  if (dartDefineFromFile != null) {
    args.add('--dart-define-from-file=$dartDefineFromFile');
  }
  return args;
}

/// 调用 `flutter build web` 并返回产物目录(`<projectPath>/build/web`)。
///
/// [profile] 为 true 时用 `--profile -O1`:产出未压缩代码、Dart 栈可读,
/// 排障时是决定性的;默认 `--release -O4`。
///
/// [dartDefines] 是已经合并好、每条形如 `KEY=VALUE` 的字符串(合并 yaml
/// `dart_define` 与命令行 `--dart-define` 是调用方的事,见
/// `config.dart` 的 `mergeDartDefines`)。
///
/// [target] 是相对工程根的入口文件(`-t`),缺省即 `lib/main.dart`;mp_flutter
/// 传入构建期生成的入口包装(见 `entrypoint.dart`)。
Future<Directory> runFlutterWebBuild({
  required String projectPath,
  required String flutterBin,
  bool profile = false,
  List<String> dartDefines = const [],
  String? dartDefineFromFile,
  String? target,
}) async {
  final args = buildFlutterBuildArgs(
    profile: profile,
    dartDefines: dartDefines,
    dartDefineFromFile: dartDefineFromFile,
    target: target,
  );

  final r = await Process.run(
    flutterBin,
    args,
    workingDirectory: projectPath,
    environment: _environmentWithoutFlutterRoot(),
    includeParentEnvironment: false,
  );
  if (r.exitCode != 0) {
    throw FlutterBuildFailure(r.exitCode, '${r.stdout}\n${r.stderr}');
  }
  final out = Directory(p.join(projectPath, 'build', 'web'));
  if (!out.existsSync()) {
    throw FlutterBuildFailure(0, 'flutter build web 声称成功,但 ${out.path} 不存在');
  }
  return out;
}
