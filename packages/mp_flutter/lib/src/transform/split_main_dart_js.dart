import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import '../package_root.dart';
import '../toolchain.dart';
import 'canvaskit_js.dart' show TransformFailure;

/// 主包根目录的共享作用域模块:各 Dart 分片经它传递 dart2js 的顶层名。
/// 分片在不同分包里,分包之间不能互相同步 require,但都能 require 主包。
const kDartScopePath = 'mp-dart-scope.js';

/// 定位 `js/split.js`(分片器,随 `flutter_miniprogram` 包分发,依赖已用单文件形式
/// vendor 进 `js/vendor/acorn.js`,不再需要 `npm install`)。
///
/// [packageRoot] 仅供测试注入,覆盖用 [resolvePackageRoot] 解析出的包根——
/// 后者用 `Isolate.resolvePackageUri` 定位,不管本包是本仓库内直接跑源码,
/// 还是被别的工程当 `dev_dependencies`(path 依赖或已发布依赖)引入,都能
/// 正确找到随包分发的 `js/` 目录(不再依赖 `Platform.script` 与固定的
/// monorepo 目录层级)。
Future<String> resolveDartSplitTool({String? packageRoot}) async {
  final root = packageRoot ?? await resolvePackageRoot();
  final tool = p.join(root, 'js/split.js');
  if (!File(tool).existsSync()) {
    throw ToolchainMissing(
      'dart-split(js/split.js)',
      'main.dart.js 超过单分包 2048KB 时要在构建期分片,找不到分片器:$tool\n'
          'flutter_miniprogram 包可能安装不完整或版本过旧,请重新执行 `dart pub get`'
          '(或 `flutter pub get`)。',
    );
  }
  return tool;
}

/// 预检 node 是否可用且版本 ≥18(分片器是 Node 脚本,用到的语法/API 要求
/// Node 18+)。与 esbuild 缺失共用同一个错误类型([ToolchainMissing]),因此
/// CLI 侧退出码族相同,消息文案区分是"缺 node"还是"node 版本过低"。
void checkNodeAvailable({String nodeBin = 'node'}) {
  ProcessResult r;
  try {
    r = Process.runSync(nodeBin, ['--version']);
  } on ProcessException catch (e) {
    throw ToolchainMissing(
      'node',
      '找不到 node($e)。main.dart.js 分片需要 Node ≥18,请先安装。',
    );
  }
  if (r.exitCode != 0) {
    throw ToolchainMissing(
      'node',
      'node --version 返回 ${r.exitCode}:${r.stderr}',
    );
  }
  final versionOut = '${r.stdout}'.trim();
  final match = RegExp(r'^v?(\d+)\.').firstMatch(versionOut);
  if (match == null) {
    throw ToolchainMissing(
      'node',
      '无法解析 node --version 的输出($versionOut),main.dart.js 分片需要 Node ≥18。',
    );
  }
  final major = int.parse(match.group(1)!);
  if (major < 18) {
    throw ToolchainMissing(
      'node',
      '当前 node 版本过低($versionOut),main.dart.js 分片需要 Node ≥18,请升级后重试。',
    );
  }
}

/// 把 dart2js 产物切成若干片,每片 ≤ [budgetBytes](UTF-8 字节)。
Future<List<String>> splitMainDartJs(
  String source, {
  required int budgetBytes,
  required String scopeRequire,
  String nodeBin = 'node',
  String? toolPath,
}) async {
  final tool = toolPath ?? await resolveDartSplitTool();
  final tmp = await Directory.systemTemp.createTemp('mp_flutter_split_');
  try {
    final inFile = File(p.join(tmp.path, 'main.dart.js'))
      ..writeAsStringSync(source);
    final outDir = p.join(tmp.path, 'out');
    final r = await Process.run(nodeBin, [
      tool,
      '--in',
      inFile.path,
      '--out-dir',
      outDir,
      '--budget',
      '$budgetBytes',
      '--scope-require',
      scopeRequire,
    ]);
    if (r.exitCode != 0) {
      throw TransformFailure('main.dart.js 分片', '${r.stderr}'.trim());
    }
    final count =
        (jsonDecode('${r.stdout}'.trim()) as Map<String, dynamic>)['count']
            as int;
    return [
      for (var i = 0; i < count; i++)
        File(p.join(outDir, 'chunk-$i.js')).readAsStringSync(),
    ];
  } finally {
    await tmp.delete(recursive: true);
  }
}
