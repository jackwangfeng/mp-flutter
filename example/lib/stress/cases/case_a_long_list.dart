import 'package:flutter/material.dart';

import '../stress_case_page.dart';
import '../stress_config.dart';
import '../stress_flags.dart';

/// A:长列表——`ListView.builder`,每行一张缩略图 + 两行文字 + 加粗价格。
class StressCaseA extends StatelessWidget {
  const StressCaseA({super.key, required this.pushStartMs});
  final int pushStartMs;

  static const id = 'A_long_list';

  @override
  Widget build(BuildContext context) {
    final count = StressConfig.listCount;
    return StressCasePage(
      id: id,
      title: 'A 长列表($count 行)',
      pushStartMs: pushStartMs,
      buildExtra: () => 'rows=$count',
      contentBuilder: (context, controller) => ListView.builder(
        controller: controller,
        itemCount: count,
        itemExtent: 88,
        itemBuilder: (context, i) {
          final url = StressImgConfig.urlFor(i);
          final price = (9.9 + i * 3.37) % 999;
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Row(
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(6),
                  child: Image(
                    image: StressConfig.buildImage(url),
                    width: 64,
                    height: 64,
                    fit: BoxFit.cover,
                    errorBuilder: (context, error, stack) => Container(
                      width: 64,
                      height: 64,
                      color: Colors.grey.shade300,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text('商品第 $i 行 —— 压测长列表标题文字', maxLines: 1, overflow: TextOverflow.ellipsis),
                      const SizedBox(height: 4),
                      Text('副标题/规格说明,行号 $i,模拟真实商品列表的第二行文字',
                          maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.grey)),
                    ],
                  ),
                ),
                Text('¥${price.toStringAsFixed(2)}', style: const TextStyle(fontWeight: FontWeight.bold)),
              ],
            ),
          );
        },
      ),
    );
  }
}
