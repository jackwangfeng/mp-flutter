import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import '../package_root.dart';
import '../toolchain.dart';
import 'canvaskit_js.dart' show TransformFailure;

/// 原文里出现 `\p{` / `\P{`(字符串常量里是 `\\p{`,同样含这个子串)才需要改写。
final _hasPropertyEscape = RegExp(r'\\[pP]\{');

/// 定位 `js/unicode-props.js`(随 `mp_flutter` 包分发,与分片器同目录)。
Future<String> resolveUnicodePropsTool({String? packageRoot}) async {
  final root = packageRoot ?? await resolvePackageRoot();
  final tool = p.join(root, 'js/unicode-props.js');
  if (!File(tool).existsSync()) {
    throw ToolchainMissing(
      'unicode-props(js/unicode-props.js)',
      '构建期要把 main.dart.js 里正则的 Unicode 属性转义改写成码点区间,找不到改写工具:$tool\n'
      'mp_flutter 包可能安装不完整或版本过旧,请重新执行 `dart pub get`(或 `flutter pub get`)。',
    );
  }
  return tool;
}

/// 把 dart2js 产物里正则的 Unicode 属性转义 `\p{…}` / `\P{…}` 改写成等价的
/// 码点区间(`\u{XXXX}` 写法),在 main.dart.js 分片之前执行。
///
/// 安卓微信的 JS 引擎不带 ICU,不支持 Unicode 属性转义:Flutter 框架
/// text_painter.dart 的 `[\p{Space_Separator}\p{Punctuation}]` 与
/// `\p{Space_Separator}` 在插入文字时构造,真机抛
/// `Illegal RegExp pattern (SyntaxError: ... Invalid property name)`,这次更新
/// 丢掉,输入框不回显。区间由本机 Node(带 ICU)实测得出,详见
/// `js/unicode-props.js` 文件头。
///
/// 没有属性转义时直接返回原文,不启动 Node。Node 也不认识的属性名等异常
/// 转成 [TransformFailure],带出工具的具名错误码(如 `unknown-property`)。
Future<String> rewriteUnicodePropertyEscapes(
  String source, {
  String nodeBin = 'node',
  String? toolPath,
  void Function(int rewrites, List<String> properties)? onRewritten,
}) async {
  if (!_hasPropertyEscape.hasMatch(source)) return source;
  final tool = toolPath ?? await resolveUnicodePropsTool();
  final tmp = await Directory.systemTemp.createTemp('mp_flutter_uprops_');
  try {
    final inFile = File(p.join(tmp.path, 'in.js'))..writeAsStringSync(source);
    final outFile = File(p.join(tmp.path, 'out.js'));
    final r = await Process.run(nodeBin, [tool, '--in', inFile.path, '--out', outFile.path]);
    if (r.exitCode != 0) {
      throw TransformFailure(
        '正则 Unicode 属性转义改写(安卓真机不支持 \\p{…})',
        '${r.stderr}'.trim(),
        file: 'main.dart.js',
      );
    }
    final info = jsonDecode('${r.stdout}'.trim()) as Map<String, dynamic>;
    onRewritten?.call(info['rewrites'] as int, (info['properties'] as List).cast<String>());
    return outFile.readAsStringSync();
  } finally {
    await tmp.delete(recursive: true);
  }
}
