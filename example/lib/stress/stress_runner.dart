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

  static final List<Widget Function(int pushStartMs)> _builders = [
    (t) => StressCaseA(pushStartMs: t),
    (t) => StressCaseB(pushStartMs: t),
    (t) => StressCaseC(pushStartMs: t),
    (t) => StressCaseD(pushStartMs: t),
    (t) => StressCaseE(pushStartMs: t),
    (t) => StressCaseF(pushStartMs: t),
    (t) => StressCaseG(pushStartMs: t),
  ];

  static Future<void> run(BuildContext context) async {
    for (final builder in _builders) {
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
