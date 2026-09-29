import 'package:flutter/material.dart';
import 'package:mp_flutter_native/mp_flutter_native.dart';

import '../stress_case_page.dart';

/// G(可选):原生组件——一个 `MpVideo` 加一个 `MpMap` 放在可滚动页里,测滚动
/// 时原生组件同步层(跟手贴合 Flutter 内容滚动)的表现。非小程序环境下两者
/// 都渲染 `fallback`,不影响其余压测项跑完整套流程(比如 `flutter test`/
/// 普通浏览器)。
///
/// 复用 `pages/native_page.dart` 里已经在用的公开演示地址/坐标(w3schools 的
/// 示例视频、天安门广场坐标),不引入新的第三方域名。
class StressCaseG extends StatelessWidget {
  const StressCaseG({super.key, required this.pushStartMs});
  final int pushStartMs;

  static const id = 'G_native';
  static const _videoSrc = 'https://www.w3schools.com/html/mov_bbb.mp4';
  static const _lat = 39.9087;
  static const _lng = 116.3975;

  @override
  Widget build(BuildContext context) {
    return StressCasePage(
      id: id,
      title: 'G 原生组件(可选)',
      pushStartMs: pushStartMs,
      buildExtra: () => 'nativeAvailable=$mpNativeAvailable',
      contentBuilder: (context, controller) => ListView(
        controller: controller,
        padding: const EdgeInsets.all(12),
        children: [
          const Text('MpVideo', style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          SizedBox(
            height: 200,
            child: MpVideo(
              src: _videoSrc,
              autoplay: false,
              controls: true,
              fallback: Container(
                color: Colors.grey.shade300,
                alignment: Alignment.center,
                child: const Text('当前平台不支持视频组件(仅小程序可用)'),
              ),
            ),
          ),
          const SizedBox(height: 16),
          const Text('MpMap', style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          SizedBox(
            height: 200,
            child: MpMap(
              latitude: _lat,
              longitude: _lng,
              fallback: Container(
                color: Colors.grey.shade300,
                alignment: Alignment.center,
                child: const Text('当前平台不支持地图组件(仅小程序可用)'),
              ),
            ),
          ),
          const SizedBox(height: 16),
          // 额外填充内容,保证滚动距离足够长,测原生组件跟手滚动的同步表现。
          for (var i = 0; i < 20; i++)
            Container(
              height: 72,
              margin: const EdgeInsets.only(bottom: 8),
              color: i.isEven ? Colors.blueGrey.shade50 : Colors.blueGrey.shade100,
              alignment: Alignment.center,
              child: Text('滚动填充内容 $i'),
            ),
        ],
      ),
    );
  }
}
