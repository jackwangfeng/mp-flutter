import 'package:flutter/material.dart';
import 'package:mp_flutter_native/mp_flutter_native.dart';

/// 原生组件:`MpVideo`/`MpMap`(真实 API,见 packages/mp_flutter_native
/// README——不是发明出来的接口)。
///
/// ★ 小程序里原生组件总是叠在所有 Flutter 内容之上(与 WXML 伴生层同层
/// 合成,不受 Flutter 绘制顺序影响):这个页面刻意不在 [MpVideo]/[MpMap]
/// 上叠加任何浮层 UI,控制按钮都放在组件区域之外,避免被原生组件遮住。
///
/// 非小程序环境(含普通浏览器、Android/iOS/桌面)下渲染各自的 `fallback`。
class NativePage extends StatefulWidget {
  const NativePage({super.key});

  @override
  State<NativePage> createState() => _NativePageState();
}

class _NativePageState extends State<NativePage> {
  final _videoController = MpVideoController();
  final _mapController = MpMapController();
  String _log = '(尚无事件)';

  static const _videoSrc = 'https://www.w3schools.com/html/mov_bbb.mp4';
  // 天安门广场,随便取的一个演示坐标。
  static const _lat = 39.9087;
  static const _lng = 116.3975;

  void _append(String line) => setState(() => _log = line);

  Future<void> _guard(String label, Future<void> Function() action) async {
    try {
      await action();
      _append('✓ $label');
    } on UnsupportedError catch (e) {
      _append('✗ $label: ${e.message}');
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text('原生组件', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        Text('mpNativeAvailable = $mpNativeAvailable'),
        const SizedBox(height: 12),
        const Text('MpVideo', style: TextStyle(fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        SizedBox(
          height: 200,
          child: MpVideo(
            src: _videoSrc,
            controls: true,
            controller: _videoController,
            onPlay: () => _append('视频事件: play'),
            onPause: () => _append('视频事件: pause'),
            onEnded: () => _append('视频事件: ended'),
            onError: (msg) => _append('视频错误: $msg'),
            fallback: Container(
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
              alignment: Alignment.center,
              child: const Text('当前平台不支持视频组件(仅小程序可用)'),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: [
            OutlinedButton(onPressed: () => _guard('play', _videoController.play), child: const Text('播放')),
            OutlinedButton(onPressed: () => _guard('pause', _videoController.pause), child: const Text('暂停')),
            OutlinedButton(onPressed: () => _guard('stop', _videoController.stop), child: const Text('停止')),
          ],
        ),
        const Divider(height: 32),
        const Text('MpMap', style: TextStyle(fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        SizedBox(
          height: 240,
          child: MpMap(
            latitude: _lat,
            longitude: _lng,
            scale: 14,
            showLocation: true,
            controller: _mapController,
            markers: const [MpMapMarker(id: 1, latitude: _lat, longitude: _lng, title: '示例标记')],
            onTap: (lat, lng) => _append('地图点击: $lat, $lng'),
            onMarkerTap: (id) => _append('标记点击: id=$id'),
            onRegionChange: (type) => _append('视野变化: $type'),
            fallback: Container(
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
              alignment: Alignment.center,
              child: const Text('当前平台不支持地图组件(仅小程序可用)'),
            ),
          ),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: () => _guard('moveToLocation', _mapController.moveToLocation),
          child: const Text('回到当前位置'),
        ),
        const Divider(height: 32),
        Text('最近事件:$_log', key: const Key('native-log')),
      ],
    );
  }
}
