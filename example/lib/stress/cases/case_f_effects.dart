import 'dart:ui';

import 'package:flutter/material.dart';

import '../stress_case_page.dart';
import '../stress_config.dart';

/// F:效果——约 40 张卡片,带 `BoxShadow`、`Opacity(0.8)`、`ClipRRect`,其中
/// 一段(每 8 张里 1 张)额外套 `BackdropFilter`(blur)。滚动测量合成开销。
class StressCaseF extends StatelessWidget {
  const StressCaseF({super.key, required this.pushStartMs});
  final int pushStartMs;

  static const id = 'F_effects';

  @override
  Widget build(BuildContext context) {
    final count = StressConfig.cardCount;
    return StressCasePage(
      id: id,
      title: 'F 效果卡片($count 张)',
      pushStartMs: pushStartMs,
      buildExtra: () => 'cards=$count',
      contentBuilder: (context, controller) => ListView.builder(
        controller: controller,
        padding: const EdgeInsets.all(12),
        itemCount: count,
        itemBuilder: (context, i) {
          final hue = (i * 47) % 360;
          final color = HSVColor.fromAHSV(1, hue.toDouble(), 0.55, 0.9).toColor();
          final card = Opacity(
            opacity: 0.8,
            child: Container(
              height: 96,
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(16),
                boxShadow: [
                  BoxShadow(color: Colors.black.withValues(alpha: 0.25), blurRadius: 10, offset: const Offset(0, 4)),
                ],
              ),
              alignment: Alignment.center,
              child: Text('卡片 $i', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
            ),
          );
          final clipped = ClipRRect(borderRadius: BorderRadius.circular(16), child: card);
          if (i % 8 != 0) {
            return Padding(padding: const EdgeInsets.only(bottom: 12), child: clipped);
          }
          // 每 8 张里的这 1 张叠一层 BackdropFilter 模糊,测毛玻璃效果的合成开销。
          return Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: Stack(
                children: [
                  clipped,
                  Positioned.fill(
                    child: BackdropFilter(
                      filter: ImageFilter.blur(sigmaX: 6, sigmaY: 6),
                      child: Container(color: Colors.white.withValues(alpha: 0.06)),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
