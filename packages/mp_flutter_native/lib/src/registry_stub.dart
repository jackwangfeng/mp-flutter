import 'package:flutter/widgets.dart';

import 'mp_native_view.dart';

/// 非 Web 平台(Android/iOS/桌面/`flutter test` 默认的 VM 测试目标):没有
/// mp-flutter 的 JS 同步层,原生组件永远不可用。
MpNativeBackend createNativeBackend() => _StubBackend();

class _StubBackend implements MpNativeBackend {
  @override
  bool get isAvailable => false;

  @override
  Object createRequestToken() => Object();

  @override
  Widget buildView({
    required MpNativeKind kind,
    required String initialParamsJson,
    required Object requestToken,
    required ValueChanged<int> onViewCreated,
  }) {
    // isAvailable 恒 false,MpNativeView 的 build() 不会走到这里;真的走到
    // 说明调用方绕过了 isAvailable 检查,属于用法错误。
    throw UnsupportedError('mp_flutter_native: 当前平台不支持原生组件,不应该调用 buildView');
  }

  @override
  void updateParams(int viewId, String paramsJson) {}

  @override
  void setEventHandler(
    int viewId,
    void Function(String type, Object? detail)? handler,
  ) {}

  @override
  void cancelRequest(Object requestToken) {}

  @override
  Future<String> sendCommand(int viewId, String method, String argsJson) =>
      throw UnsupportedError(
        'mp_flutter_native: $method 仅在 mp-flutter 编译的小程序中可用',
      );
}
