import 'package:flutter/material.dart';

import '../stress_case_page.dart';
import '../stress_config.dart';
import '../stress_flags.dart';

/// B:图片墙——`GridView.builder` 3 列,至少 120 张不同的图,滚到底再滚回顶,
/// 专门测缓存淘汰后的重新解码。
///
/// 为了真的触发“淘汰→重新解码”而不是“120 张图全部常驻默认 100MB/1000 项的
/// ImageCache 里,滚动全程零淘汰”,进入本项时把 `PaintingBinding.imageCache`
/// 的容量临时调小(离开时还原),逼真机在滚动过程中把滚出屏幕较远的图挤出
/// 缓存。
///
/// decode 次数拿不到(Flutter Web/CanvasKit 没有暴露每图解码次数的公开
/// 钩子)——按任务要求留空,真机测量时看 `--perf-hud` 的 `[mp-perf]` 行。
class StressCaseB extends StatelessWidget {
  const StressCaseB({super.key, required this.pushStartMs});
  final int pushStartMs;

  static const id = 'B_image_wall';
  static const _crossAxisCount = 3;

  @override
  Widget build(BuildContext context) {
    final count = StressConfig.imageCount;
    final urls = List.generate(count, StressImgConfig.urlFor);
    final distinctUrls = urls.toSet().length;
    final distinctCombos = List.generate(
      count,
      (i) => '${StressImgConfig.idFor(i)}x${StressImgConfig.widthFor(i)}',
    ).toSet().length;

    final imageCache = PaintingBinding.instance.imageCache;
    final prevMaxSize = imageCache.maximumSize;
    final prevMaxBytes = imageCache.maximumSizeBytes;
    // 30 张的窗口:3 列下大约 10 行,明显小于 120 张,滚动一定会淘汰。
    imageCache.maximumSize = 30;
    imageCache.maximumSizeBytes = 30 * 1024 * 1024;

    return StressCasePage(
      id: id,
      title: 'B 图片墙($count 张)',
      pushStartMs: pushStartMs,
      buildExtra: () {
        // 还原缓存容量,不影响后面其它压测项(A 也用到网络图片缩略图)。
        imageCache.maximumSize = prevMaxSize;
        imageCache.maximumSizeBytes = prevMaxBytes;
        return 'urls=$distinctUrls,combos=$distinctCombos,decode=';
      },
      contentBuilder: (context, controller) => GridView.builder(
        controller: controller,
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: _crossAxisCount,
          childAspectRatio: 1,
        ),
        itemCount: count,
        itemBuilder: (context, i) => Padding(
          padding: const EdgeInsets.all(2),
          child: Image(
            image: StressConfig.buildImage(urls[i]),
            fit: BoxFit.cover,
            errorBuilder: (context, error, stack) => Container(color: Colors.grey.shade300),
          ),
        ),
      ),
    );
  }
}
