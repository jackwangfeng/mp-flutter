import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

// 网络验收:结果一律 print('STATE|...')(Flutter Web 的 print 走 console.log,经 --verify 缓冲)
const base = 'http://127.0.0.1:18080';

void main() {
  runApp(MaterialApp(home: Scaffold(body: Stack(children: [
    const Positioned.fill(
        child: Image(image: NetworkImage('$base/img/red.png'), fit: BoxFit.cover)),
    // cacheWidth 缩放(离屏 2d 画布,CanvasKit CPU 光栅):左下角 40×40 显示缩放后的图,
    // 用 srcIn 染成纯绿 —— 图真的画出来了 PIXEL|corner 才是绿色,否则是底下的红
    Positioned(left: 0, bottom: 0, width: 40, height: 40,
        child: ColorFiltered(
            colorFilter: const ColorFilter.mode(Color(0xFF00FF00), BlendMode.srcIn),
            child: Image.network('$base/img/red.png', cacheWidth: 32, fit: BoxFit.fill,
                errorBuilder: (c, e, s) {
              print('STATE|img_cache=ERR $e');
              return const SizedBox.shrink();
            }))),
  ]))));
  unawaited(runChecks());
  unawaited(imageChecks());
}

Future<void> runChecks() async {
  Future<void> step(String name, Future<String> Function() f) async {
    try { print('STATE|$name=${await f()}'); } catch (e) { print('STATE|$name=ERR ${e.runtimeType} $e'); }
  }
  await step('http_get', () async {
    final j = jsonDecode(utf8.decode((await http.get(Uri.parse('$base/api/hello'))).bodyBytes)) as Map;
    return '${j['msg']}/${j['n']}';
  });
  await step('http_post', () async {
    final r = await http.post(Uri.parse('$base/api/echo'),
        headers: {'Authorization': 'Bearer t1'}, body: utf8.encode('世界😀'));
    return '${r.headers['x-method']}|${r.headers['x-auth']}|${utf8.decode(r.bodyBytes)}';
  });
  await step('http_404', () async {
    final r = await http.get(Uri.parse('$base/api/404'));
    return '${r.statusCode}|${r.body}';
  });
  await step('dio_get', () async {
    final r = await Dio().get<Map<String, dynamic>>('$base/api/hello');
    return '${r.data!['msg']}';
  });
  await step('dio_timeout', () async {
    try {
      await Dio(BaseOptions(receiveTimeout: const Duration(seconds: 1))).get<String>('$base/api/slow');
      return 'no-timeout';
    } on DioException catch (e) {
      return e.type.name;
    }
  });
  await step('http_cancel', () async {
    final client = http.Client();
    final f = client.get(Uri.parse('$base/api/slow'));
    await Future<void>.delayed(const Duration(milliseconds: 200));
    client.close();
    try { await f; return 'not-cancelled'; } catch (_) { return 'ok'; }
  });
  // 终审修复 Important 2:wx.request 同时在途最多 10 个,15 路并发必须全部
  // 排队完成而不是丢弃/报错(验证垫片自己的 FIFO 队列,而不是微信的并发上限)。
  await step('http_concurrent', () async {
    final rs = await Future.wait(
        List.generate(15, (_) => http.get(Uri.parse('$base/api/hello'))));
    return '${rs.where((r) => r.statusCode == 200).length}';
  });
  // PATCH 是否可用未在微信官方 wx.request method 列表中明确写出,这里只记录
  // 实测结果(accept-net.js 不把它当失败条件),据此更新 README。
  await step('http_patch', () async {
    final r = await http.patch(Uri.parse('$base/api/echo'), body: 'p');
    return '${r.headers['x-method']}';
  });
  final prefs = await SharedPreferences.getInstance();
  print('STATE|prefs_prev=${prefs.getString('token') ?? 'none'}');
  final token = (await http.get(Uri.parse('$base/token'))).body;
  await prefs.setString('token', token);
  print('STATE|prefs_set=${prefs.getString('token')}');
}

/// 解析一个 ImageProvider,拿到它解出的 ui.Image(clone 一份,调用方负责 dispose)。
Future<ui.Image> resolveImage(ImageProvider provider) {
  final c = Completer<ui.Image>();
  final stream = provider.resolve(ImageConfiguration.empty);
  late final ImageStreamListener l;
  l = ImageStreamListener((info, _) {
    if (!c.isCompleted) c.complete(info.image.clone());
    info.dispose();
    stream.removeListener(l);
  }, onError: (e, s) {
    if (!c.isCompleted) c.completeError(e, s);
    stream.removeListener(l);
  });
  stream.addListener(l);
  return c.future;
}

/// cacheWidth 解码尺寸 + toByteData(rawRgba / png)。64×64 红图按宽 32 缩放 → 32×32。
Future<void> imageChecks() async {
  try {
    final img = await resolveImage(ResizeImage(const NetworkImage('$base/img/red.png'), width: 32));
    print('STATE|cache_w=${img.width}');
    final raw = await img.toByteData(format: ui.ImageByteFormat.rawRgba);
    print('STATE|bytes_len=${raw!.lengthInBytes}');
    final mid = ((img.height ~/ 2) * img.width + img.width ~/ 2) * 4;
    print('STATE|raw_px=${raw.getUint8(mid)},${raw.getUint8(mid + 1)},${raw.getUint8(mid + 2)},${raw.getUint8(mid + 3)}');
    final png = await img.toByteData(format: ui.ImageByteFormat.png);
    final bytes = png!.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes);
    final codec = await ui.instantiateImageCodec(bytes);
    final back = (await codec.getNextFrame()).image;
    final sig = bytes.length > 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4e && bytes[3] == 0x47;
    print(sig && back.width == img.width && back.height == img.height
        ? 'STATE|png_ok'
        : 'STATE|png_bad sig=$sig ${back.width}x${back.height} vs ${img.width}x${img.height}');
    back.dispose();
    codec.dispose();
    img.dispose();
  } catch (e) {
    print('STATE|img_checks=ERR ${e.runtimeType} $e');
  }
}
