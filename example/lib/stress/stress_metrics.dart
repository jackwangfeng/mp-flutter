import 'dart:async';

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'stress_flags.dart';

/// 逐帧记录帧间隔,算 fps/最长帧/jank 计数。
///
/// 刻意不用 [SchedulerBinding.addTimingsCallback](`FrameTiming`)——按
/// 任务要求,帧间隔用 [Ticker] 或 [SchedulerBinding] 的回调记录:这里用裸
/// [Ticker](不挂在任何 `TickerProviderStateMixin` 上,自己管生命周期),
/// 每帧回调一次 `elapsed`,与上一次的差值就是这一帧的耗时。
class FrameRecorder {
  Ticker? _ticker;
  Duration? _last;

  int frames = 0;
  double _totalMs = 0;
  double maxMs = 0;
  int jank50 = 0;
  int jank100 = 0;

  bool get isRunning => _ticker?.isActive ?? false;

  void start() {
    _last = null;
    _ticker = Ticker(_onTick)..start();
  }

  void _onTick(Duration elapsed) {
    final last = _last;
    if (last != null) {
      final dtMs = (elapsed - last).inMicroseconds / 1000.0;
      frames++;
      _totalMs += dtMs;
      if (dtMs > maxMs) maxMs = dtMs;
      if (dtMs > 50) jank50++;
      if (dtMs > 100) jank100++;
    }
    _last = elapsed;
  }

  Future<void> stop() async {
    final t = _ticker;
    _ticker = null;
    if (t == null) return;
    if (t.isActive) t.stop();
    t.dispose();
  }

  /// 滚动期平均 fps(总帧数 / 总耗时),没有采到任何帧间隔时记 0。
  double get avgFps => (frames == 0 || _totalMs <= 0) ? 0 : 1000.0 * frames / _totalMs;
}

/// `ScrollController.animateTo` 滚到底再滚回顶,速度固定,保证可复现。
/// 内容不可滚动(`maxScrollExtent <= 0`)时直接返回,不报错——个别项在冒烟
/// 测试的缩小规模下可能真的没有可滚动的内容。
Future<void> autoScrollDownAndUp(ScrollController controller, {required double speedPxPerSec}) async {
  if (!controller.hasClients) return;
  final max = controller.position.maxScrollExtent;
  if (max <= 0) return;
  final ms = (max / speedPxPerSec * 1000).round().clamp(16, 10 * 60 * 1000);
  final duration = Duration(milliseconds: ms);
  await controller.animateTo(max, duration: duration, curve: Curves.linear);
  if (!controller.hasClients) return;
  await controller.animateTo(0, duration: duration, curve: Curves.linear);
}

double _round1(double v) => (v * 10).round() / 10;

/// 拼出固定格式的一行遥测(反引号内是字面格式,不是文档引用):
/// `[mp-stress] id first=首帧ms fps=滚动期平均 max=最长帧ms
/// jank50=大于50ms帧数 jank100=大于100ms帧数 frames=总帧数 extra=项目相关字段`
String formatStressLine({
  required String id,
  required double firstMs,
  required FrameRecorder recorder,
  required String extra,
}) {
  return '$kStressLogPrefix $id '
      'first=${_round1(firstMs)} '
      'fps=${_round1(recorder.avgFps)} '
      'max=${_round1(recorder.maxMs)} '
      'jank50=${recorder.jank50} '
      'jank100=${recorder.jank100} '
      'frames=${recorder.frames} '
      'extra=$extra';
}
