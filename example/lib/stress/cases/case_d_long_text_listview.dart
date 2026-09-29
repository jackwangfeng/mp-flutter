import 'package:flutter/material.dart';

import '../stress_case_page.dart';
import '../stress_text.dart';

/// D:与 C 完全相同的内容,改成 `ListView.builder` 按段落拆分懒构建,用来对比
/// “一次性构建 Column” vs “按段落懒构建”的首帧/滚动表现差异。
class StressCaseD extends StatelessWidget {
  const StressCaseD({super.key, required this.pushStartMs});
  final int pushStartMs;

  static const id = 'D_long_text_listview';

  @override
  Widget build(BuildContext context) {
    final paragraphs = buildStressParagraphs();
    final chars = totalCharsOf(paragraphs);
    return StressCasePage(
      id: id,
      title: 'D 长图文·ListView.builder(${paragraphs.length} 段)',
      pushStartMs: pushStartMs,
      buildExtra: () => 'chars=$chars,paragraphs=${paragraphs.length}',
      contentBuilder: (context, controller) => ListView.builder(
        controller: controller,
        padding: const EdgeInsets.all(16),
        itemCount: paragraphs.length,
        itemBuilder: (context, i) {
          final p = paragraphs[i];
          return Padding(
            padding: EdgeInsets.only(bottom: p.isTitle ? 4 : 16, top: p.isTitle ? 16 : 0),
            child: Text(
              p.text,
              style: p.isTitle
                  ? const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)
                  : const TextStyle(fontSize: 15, height: 1.6),
            ),
          );
        },
      ),
    );
  }
}
