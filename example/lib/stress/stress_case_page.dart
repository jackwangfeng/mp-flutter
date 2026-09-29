import 'dart:async';

import 'package:flutter/material.dart';

import 'stress_config.dart';
import 'stress_metrics.dart';

/// 单个压测项的通用外壳:量首帧、自动滚到底再滚回顶(期间录帧),滚动结束后
/// 可选跑一段额外交互(比如 E 项的 focus/unfocus 循环,不计入滚动期 fps),
/// 最后拼 extra 字段、print 遥测行、`pop` 自己。
///
/// 每个 case 只需要提供:标题、构建内容的 `contentBuilder`(拿到一个
/// [ScrollController],负责把它接到自己的可滚动 widget 上)、滚动结束后的
/// `afterScroll`(可选)、以及算 extra 字段的 `buildExtra`。
class StressCasePage extends StatefulWidget {
  const StressCasePage({
    super.key,
    required this.id,
    required this.title,
    required this.pushStartMs,
    required this.contentBuilder,
    required this.buildExtra,
    this.afterScroll,
  });

  final String id;
  final String title;
  final int pushStartMs;
  final Widget Function(BuildContext context, ScrollController controller) contentBuilder;

  /// 滚动(下→上)结束之后跑的额外步骤,不计入 fps/jank 统计(比如 E 的
  /// focus/unfocus 循环)。
  final Future<void> Function()? afterScroll;

  /// 算 extra 字段——在 [afterScroll] 跑完之后调用,可以是纯同步的静态统计
  /// (比如 B 的 URL 去重计数),也可以是依赖 [afterScroll] 结果的闭包状态。
  final String Function() buildExtra;

  @override
  State<StressCasePage> createState() => _StressCasePageState();
}

class _StressCasePageState extends State<StressCasePage> {
  final _scroll = ScrollController();
  final _recorder = FrameRecorder();
  double? _firstMs;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _firstMs = (DateTime.now().millisecondsSinceEpoch - widget.pushStartMs).toDouble();
      // 首帧 build+paint 完成之后再启动滚动:等一小步(不计入首帧/滚动期
      // 统计)让布局彻底稳定,避免 maxScrollExtent 在刚 layout 完的同一帧
      // 读到 0。
      Future.delayed(const Duration(milliseconds: 32), _run);
    });
  }

  Future<void> _run() async {
    if (!mounted) return;
    _recorder.start();
    await autoScrollDownAndUp(_scroll, speedPxPerSec: StressConfig.scrollSpeedPxPerSec);
    await _recorder.stop();
    final afterScroll = widget.afterScroll;
    if (afterScroll != null) await afterScroll();
    final line = formatStressLine(
      id: widget.id,
      firstMs: _firstMs ?? 0,
      recorder: _recorder,
      extra: widget.buildExtra(),
    );
    // ignore: avoid_print
    print(line);
    if (mounted) Navigator.of(context).pop();
  }

  @override
  void dispose() {
    _recorder.stop();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: widget.contentBuilder(context, _scroll),
    );
  }
}
