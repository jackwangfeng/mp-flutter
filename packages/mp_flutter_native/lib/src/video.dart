import 'dart:convert';

import 'package:flutter/widgets.dart';

import 'mp_native_view.dart';

/// 控制一个 [MpVideo] 对应的原生 `<video>` 组件。
///
/// 只在对应的 [MpVideo] 已经在小程序环境里创建完成后才可用;其它情况下
/// (stub 平台、`mpNativeAvailable` 为 false、还没 build 过、或者对应 widget
/// 已经 dispose)调用这里任意方法都抛 [UnsupportedError]。
///
/// 首次播放优先用 [MpVideo.autoplay](写进 WXML `<video autoplay>` 声明式
/// 驱动),不要在创建后立刻调 [play]——那一刻原生组件很可能还没渲染完成,
/// 命令会先进 Task 2 同步层的排队(最多等 5s),不如直接用 autoplay。
class MpVideoController extends MpNativeControllerBinding {
  Future<void> play() async {
    await sendCommand('play');
  }

  Future<void> pause() async {
    await sendCommand('pause');
  }

  Future<void> seek(double seconds) async {
    await sendCommand('seek', {'position': seconds});
  }

  Future<void> stop() async {
    await sendCommand('stop');
  }

  Future<void> requestFullScreen() async {
    await sendCommand('requestFullScreen');
  }

  Future<void> exitFullScreen() async {
    await sendCommand('exitFullScreen');
  }
}

/// 小程序原生 `<video>` 组件。
///
/// ★ 原生组件总是叠在所有 Flutter 内容之上(小程序把它作为原生视图与
/// WXML 伴生层同层叠加合成,不受 Flutter 绘制顺序影响):如果在 Flutter
/// 树里把别的内容盖在 [MpVideo] 上面(比如一个弹层的背景),那部分内容会
/// 被这个视频组件遮住,而不是相反。
///
/// 非 mp-flutter 编译的小程序环境(含 stub 平台与普通浏览器)下渲染
/// [fallback](默认空)。
class MpVideo extends StatelessWidget {
  const MpVideo({
    super.key,
    required this.src,
    this.autoplay = false,
    this.loop = false,
    this.muted = false,
    this.controls = true,
    this.poster,
    this.objectFit = 'contain',
    this.controller,
    this.onPlay,
    this.onPause,
    this.onEnded,
    this.onTimeUpdate,
    this.onError,
    this.fallback,
  });

  final String src;
  final bool autoplay;
  final bool loop;
  final bool muted;
  final bool controls;
  final String? poster;
  final String objectFit;
  final MpVideoController? controller;
  final VoidCallback? onPlay;
  final VoidCallback? onPause;
  final VoidCallback? onEnded;
  final ValueChanged<double>? onTimeUpdate;
  final ValueChanged<String>? onError;
  final Widget? fallback;

  Map<String, Object?> _params() => {
        'src': src,
        'autoplay': autoplay,
        'loop': loop,
        'muted': muted,
        'controls': controls,
        if (poster != null) 'poster': poster,
        'objectFit': objectFit,
      };

  /// 仅测试/调试用:当前会写进 `data-mp-params` 的 JSON 字符串。方法名以
  /// `debug` 开头,不引入 `package:meta` 依赖(同 `mp_flutter_wechat` 的
  /// `debugSetChannel` 约定)。
  String debugParamsJson() => jsonEncode(_params());

  /// 仅测试/调试用:直接喂一条(已解析出 type/detail 的)原生事件,驱动到
  /// 对应的 `on*` 回调——不需要真的起一个浏览器/DOM。
  void debugHandleEvent(String type, Object? detail) => _onEvent(type, detail);

  void _onEvent(String type, Object? detail) {
    switch (type) {
      case 'play':
        onPlay?.call();
      case 'pause':
        onPause?.call();
      case 'ended':
        onEnded?.call();
      case 'timeupdate':
        final currentTime = detail is Map ? detail['currentTime'] : null;
        if (currentTime is num) onTimeUpdate?.call(currentTime.toDouble());
      case 'error':
        final errMsg = detail is Map ? detail['errMsg'] : detail;
        onError?.call(errMsg?.toString() ?? 'unknown error');
    }
  }

  @override
  Widget build(BuildContext context) {
    return MpNativeView(
      kind: MpNativeKind.video,
      params: _params(),
      controller: controller,
      onEvent: _onEvent,
      fallback: fallback,
    );
  }
}
