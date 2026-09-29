import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../stress_case_page.dart';
import '../stress_config.dart';

/// E:大表单——30 个 `TextField`,夹杂 `Switch`/`Radio`/`Dropdown`。测首开耗时
/// (走 `StressCasePage` 通用的 first=),并在滚动结束后自动对前 5 个输入框
/// 依次 `requestFocus` 再 `unfocus`,记录每次聚焦到下一帧完成的耗时
/// (extra: `focusMax=`,取 5 次里最长的一次)。
class StressCaseE extends StatefulWidget {
  const StressCaseE({super.key, required this.pushStartMs});
  final int pushStartMs;

  static const id = 'E_big_form';

  @override
  State<StressCaseE> createState() => _StressCaseEState();
}

class _StressCaseEState extends State<StressCaseE> {
  late final List<FocusNode> _focusNodes =
      List.generate(StressConfig.formFieldCount, (_) => FocusNode());
  late final List<TextEditingController> _controllers =
      List.generate(StressConfig.formFieldCount, (_) => TextEditingController());
  final List<double> _focusMs = [];

  bool _switchVal = false;
  int _radioVal = 0;
  String _dropdownVal = 'A';

  @override
  void dispose() {
    for (final n in _focusNodes) {
      n.dispose();
    }
    for (final c in _controllers) {
      c.dispose();
    }
    super.dispose();
  }

  /// 从 `requestFocus()` 到下一帧 build+paint 完成的耗时(毫秒)。
  Future<double> _measureFocus(FocusNode node) async {
    final sw = Stopwatch()..start();
    node.requestFocus();
    final completer = Completer<void>();
    WidgetsBinding.instance.addPostFrameCallback((_) => completer.complete());
    // 聚焦通常会触发 Focus 相关 widget 的 rebuild、隐式已经排了一帧;这里
    // 显式再排一次兜底,避免某些平台上纯焦点变化不触发重绘导致等不到回调。
    SchedulerBinding.instance.scheduleFrame();
    await completer.future;
    sw.stop();
    node.unfocus();
    // 给 unfocus 一点时间落地,再进入下一次聚焦,避免连续聚焦互相干扰。
    await Future.delayed(const Duration(milliseconds: 30));
    return sw.elapsedMicroseconds / 1000.0;
  }

  Future<void> _runFocusLoop() async {
    _focusMs.clear();
    final sampleCount = StressConfig.formFocusSampleCount.clamp(0, _focusNodes.length);
    for (var i = 0; i < sampleCount; i++) {
      _focusMs.add(await _measureFocus(_focusNodes[i]));
    }
  }

  @override
  Widget build(BuildContext context) {
    return StressCasePage(
      id: StressCaseE.id,
      title: 'E 大表单(${StressConfig.formFieldCount} 输入框)',
      pushStartMs: widget.pushStartMs,
      afterScroll: _runFocusLoop,
      buildExtra: () {
        final focusMax = _focusMs.isEmpty ? 0.0 : _focusMs.reduce((a, b) => a > b ? a : b);
        return 'focusMax=${(focusMax * 10).round() / 10}';
      },
      contentBuilder: (context, controller) => ListView.builder(
        controller: controller,
        padding: const EdgeInsets.all(16),
        itemCount: StressConfig.formFieldCount + 3,
        itemBuilder: (context, i) {
          if (i == 0) {
            return SwitchListTile(
              title: const Text('开关'),
              value: _switchVal,
              onChanged: (v) => setState(() => _switchVal = v),
            );
          }
          if (i == 1) {
            return RadioGroup<int>(
              groupValue: _radioVal,
              onChanged: (v) => setState(() => _radioVal = v ?? _radioVal),
              child: const Row(
                children: [
                  Radio<int>(value: 0),
                  Text('选项 A'),
                  Radio<int>(value: 1),
                  Text('选项 B'),
                ],
              ),
            );
          }
          if (i == 2) {
            return DropdownButton<String>(
              value: _dropdownVal,
              items: const [
                DropdownMenuItem(value: 'A', child: Text('下拉 A')),
                DropdownMenuItem(value: 'B', child: Text('下拉 B')),
              ],
              onChanged: (v) => setState(() => _dropdownVal = v ?? _dropdownVal),
            );
          }
          final idx = i - 3;
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: TextField(
              focusNode: _focusNodes[idx],
              controller: _controllers[idx],
              decoration: InputDecoration(labelText: '字段 $idx', border: const OutlineInputBorder()),
            ),
          );
        },
      ),
    );
  }
}
