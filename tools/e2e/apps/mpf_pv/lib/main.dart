import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mp_flutter_native/mp_flutter_native.dart';

// Phase 5 Task 1/2/3/4 验收工程(见 附录 A / task-1..4-brief.md)。
//
// Task 4 起,原来两个"随便什么类型"的 HtmlElementView 占位换成真正的
// MpVideo(src 由 tools/e2e/test-server.js 的 /media/tiny.mp4 路由提供)与
// MpMap(mp_flutter_native path 依赖),用来验收:
//   - 原生视图同步层的几何(mpNative[id] 的 left/top/width/height/clip/hidden)
//     与 Flutter 侧自己算出的 STATE|video_rect= 一致;
//   - ScrollController.jumpTo 之后矩形随之变化、滚出视口后 hidden:true;
//   - 事件回路(wx 侧派发 ended → Dart 侧 onEnded 回调 → STATE|video_ended);
//   - 控制器命令(controller.play())在开发者工具里不抛错;
//   - (可选)--semantics-mirror 打开时,mpSemantics 里能读到本文件里一段
//     已知文本。
//
// 全屏纯色背景(0xFF2E7D32)常驻在 Stack 最底层、不随滚动移动——保证
// PIXEL|center 断言(屏幕中心必须落在背景色上)不受下面的滚动验收影响。

void log(String s) {
  // ignore: avoid_print
  print('STATE|$s');
}

void main() {
  runApp(const ProbeApp());
}

class ProbeApp extends StatelessWidget {
  const ProbeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      debugShowCheckedModeBanner: false,
      home: ProbeHome(),
    );
  }
}

class ProbeHome extends StatefulWidget {
  const ProbeHome({super.key});

  @override
  State<ProbeHome> createState() => _ProbeHomeState();
}

class _ProbeHomeState extends State<ProbeHome> {
  final ScrollController _scrollController = ScrollController();
  final GlobalKey _videoBoxKey = GlobalKey();
  final MpVideoController _videoController = MpVideoController();
  final MpMapController _mapController = MpMapController();
  final List<Timer> _timers = [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _printVideoRect('video_rect'));
    // 控制器命令:验证 wx.createVideoContext 在开发者工具里可用、command()
    // 不抛错(视图尚未"渲染完成"时会先进 native-views.js 的 pending 队列,
    // 等首次 setData 回调后再真正下发,不需要在这里手动等)。
    _timers.add(Timer(const Duration(seconds: 2), () async {
      try {
        await _videoController.play();
        log('controller_play_ok');
      } catch (e) {
        log('controller_play_error=$e');
      }
    }));
    // 滚动:把上面两个原生组件(视频+地图)连同它们后面留的空白一起滚出视口。
    // 延迟到 15s——留够时间让 accept-pv.js 的 automator 交互先读到"滚动前"的
    // mpNative 快照(bootMs 默认在 12s 左右开始交互),再等它滚动。
    _timers.add(Timer(const Duration(seconds: 15), () {
      if (!_scrollController.hasClients) return;
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      log('scrolled=1');
    }));
    _timers.add(Timer(const Duration(seconds: 17), () => _printVideoRect('video_rect_after_scroll')));
  }

  @override
  void dispose() {
    for (final t in _timers) {
      t.cancel();
    }
    _scrollController.dispose();
    super.dispose();
  }

  void _printVideoRect(String tag) {
    final ctx = _videoBoxKey.currentContext;
    final renderObject = ctx?.findRenderObject();
    if (renderObject is! RenderBox || !renderObject.hasSize) {
      log('${tag}_missing');
      return;
    }
    final origin = renderObject.localToGlobal(Offset.zero);
    log('$tag=${origin.dx.toStringAsFixed(1)},${origin.dy.toStringAsFixed(1)},'
        '${renderObject.size.width.toStringAsFixed(1)},${renderObject.size.height.toStringAsFixed(1)}');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          const Positioned.fill(
            child: ColoredBox(color: Color(0xFF2E7D32)),
          ),
          SingleChildScrollView(
            controller: _scrollController,
            child: Column(
              children: [
                SizedBox(
                  key: _videoBoxKey,
                  height: 120,
                  width: double.infinity,
                  child: MpVideo(
                    src: 'http://127.0.0.1:18080/media/tiny.mp4',
                    controller: _videoController,
                    onEnded: () => log('video_ended'),
                  ),
                ),
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: SizedBox(
                    height: 120,
                    width: double.infinity,
                    child: MpMap(
                      latitude: 31.2,
                      longitude: 121.5,
                      controller: _mapController,
                    ),
                  ),
                ),
                // 滚动余量,足够把上面两个原生组件整块滚出视口。
                const SizedBox(height: 2000),
                // WXML 伴生层(--semantics-mirror)验收用的已知文本;1x1 且
                // 不叠加任何可见样式,不影响任何像素/几何断言。
                Semantics(
                  label: 'mpf_pv semantics mirror known text 已知文本',
                  child: const SizedBox(width: 1, height: 1),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
