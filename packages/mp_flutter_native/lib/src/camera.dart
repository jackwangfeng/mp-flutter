import 'dart:convert';

import 'package:flutter/widgets.dart';

import 'mp_native_view.dart';

/// 控制一个 [MpCamera] 对应的原生 `<camera>` 组件。
///
/// 只在对应的 [MpCamera] 已经在小程序环境里创建完成后才可用;其它情况下
/// 调用任意方法都抛 [UnsupportedError]。
class MpCameraController extends MpNativeControllerBinding {
  /// `wx.createCameraContext().takePhoto`;返回临时图片路径
  /// (`tempImagePath`)。
  Future<String> takePhoto({String quality = 'normal'}) async {
    final raw = await sendCommand('takePhoto', {'quality': quality});
    final decoded = jsonDecode(raw);
    if (decoded is Map) {
      final path = decoded['tempImagePath'];
      if (path is String) return path;
    }
    // 兜底:万一原生层直接返回了裸路径字符串而不是 JSON 对象。
    return raw;
  }
}

/// 小程序原生 `<camera>` 组件。
///
/// ★ 原生组件总是叠在所有 Flutter 内容之上:Flutter 里想盖在 [MpCamera] 上
/// 面的内容(比如取景框装饰),实际效果是被摄像头画面遮住,而不是盖住它。
///
/// 非 mp-flutter 编译的小程序环境下渲染 [fallback](默认空)。
class MpCamera extends StatelessWidget {
  const MpCamera({
    super.key,
    this.devicePosition = 'back',
    this.flash = 'auto',
    this.controller,
    this.onError,
    this.fallback,
  });

  final String devicePosition;
  final String flash;
  final MpCameraController? controller;
  final ValueChanged<String>? onError;
  final Widget? fallback;

  Map<String, Object?> _params() => {
        'devicePosition': devicePosition,
        'flash': flash,
      };

  /// 仅测试/调试用,见 `MpVideo.debugParamsJson`。
  String debugParamsJson() => jsonEncode(_params());

  /// 仅测试/调试用,见 `MpVideo.debugHandleEvent`。
  void debugHandleEvent(String type, Object? detail) => _onEvent(type, detail);

  void _onEvent(String type, Object? detail) {
    if (type == 'error') {
      final errMsg = detail is Map ? detail['errMsg'] : detail;
      onError?.call(errMsg?.toString() ?? 'unknown error');
    }
  }

  @override
  Widget build(BuildContext context) {
    return MpNativeView(
      kind: MpNativeKind.camera,
      params: _params(),
      controller: controller,
      onEvent: _onEvent,
      fallback: fallback,
    );
  }
}
