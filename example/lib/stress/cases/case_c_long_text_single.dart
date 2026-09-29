import 'package:flutter/material.dart';

import '../stress_case_page.dart';
import '../stress_text.dart';

/// C:长图文一次性构建——全部段落放进 `SingleChildScrollView` + `Column`,
/// 标题(w700)和正文混排。与 D(`ListView.builder` 按段落拆分)对比一次性
/// 构建 vs 懒构建的差异。
class StressCaseC extends StatelessWidget {
  const StressCaseC({super.key, required this.pushStartMs});
  final int pushStartMs;

  static const id = 'C_long_text_single';

  @override
  Widget build(BuildContext context) {
    final paragraphs = buildStressParagraphs();
    final chars = totalCharsOf(paragraphs);
    return StressCasePage(
      id: id,
      title: 'C 长图文·一次性构建(${paragraphs.length} 段)',
      pushStartMs: pushStartMs,
      buildExtra: () => 'chars=$chars,paragraphs=${paragraphs.length}',
      contentBuilder: (context, controller) => SingleChildScrollView(
        controller: controller,
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final p in paragraphs)
              Padding(
                padding: EdgeInsets.only(bottom: p.isTitle ? 4 : 16, top: p.isTitle ? 16 : 0),
                child: Text(
                  p.text,
                  style: p.isTitle
                      ? const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)
                      : const TextStyle(fontSize: 15, height: 1.6),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
