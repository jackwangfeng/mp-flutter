import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:ui_web' as ui_web;

import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

import 'mp_native_view.dart';

/// Web 平台(mp-flutter 编译产物,或普通浏览器——后者没有 `self.__mpNative`,
/// [isAvailable] 为 false)。
///
/// 契约见 `packages/mp_flutter/runtime/native-views.js` 文件头注释:
/// - 工厂造一个 div,带 `data-mp-native="video|map|camera"`、
///   `data-mp-params="{...}"`、`data-mp-id="&lt;viewId&gt;"` 三个属性(★
///   `data-mp-id` 必须是纯数字字符串——就用引擎分配的平台视图 `viewId`,
///   不要自己另起一套计数器)。
/// - 有 `self.__mpNative` 就 `register(id)`;没有就 push 进
///   `self.__mpNativePending`(数组,自己按需创建)。
/// - 对应视图 dispose 时(哪怕从没被同步层发现过)调 `unregister(id)`——
///   REQUIRED,否则同步层的扫描循环会白跑。
/// - 事件走占位 div 上的 `CustomEvent('mpnative')`,`detail` 是 JSON 字符串
///   `{type, detail}`。
MpNativeBackend createNativeBackend() => _WebBackend();

@JS('__mpNative')
external _NativeBridge? get _bridge;

extension type _NativeBridge._(JSObject _) implements JSObject {
  @JS('command')
  external JSPromise<JSString> _command(
    JSString id,
    JSString method,
    JSString argsJson,
  );
  external void register(JSString id);
  external void unregister(JSString id);
}

/// `command()` 在 `self.__mpNative` 还没被 boot 挂上去之前完全没法调用
/// (契约本身就没保证它一定已经存在)——工厂函数已经用
/// `__mpNativePending` 兜住了这条时序缝隙,这里对称地给 command 也加一段
/// 轮询等待,而不是假设调用方永远晚于 boot 完成。真正的"组件还没渲染完成"
/// 排队/超时逻辑在 JS 侧的 `command()` 自己已经做了(5s),这里只等桥本身
/// 出现。
const _bridgeWaitTimeout = Duration(seconds: 5);
const _bridgeWaitInterval = Duration(milliseconds: 50);

Future<_NativeBridge?> _awaitBridge() async {
  final existing = _bridge;
  if (existing != null) return existing;
  final deadline = DateTime.now().add(_bridgeWaitTimeout);
  while (DateTime.now().isBefore(deadline)) {
    await Future<void>.delayed(_bridgeWaitInterval);
    final b = _bridge;
    if (b != null) return b;
  }
  return null;
}

void _pushPendingId(String id) {
  final g = globalContext;
  final existing = g.has('__mpNativePending') ? g['__mpNativePending'] : null;
  final list = existing == null
      ? <String>[]
      : (existing as JSArray<JSString>).toDart.map((e) => e.toDart).toList();
  list.add(id);
  g['__mpNativePending'] = list.map((e) => e.toJS).toList().toJS;
}

void _removePendingId(String id) {
  final g = globalContext;
  if (!g.has('__mpNativePending')) return;
  final existing = g['__mpNativePending'];
  if (existing == null) return;
  final list = (existing as JSArray<JSString>).toDart
      .map((e) => e.toDart)
      .toList();
  if (!list.remove(id)) return;
  g['__mpNativePending'] = list.map((e) => e.toJS).toList().toJS;
}

void _registerId(int viewId) {
  final id = viewId.toString();
  final b = _bridge;
  if (b != null) {
    b.register(id.toJS);
    return;
  }
  _pushPendingId(id);
}

void _unregisterId(int viewId) {
  final id = viewId.toString();
  final b = _bridge;
  if (b != null) {
    b.unregister(id.toJS);
    return;
  }
  // 桥还没出现:这个 id 至多只可能在 `__mpNativePending` 里,尽力把它撤回,
  // 免得等桥真的出现后被误当成"已登记未发现"多跑一阵子(不撤回也不算错,
  // 见 Task 2 文件头注释,这里是锦上添花)。
  _removePendingId(id);
}

class _WebBackend implements MpNativeBackend {
  final Set<String> _registeredViewTypes = {};
  final Map<int, void Function(String type, Object? detail)?> _handlers = {};
  // 占位 div 自己存一份(而不是靠 `ui_web.platformViewRegistry.getViewById`
  // 反查再做 `is web.HTMLDivElement` 判断)——JS interop 的 extension type
  // 在运行时是被擦除的,`is`/`as` 对它做类型判断并不可靠(dart analyze 也会
  // 报 `invalid_runtime_check_with_js_interop_types`),不如创建时就记好。
  final Map<int, web.HTMLDivElement> _divs = {};

  // ★ 修复轮 1(评审 Important):工厂创建 div 那一刻就已经
  // `register()`/push 到 `__mpNativePending`,但 State 只有在 `onViewCreated`
  // 回调触发后才知道 `viewId`——中间隔着至少一个 microtask(`HtmlElementView`
  // 内部 `_initialize()` 是异步的),`IndexedStack`/Tab 快速切换时 State 完全
  // 可能在这个空档期就被 dispose。`_viewIdByToken` 记住"这个创建请求(token)
  // 对应哪个 viewId"(工厂跑到的那一刻就记),`cancelRequest` 靠它反查,不依赖
  // `onViewCreated` 有没有回调过。
  final Map<Object, int> _viewIdByToken = {};
  // 更早的一种空档:`cancelRequest` 被调用时,工厂甚至还没跑过一次(还查不到
  // `_viewIdByToken`)。记下这个 token,工厂真的跑起来时直接原地撤销,不落地
  // 成"注册了没人会来 unregister"的 id。
  final Set<Object> _cancelledTokens = {};
  int _tokenCounter = 0;

  @override
  bool get isAvailable => _bridge != null;

  @override
  Object createRequestToken() => 'mpnative-req#${_tokenCounter++}';

  String _viewTypeFor(MpNativeKind kind) => 'mp-native-${kind.wireName}';

  web.HTMLDivElement _createElement(
    MpNativeKind kind,
    int viewId,
    Object? params,
  ) {
    final map = params is Map ? params : const {};
    final initialParamsJson = map['paramsJson'] as String? ?? '{}';
    final requestToken = map['requestToken'];

    final div = web.document.createElement('div') as web.HTMLDivElement
      ..setAttribute('data-mp-native', kind.wireName)
      ..setAttribute('data-mp-params', initialParamsJson)
      ..setAttribute('data-mp-id', viewId.toString())
      ..style.display = 'block'
      ..style.width = '100%'
      ..style.height = '100%';
    div.addEventListener(
      'mpnative',
      ((web.Event event) {
        final handler = _handlers[viewId];
        if (handler == null) return;
        final detail = (event as web.CustomEvent).detail;
        if (detail == null) return;
        final raw = (detail as JSString).toDart;
        final parsed = parseNativeEventJson(raw);
        handler(parsed.type, parsed.detail);
      }).toJS,
    );

    if (requestToken != null && _cancelledTokens.remove(requestToken)) {
      // 对应的 State 在工厂真正跑起来之前就已经 dispose 了(见
      // `_viewIdByToken` 上面那段注释)——不落地成正常注册状态,原地撤销。
      _unregisterId(viewId);
      return div;
    }

    _divs[viewId] = div;
    if (requestToken != null) _viewIdByToken[requestToken] = viewId;
    _registerId(viewId);
    return div;
  }

  void _ensureFactoryRegistered(MpNativeKind kind) {
    final viewType = _viewTypeFor(kind);
    if (!_registeredViewTypes.add(viewType)) return;
    ui_web.platformViewRegistry.registerViewFactory(
      viewType,
      (int viewId, {Object? params}) => _createElement(kind, viewId, params),
    );
  }

  @override
  Widget buildView({
    required MpNativeKind kind,
    required String initialParamsJson,
    required Object requestToken,
    required ValueChanged<int> onViewCreated,
  }) {
    _ensureFactoryRegistered(kind);
    return HtmlElementView(
      viewType: _viewTypeFor(kind),
      creationParams: {
        'paramsJson': initialParamsJson,
        'requestToken': requestToken,
      },
      onPlatformViewCreated: onViewCreated,
    );
  }

  @override
  void updateParams(int viewId, String paramsJson) {
    _divs[viewId]?.setAttribute('data-mp-params', paramsJson);
  }

  @override
  void setEventHandler(
    int viewId,
    void Function(String type, Object? detail)? handler,
  ) {
    if (handler == null) {
      _handlers.remove(viewId);
    } else {
      _handlers[viewId] = handler;
    }
  }

  @override
  void cancelRequest(Object requestToken) {
    final viewId = _viewIdByToken.remove(requestToken);
    if (viewId != null) {
      _handlers.remove(viewId);
      _divs.remove(viewId);
      _unregisterId(viewId);
      return;
    }
    // 工厂还没跑过(或者永远不会跑,比如这次创建请求最终没能真正合成进
    // 树):记下来,万一工厂之后真的跑起来,让它自己原地撤销。
    _cancelledTokens.add(requestToken);
    // 永远不会跑的那种没有别的清理路径:按插入序封顶,防无界增长。
    if (_cancelledTokens.length > 256) {
      _cancelledTokens.remove(_cancelledTokens.first);
    }
  }

  @override
  Future<String> sendCommand(int viewId, String method, String argsJson) async {
    final bridge = await _awaitBridge();
    if (bridge == null) {
      throw StateError(
        'mp_flutter_native: 等待 __mpNative 就绪超时(${_bridgeWaitTimeout.inSeconds}s),$method 未发出',
      );
    }
    final result = await bridge
        ._command(viewId.toString().toJS, method.toJS, argsJson.toJS)
        .toDart;
    return result.toDart;
  }

  /// 仅测试用:绕过 Flutter 平台视图的真实创建流程(不需要真的挂一个会被
  /// 引擎合成的 `HtmlElementView`),直接模拟"工厂已经执行过"这一步——用来
  /// 单测 dispose 早于 `onViewCreated` 回调这条竞态路径本身的登记/撤销逻辑。
  /// 方法名以 `debug` 开头,不引入 `package:meta` 依赖(同
  /// `mp_flutter_wechat` 的 `debugSetChannel` 约定)。返回分配到的
  /// (人为构造的、与真实引擎 id 空间不冲突的负数)`viewId`。
  int debugSimulateFactoryRun(
    MpNativeKind kind,
    Object requestToken,
    String paramsJson,
  ) {
    _ensureFactoryRegistered(kind);
    final viewId = --_debugViewIdCounter;
    _createElement(kind, viewId, {
      'paramsJson': paramsJson,
      'requestToken': requestToken,
    });
    return viewId;
  }

  int _debugViewIdCounter = 0;
}

/// 仅测试用:见 [_WebBackend.debugSimulateFactoryRun] 的文档注释。
/// `_WebBackend` 是私有类型,包一层可以从测试文件直接调用的顶层函数
/// (`createNativeBackend()` 拿到的就是它)。
int debugSimulateNativeFactoryRun(
  MpNativeBackend backend,
  MpNativeKind kind,
  Object requestToken,
  String paramsJson,
) {
  if (backend is! _WebBackend) {
    throw UnsupportedError(
      'debugSimulateNativeFactoryRun: backend 不是 _WebBackend(是否传错了 stub 实现?)',
    );
  }
  return backend.debugSimulateFactoryRun(kind, requestToken, paramsJson);
}
