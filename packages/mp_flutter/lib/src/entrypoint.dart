import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:yaml/yaml.dart';

/// 构建期生成的入口包装相对工程根的路径(传给 `flutter build web -t`)。
///
/// 放在 `.dart_tool/` 下:它是工具生成目录,Flutter 工程模板默认就在
/// `.gitignore` 里,不会弄脏用户仓库;`lib/` 下的 main.dart 保持原样。
const kEntrypointRelPath = '.dart_tool/mp_flutter/entrypoint.dart';

/// 入口包装无法生成(工程形状不符合预期)。不是致命错误:退回直接构建
/// `lib/main.dart`,只是安全区注入(K1)不生效——调用方打印 [reason]。
class EntrypointSkipped implements Exception {
  final String reason;
  const EntrypointSkipped(this.reason);
  @override
  String toString() => 'EntrypointSkipped: $reason';
}

/// 在 [projectPath] 下写入入口包装,返回相对工程根的路径(供 `-t` 使用)。
///
/// [targetRelPath](见 M5 `--target`/`-t`,默认 `lib/main.dart`)可以是相对
/// 工程根的路径,也可以是绝对路径(CLI 侧已经用 `anchorToProjectRoot` 锚定
/// 过,通常是绝对路径;这里两种都接受,方便单测直接传相对路径)。
///
/// 前提:`pubspec.yaml` 有 `name`,且该文件存在。不满足时抛 [EntrypointSkipped]。
String writeEntrypoint(String projectPath, {String targetRelPath = 'lib/main.dart'}) {
  final targetAbs =
      p.isAbsolute(targetRelPath) ? targetRelPath : p.join(projectPath, targetRelPath);
  final pubspec = File(p.join(projectPath, 'pubspec.yaml'));
  if (!File(targetAbs).existsSync()) {
    throw EntrypointSkipped('工程没有 ${p.relative(targetAbs, from: projectPath)}');
  }
  String? name;
  try {
    final doc = loadYaml(pubspec.readAsStringSync());
    if (doc is YamlMap && doc['name'] is String) name = doc['name'] as String;
  } catch (_) {/* 落到下面的 null 判断 */}
  if (name == null || !RegExp(r'^[a-zA-Z_][a-zA-Z0-9_]*$').hasMatch(name)) {
    throw EntrypointSkipped('pubspec.yaml 里没有合法的 name(实际:$name)');
  }
  final importUri = entrypointImportFor(projectPath, name, targetAbs);
  final f = File(p.join(projectPath, kEntrypointRelPath))
    ..createSync(recursive: true)
    ..writeAsStringSync(buildEntrypointSource(name, targetImport: importUri));
  return p.relative(f.path, from: projectPath);
}

/// 算出入口包装该用哪种 import 形式引用用户的入口文件(M5 `--target`)。
///
/// [targetAbs] 在工程根的 `lib/` 下时(绝大多数情况,包括默认的
/// `lib/main.dart`),用 `package:` URI——可读、且不受入口包装自身所在目录
/// 变化影响。不在 `lib/` 下时(`--target` 指向了 `lib/` 之外的文件,比如
/// 工程根的脚本或另一个顶层目录),`package:` 机制覆盖不到,退回相对入口
/// 包装自身所在目录(`.dart_tool/mp_flutter/`)的相对 import——两种形式都
/// 必须能被 dart2js 正确解析,见 `entrypoint_test.dart`。
String entrypointImportFor(String projectPath, String packageName, String targetAbs) {
  final relFromRoot = p.normalize(p.relative(targetAbs, from: projectPath));
  final segments = p.split(relFromRoot);
  final insideLib = segments.isNotEmpty && segments.first == 'lib' && !relFromRoot.startsWith('..');
  if (insideLib) {
    final withinLib = p.joinAll(segments.skip(1));
    return 'package:$packageName/$withinLib';
  }
  final entrypointDir = p.join(projectPath, p.dirname(kEntrypointRelPath));
  return p.relative(targetAbs, from: entrypointDir);
}

/// 入口包装的 Dart 源码。
///
/// 为什么需要它(K1 安全区):Flutter Web 引擎的 `FlutterView.viewPadding/padding`
/// 恒为零(引擎 window.dart 的 `const ViewConfiguration()`),dart2js 还把
/// `MediaQueryData.fromView` 里的读取常量折叠成了零值常量——从 JS 侧改不动。
/// 唯一不改用户代码又稳妥的注入点是框架层:在用户 `main()` 之前装一个
/// [WidgetsFlutterBinding] 子类,覆盖 `wrapWithDefaultView`,在默认 `View`
/// 之下、用户根组件之上插一层 `MediaQuery`,把 `self.__mpSafeArea`(runtime/
/// safe-area.js,来自 wx.getWindowInfo().safeArea)补进 viewPadding/padding。
///
/// 用户 `runApp` 里的 `WidgetsFlutterBinding.ensureInitialized()` 发现绑定已存在
/// 就直接复用,所以用户代码零改动。注意:用户若自带绑定子类(在 runApp 之前
/// 自己 new 一个),会与这里冲突——见 I1,这种工程请用 `--no-safe-area` 关闭
/// 本包装(退回直接构建 `--target` 指向的文件,不生成本包装)。
///
/// [targetImport] 是入口文件的 import URI(`package:` 形式或相对入口包装自身
/// 的相对 import,见 [entrypointImportFor]);缺省(仅供单测直接调用本函数时
/// 使用)按旧行为拼 `package:$packageName/main.dart`。
String buildEntrypointSource(String packageName, {String? targetImport}) => '''
// 由 mp_flutter 生成,勿手改。见 mp_flutter/lib/src/entrypoint.dart。
// ignore_for_file: type=lint
import 'dart:js_interop';
import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import '${targetImport ?? 'package:$packageName/main.dart'}' as app;

void main() {
  _MpBinding();
  final Function m = app.main;
  if (m is dynamic Function()) {
    m();
  } else if (m is dynamic Function(List<String>)) {
    m(const <String>[]);
  } else {
    Function.apply(m, const []);
  }
}

class _MpBinding extends WidgetsFlutterBinding {
  @override
  Widget wrapWithDefaultView(Widget rootWidget) =>
      super.wrapWithDefaultView(_MpSafeArea(child: rootWidget));
}

@JS('__mpSafeArea')
external _SafeAreaBridge? get _bridge;

extension type _SafeAreaBridge._(JSObject _) implements JSObject {
  external JSNumber? get top;
  external JSNumber? get right;
  external JSNumber? get bottom;
  external JSNumber? get left;
  external JSFunction listen(JSFunction fn);
}

class _MpSafeArea extends StatefulWidget {
  const _MpSafeArea({required this.child});
  final Widget child;
  @override
  State<_MpSafeArea> createState() => _MpSafeAreaState();
}

class _MpSafeAreaState extends State<_MpSafeArea> {
  JSFunction? _unlisten;

  @override
  void initState() {
    super.initState();
    final b = _bridge;
    if (b != null) {
      _unlisten = b.listen((() {
        if (mounted) setState(() {});
      }).toJS);
    }
  }

  @override
  void dispose() {
    _unlisten?.callAsFunction();
    super.dispose();
  }

  static double _v(JSNumber? n) {
    final d = n?.toDartDouble ?? 0;
    return d.isFinite && d > 0 ? d : 0;
  }

  @override
  Widget build(BuildContext context) {
    final b = _bridge;
    final data = MediaQuery.maybeOf(context);
    if (b == null || data == null) return widget.child;
    // 引擎给的值(将来的引擎版本若开始上报)与小程序安全区逐边取大
    final vp = EdgeInsets.fromLTRB(
      math.max(data.viewPadding.left, _v(b.left)),
      math.max(data.viewPadding.top, _v(b.top)),
      math.max(data.viewPadding.right, _v(b.right)),
      math.max(data.viewPadding.bottom, _v(b.bottom)),
    );
    // 与引擎语义一致:padding = viewPadding 扣掉键盘占用(viewInsets),不为负
    final vi = data.viewInsets;
    final pad = EdgeInsets.fromLTRB(
      math.max(0.0, vp.left - vi.left),
      math.max(0.0, vp.top - vi.top),
      math.max(0.0, vp.right - vi.right),
      math.max(0.0, vp.bottom - vi.bottom),
    );
    return MediaQuery(
      data: data.copyWith(viewPadding: vp, padding: pad),
      child: widget.child,
    );
  }
}
''';
