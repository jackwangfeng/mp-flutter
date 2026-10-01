import 'dart:convert';

import 'package:flutter/widgets.dart';

import 'registry_stub.dart'
    if (dart.library.js_interop) 'registry_web.dart'
    as backend;

/// 小程序原生组件的三种类型;与 Task 2 同步层约定的 `data-mp-native` 取值
/// 一一对应(见 `packages/mp_flutter/runtime/native-views.js` 文件头注释)。
enum MpNativeKind {
  video('video'),
  map('map'),
  camera('camera');

  const MpNativeKind(this.wireName);

  /// 写进 `data-mp-native` 属性、也是 wx 组件 id 前缀(`mpv-`/`mpm-`)选择
  /// 依据的字符串。
  final String wireName;
}

/// 平台后端:Web(mp-flutter 编译产物)下真正创建/更新/销毁占位 DOM 元素并
/// 转发命令;非 Web(stub)下报告不可用,任何命令都拒绝。
///
/// 两份实现分别在 `registry_web.dart`/`registry_stub.dart` 里,通过顶层的
/// `if (dart.library.js_interop)` 条件导入选择(镜像
/// `package:mp_flutter_wechat` 的 `channel_stub.dart`/`channel_web.dart`)。
abstract class MpNativeBackend {
  /// 当前平台/环境下原生组件是否可用——即是否存在 Task 2 挂的
  /// `self.__mpNative` 同步层桥,或者至少运行在支持它的 Web 环境里。
  ///
  /// `mpNativeAvailable`(本文件底部的顶层 getter)就是它的转发。
  bool get isAvailable;

  /// 生成一个"创建请求"标识,一个 [MpNativeView] 的 State 在 [initState]
  /// 里领一个、贯穿自己整个生命周期。
  ///
  /// 存在的理由(评审 Important,修复轮 1):JS 工厂在**创建 div 的那一刻**
  /// 就会 `register(id)`/push 到 `__mpNativePending`(见 Task 2 文件头
  /// 注释),但 [buildView] 的 `onViewCreated` 回调——也就是 State 知道
  /// `viewId` 的唯一途径——要等 `HtmlElementView` 内部 `_initialize()` 那个
  /// `Future` 的 `.then()` continuation 才触发,中间隔着至少一个 microtask。
  /// `IndexedStack`/Tab 快速切换等场景下,State 完全可能在这个空档期就被
  /// dispose——那时候 `_viewId` 还是 `null`,如果 [cancelRequest] 只在
  /// `_viewId != null` 时才处理,就会把这个已经在真实注册表里的 id
  /// 遗漏掉,让同步循环永远以为它"已登记未发现"。用一个与 `viewId` 无关、
  /// 从 `initState` 起就存在的 token 反查,dispose 时不管工厂跑没跑、
  /// `onViewCreated` 回调没回调,都能定位到并撤销。
  Object createRequestToken();

  /// 创建(或复用已注册的)`viewType` 对应的 `HtmlElementView`。[requestToken]
  /// 是这次创建请求的标识(见 [createRequestToken]),会经 `creationParams`
  /// 一并交给工厂,工厂据此把"引擎分配的 viewId"登记到这个 token 名下。
  /// [onViewCreated] 在 Flutter 引擎真正创建好平台视图后触发,携带引擎分配
  /// 的 `viewId`——该 id 也就是将要写进 `data-mp-id` 的那个数字。
  Widget buildView({
    required MpNativeKind kind,
    required String initialParamsJson,
    required Object requestToken,
    required ValueChanged<int> onViewCreated,
  });

  /// 把 [paramsJson] 写回 `viewId` 对应占位元素的 `data-mp-params`。
  void updateParams(int viewId, String paramsJson);

  /// 设置(或清空,传 null)`viewId` 收到 `mpnative` 事件时要调用的回调。
  void setEventHandler(
    int viewId,
    void Function(String type, Object? detail)? handler,
  );

  /// 对应 widget 已 dispose,取代旧的"按 viewId 撤销"接口——不管
  /// [requestToken] 对应的平台视图有没有创建完成(工厂有没有跑过、
  /// `onViewCreated` 有没有回调过),都要正确地
  /// `self.__mpNative.unregister(id)` 或撤回 `__mpNativePending` 里的
  /// 登记(REQUIRED:一个注册过、从未被同步层发现、也从未撤销的 id 会让
  /// 同步层的扫描循环无谓地跑下去,见 Task 2 文件头注释),不能因为"还不
  /// 知道 viewId"就跳过。
  void cancelRequest(Object requestToken);

  /// 转发 `self.__mpNative.command(id, method, argsJson)`。
  Future<String> sendCommand(int viewId, String method, String argsJson);
}

final MpNativeBackend _backend = backend.createNativeBackend();

/// 当前平台/环境下小程序原生组件是否可用(仅在 mp-flutter 编译产物里为
/// true)。为 false 时,[MpVideo]/[MpMap]/[MpCamera] 一律渲染各自的
/// `fallback`,控制器方法一律抛 [UnsupportedError]。
bool get mpNativeAvailable => _backend.isAvailable;

/// 解析 Task 2 通过 `CustomEvent('mpnative')` 派发的 `detail`(JSON 字符串
/// `{"type": ..., "detail": ...}`)。纯函数,VM/Web 都能跑,不依赖任何 DOM
/// API,方便离线单测事件分派逻辑而不必真的起一个浏览器。
///
/// 解析失败(不是合法 JSON,或者不是一个 JSON 对象)时返回
/// `(type: '', detail: null)`,调用方按"忽略这次事件"处理,不抛错——真实
/// 环境下这个字符串完全由 Task 2 自己序列化产出,不该出现这种情况,但测试/
/// 防御性编程上不假设它一定合法。
({String type, Object? detail}) parseNativeEventJson(String raw) {
  Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } catch (_) {
    return (type: '', detail: null);
  }
  if (decoded is! Map) return (type: '', detail: null);
  final type = decoded['type'];
  return (type: type is String ? type : '', detail: decoded['detail']);
}

/// 所有 `Mp*Controller`([MpVideoController]/[MpMapController]/
/// [MpCameraController])共享的"怎么把命令发出去"这部分逻辑。
///
/// 一个控制器实例可以在其绑定的 [MpVideo]/[MpMap]/[MpCamera] 从树上移除后
/// 继续存在(比如存在 `State` 字段里跨帧使用)——那之后 [sendCommand] 应该
/// 抛 [UnsupportedError],而不是崩溃或者悄悄无效,所以"当前有没有一个活的
/// 原生视图接着"是用可空的 sender 字段表示的,由 [MpNativeView] 的 State 在
/// attach/detach 时维护。
abstract class MpNativeControllerBinding {
  Future<String> Function(String method, [Map<String, Object?> args])? _sender;

  void _bind(
    Future<String> Function(String method, [Map<String, Object?> args]) sender,
  ) {
    _sender = sender;
  }

  void _unbind() {
    _sender = null;
  }

  /// 子类(`MpVideoController` 等)调用这个来真正发出一条命令。未绑定到任何
  /// 已创建的原生视图时(stub 平台、原生组件还没渲染完成前就被 dispose、
  /// 或者单纯还没 build 过一次)抛 [UnsupportedError],说明"仅小程序可用"。
  Future<String> sendCommand(
    String method, [
    Map<String, Object?> args = const {},
  ]) {
    final sender = _sender;
    if (sender == null) {
      throw UnsupportedError(
        'mp_flutter_native: 该操作仅在 mp-flutter 编译的小程序中、且对应的原生组件已创建后可用',
      );
    }
    return sender(method, args);
  }
}

/// [MpVideo]/[MpMap]/[MpCamera] 共用的内部承载 widget:管理占位元素的创建/
/// 参数更新/事件转发/控制器绑定/销毁。三个公开 widget 都是 `StatelessWidget`
/// (按 brief 的 API 要求),真正的可变状态都在这里。
class MpNativeView extends StatefulWidget {
  const MpNativeView({
    super.key,
    required this.kind,
    required this.params,
    this.controller,
    this.onEvent,
    this.fallback,
  });

  final MpNativeKind kind;

  /// 必须是 JSON 可编码的(`jsonEncode` 不抛错)——写进 `data-mp-params`。
  final Map<String, Object?> params;

  final MpNativeControllerBinding? controller;

  /// 收到 `mpnative` 事件(已解析出 type/detail)时调用。
  final void Function(String type, Object? detail)? onEvent;

  /// stub 平台,或 Web 上 `mpNativeAvailable` 为 false 时渲染的内容;
  /// 默认为空(`SizedBox.shrink()`)。
  final Widget? fallback;

  @override
  State<MpNativeView> createState() => _MpNativeViewState();
}

class _MpNativeViewState extends State<MpNativeView> {
  int? _viewId;
  late String _paramsJson;
  late final Object _requestToken;

  @override
  void initState() {
    super.initState();
    _paramsJson = jsonEncode(widget.params);
    _requestToken = _backend.createRequestToken();
  }

  @override
  void didUpdateWidget(covariant MpNativeView oldWidget) {
    super.didUpdateWidget(oldWidget);

    final newParamsJson = jsonEncode(widget.params);
    if (newParamsJson != _paramsJson) {
      _paramsJson = newParamsJson;
      final id = _viewId;
      if (id != null) _backend.updateParams(id, newParamsJson);
    }

    final id = _viewId;
    if (id != null) _backend.setEventHandler(id, widget.onEvent);

    if (!identical(widget.controller, oldWidget.controller)) {
      oldWidget.controller?._unbind();
      _bindController();
    }
  }

  void _bindController() {
    final id = _viewId;
    final controller = widget.controller;
    if (id == null || controller == null) return;
    controller._bind(
      (method, [args = const {}]) =>
          _backend.sendCommand(id, method, jsonEncode(args)),
    );
  }

  void _onViewCreated(int id) {
    _viewId = id;
    // 用最新的(可能在 build() 之后、平台视图真正创建之前又变过的)参数/
    // 事件回调兜底写一次,不依赖 creationParams 只在“首次创建”那一刻生效
    // 这个时序假设。
    _backend.updateParams(id, _paramsJson);
    _backend.setEventHandler(id, widget.onEvent);
    _bindController();
  }

  @override
  void dispose() {
    // 不按 `_viewId != null` 短路——`cancelRequest` 自己会处理"viewId 还
    // 不知道,但工厂其实已经跑过"这条竞态路径(见 [MpNativeBackend.
    // createRequestToken] 的文档)。
    _backend.cancelRequest(_requestToken);
    widget.controller?._unbind();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_backend.isAvailable) {
      return widget.fallback ?? const SizedBox.shrink();
    }
    return _backend.buildView(
      kind: widget.kind,
      initialParamsJson: _paramsJson,
      requestToken: _requestToken,
      onViewCreated: _onViewCreated,
    );
  }
}
