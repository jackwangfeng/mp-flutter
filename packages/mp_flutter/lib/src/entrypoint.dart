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
/// 顺带(cjk_font_bold):首帧之后监听 `self.__mpLateFonts`(runtime/cjk-font.js
/// createCjkBold),晚到的合一字体粗体经 `ui.loadFontFromList` 补注册——只有
/// Dart 侧能让引擎注册字体并发 fontsChange。桥不存在(没带粗体)时什么也不做。
///
/// 顺带(表单聚焦):iOS 目标平台下让 TextField 光标常亮,不跑 60fps 的淡入淡出
/// 动画(见生成代码里 `_steadyCursorOnIOS` 的注释)。密码框聚焦期间临时恢复正常
/// 闪烁(`self.__mpPasswordFocus`,text-bridge.js 在聚焦/失焦时通知),否则密码
/// 最后一位明文字符会因为光标 tick 不再跑而一直不隐藏(I1)。
///
/// 顺带(--perf-hud):`self.__mpFrameProf` 存在时(只有 --perf-hud 承载页才挂),
/// 绑定按帧把框架各阶段耗时(transient/build/layout/paint/合成/语义/帧后回调)与
/// 视口度量变化次数报给它(runtime/perf-hud.js createFrameProf);不存在时各覆盖
/// 直接走 super。
///
/// [targetImport] 是入口文件的 import URI(`package:` 形式或相对入口包装自身
/// 的相对 import,见 [entrypointImportFor]);缺省(仅供单测直接调用本函数时
/// 使用)按旧行为拼 `package:$packageName/main.dart`。
String buildEntrypointSource(String packageName, {String? targetImport}) => '''
// 由 mp_flutter 生成,勿手改。见 mp_flutter/lib/src/entrypoint.dart。
// ignore_for_file: type=lint
import 'dart:js_interop';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import '${targetImport ?? 'package:$packageName/main.dart'}' as app;

void main() {
  _MpBinding();
  _listenLateFonts();
  _steadyCursorOnIOS();
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

  // ---- --perf-hud 帧分项(接收端 self.__mpFrameProf 不存在时全部直接走 super)----

  @override
  PipelineOwner createRootPipelineOwner() =>
      _prof == null ? super.createRootPipelineOwner() : _ProfRootPipelineOwner();

  @override
  void handleBeginFrame(Duration? rawTimeStamp) {
    if (_prof == null) return super.handleBeginFrame(rawTimeStamp);
    final t0 = _t();
    super.handleBeginFrame(rawTimeStamp);
    _transient += _t() - t0;
  }

  @override
  void drawFrame() {
    if (_prof == null) return super.drawFrame();
    _tDrawStart = _t();
    super.drawFrame();
    _tDrawEnd = _t();
  }

  @override
  void handleMetricsChanged() {
    _metrics++;
    super.handleMetricsChanged();
  }

  @override
  void handleDrawFrame() {
    final prof = _prof;
    if (prof == null) return super.handleDrawFrame();
    _tDrawStart = _tDrawEnd = _tLayoutStart = _tLayoutEnd = _tBitsEnd = _tPaintEnd = _tSemStart = _tSemEnd = -1;
    final t0 = _t();
    super.handleDrawFrame();
    final total = _t() - t0;
    double span(double a, double b) => a >= 0 && b >= a ? b - a : 0;
    final draw = span(_tDrawStart, _tDrawEnd);
    final build = _tLayoutStart >= 0 ? span(_tDrawStart, _tLayoutStart) : draw;
    final view = platformDispatcher.implicitView;
    final inset = view == null ? 0.0 : view.viewInsets.bottom / view.devicePixelRatio;
    prof.frame(
      _transient.toJS, build.toJS, span(_tLayoutStart, _tLayoutEnd).toJS, span(_tLayoutEnd, _tBitsEnd).toJS,
      span(_tBitsEnd, _tPaintEnd).toJS, span(_tPaintEnd, _tSemStart).toJS, span(_tSemStart, _tSemEnd).toJS,
      span(_tSemEnd, _tDrawEnd).toJS, math.max(0.0, total - draw).toJS, _metrics.toJS, inset.toJS);
    _transient = 0;
    _metrics = 0;
  }
}

@JS('__mpFrameProf')
external _FrameProfBridge? get _frameProfBridge;

extension type _FrameProfBridge._(JSObject _) implements JSObject {
  external void frame(JSNumber transient, JSNumber build, JSNumber layout, JSNumber bits, JSNumber paint,
      JSNumber comp, JSNumber sem, JSNumber fin, JSNumber post, JSNumber metrics, JSNumber inset);
}

// 帧分项计时(见 runtime/perf-hud.js createFrameProf):只有 --perf-hud 构建的承载页
// 才在 main.dart.js 加载前挂上 self.__mpFrameProf;没有时下面这些都不会被用到
final _FrameProfBridge? _prof = _frameProfBridge;
final Stopwatch _clock = Stopwatch()..start();
double _t() => _clock.elapsedMicroseconds / 1000.0;
double _transient = 0;
int _metrics = 0;
double _tDrawStart = -1, _tDrawEnd = -1, _tLayoutStart = -1, _tLayoutEnd = -1;
double _tBitsEnd = -1, _tPaintEnd = -1, _tSemStart = -1, _tSemEnd = -1;

// 根 PipelineOwner 的计时版:与框架默认的 _DefaultRootPipelineOwner 一样不管理
// rootNode(各 View 的子 owner 挂在它下面),只在四个 flush 前后打点
final class _ProfRootPipelineOwner extends PipelineOwner {
  _ProfRootPipelineOwner() : super(onSemanticsUpdate: (_) {});

  @override
  set rootNode(RenderObject? _) {}

  @override
  void flushLayout() {
    _tLayoutStart = _t();
    super.flushLayout();
    _tLayoutEnd = _t();
  }

  @override
  void flushCompositingBits() {
    super.flushCompositingBits();
    _tBitsEnd = _t();
  }

  @override
  void flushPaint() {
    super.flushPaint();
    _tPaintEnd = _t();
  }

  @override
  void flushSemantics() {
    _tSemStart = _t();
    super.flushSemantics();
    _tSemEnd = _t();
  }
}

// iOS 目标平台(按 UA 判定)下 TextField 的光标是淡入淡出动画(cursorOpacityAnimates
// 默认 true):AnimationController 每个 vsync 都 tick,输入框聚焦期间应用一直以
// 60fps 出帧,每帧都整屏合成 + 光栅化(Web 引擎没有局部重绘)。无 JIT 的 iOS 小程序
// 上每帧几十 ms,聚焦后整页持续卡顿、打字跟手变差(模拟器实测:每次聚焦保持
// 1.5s,共 429 帧)。这里让光标常亮不闪(EditableText.debugDeterministicCursor 在
// release 下同样生效,只影响闪烁),聚焦后没有别的动画就不再出帧。安卓等平台的
// 光标是 500ms 定时器切换(每秒 2 帧),不动。应用想要回闪烁光标:在 main() 里
// 把 EditableText.debugDeterministicCursor 设回 false(入口包装先于 main() 设置)。
//
// I1 修复(密码框最后一位明文常驻):引擎 editable_text.dart 的
// `_obscureShowCharTicksPending`(隐藏刚输入的那个字符前,短暂明文显示的计时)
// 只在 `_onCursorTick` 里递减,而 `debugDeterministicCursor=true` 时
// `_startCursorBlink` 直接 return,永远不建定时器、`_onCursorTick` 不会执行——
// 密码框输完最后一个字符停下来,它会一直明文显示到下一次输入或失焦。
// 这里听 `self.__mpPasswordFocus`(text-bridge.js 在检测到 `password:true` 的
// 输入框聚焦/失焦时维护,见该文件 `createTextBridge` 里 `attach()`/blur 分支):
// 密码框聚焦时临时把标志切回 false,失焦后恢复 true。改值当下不会立即生效,但
// 用户在密码框里的下一次按键会经 `_didChangeTextEditingValue` 重新调用
// `_startCursorBlink`(此时 `_cursorTimer` 仍是 null),从而真正建起定时器——
// 足够在隐藏"当前正在打的这个字符"之前生效,不影响其余 iOS 输入框仍然光标常亮。
void _steadyCursorOnIOS() {
  if (defaultTargetPlatform == TargetPlatform.iOS || defaultTargetPlatform == TargetPlatform.macOS) {
    EditableText.debugDeterministicCursor = true;
    final b = _passwordFocusBridge;
    if (b != null) {
      b.listen((() {
        final obscure = b.obscure?.toDart ?? false;
        EditableText.debugDeterministicCursor = !obscure;
      }).toJS);
    }
  }
}

@JS('__mpPasswordFocus')
external _PasswordFocusBridge? get _passwordFocusBridge;

extension type _PasswordFocusBridge._(JSObject _) implements JSObject {
  external JSBoolean? get obscure;
  external JSFunction listen(JSFunction fn);
}

@JS('__mpLateFonts')
external _LateFontsBridge? get _lateFonts;

extension type _LateFontsBridge._(JSObject _) implements JSObject {
  external void listen(JSFunction fn);
}

// 首帧画完之后才开始收:晚到的字体注册会发 fontsChange、整体重排一次,不能
// 挤进首帧;首帧前就到的字体已经随 FontManifest 注册,不经这里
void _listenLateFonts() {
  final b = _lateFonts;
  if (b == null) return;
  WidgetsBinding.instance.addPostFrameCallback((_) {
    Future<void>.delayed(Duration.zero, () {
      b.listen(((JSUint8Array bytes, JSString family) {
        ui.loadFontFromList(bytes.toDart, fontFamily: family.toDart);
      }).toJS);
    });
  });
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
