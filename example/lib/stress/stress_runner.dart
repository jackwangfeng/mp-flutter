import 'package:flutter/material.dart';

import 'cases/case_a_long_list.dart';
import 'cases/case_b_image_wall.dart';
import 'cases/case_c_long_text_single.dart';
import 'cases/case_d_long_text_listview.dart';
import 'cases/case_e_big_form.dart';
import 'cases/case_f_effects.dart';
import 'cases/case_g_native.dart';
import 'stress_config.dart';
import 'stress_flags.dart';

/// 依次自动跑完 A~G 每一项:push 对应页面 → 页面自己量完、print、`pop` →
/// 等 [StressConfig.betweenCasesDelay] → 下一项。全部完成后打印
/// `[mp-stress] done`。
class StressRunner {
  const StressRunner._();

  static final Map<String, Widget Function(int pushStartMs)> _builders = {
    'A': (t) => StressCaseA(pushStartMs: t),
    'B': (t) => StressCaseB(pushStartMs: t),
    'C': (t) => StressCaseC(pushStartMs: t),
    'D': (t) => StressCaseD(pushStartMs: t),
    'E': (t) => StressCaseE(pushStartMs: t),
    'F': (t) => StressCaseF(pushStartMs: t),
    'G': (t) => StressCaseG(pushStartMs: t),
  };

  /// `--dart-define=STRESS_ONLY=AE`:只跑列出的项(字母),调试单项时省时间;
  /// 缺省跑全部。
  static const String _only = String.fromEnvironment('STRESS_ONLY', defaultValue: '');

  static Future<void> run(BuildContext context) async {
    final builders = _builders.entries
        .where((e) => _only.isEmpty || _only.toUpperCase().contains(e.key))
        .map((e) => e.value);
    if (StressConfig.startDelay > Duration.zero) {
      await Future.delayed(StressConfig.startDelay);
    }
    for (final builder in builders) {
      if (!context.mounted) return;
      final pushStartMs = DateTime.now().millisecondsSinceEpoch;
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => builder(pushStartMs)));
      if (StressConfig.betweenCasesDelay > Duration.zero) {
        await Future.delayed(StressConfig.betweenCasesDelay);
      }
    }
    // ignore: avoid_print
    print('$kStressLogPrefix done');
  }
}
