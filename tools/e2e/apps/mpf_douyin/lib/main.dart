import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

void main() => runApp(const MaterialApp(home: Probe()));

class Probe extends StatefulWidget {
  const Probe({super.key});
  @override
  State<Probe> createState() => _ProbeState();
}

class _ProbeState extends State<Probe> {
  int count = 0;
  String status = '检查网络与存储…';
  @override
  void initState() {
    super.initState();
    checkServices();
  }

  Future<void> checkServices() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final previous = prefs.getInt('douyinProbeRuns') ?? 0;
      await prefs.setInt('douyinProbeRuns', previous + 1);
      debugPrint('STATE storage=$previous->${previous + 1}');
      final response = await http
          .get(
            Uri.parse(
              'https://httpbin.org/get?message=%E4%BD%A0%E5%A5%BD%F0%9F%98%80',
            ),
          )
          .timeout(const Duration(seconds: 20));
      final message = (jsonDecode(response.body) as Map)['args']['message'];
      if (response.statusCode != 200 || message != '你好😀') {
        throw StateError('unexpected network response');
      }
      debugPrint('STATE network=${response.statusCode}/$message');
      if (mounted)
        setState(
          () => status = '网络 ${response.statusCode} · 启动 ${previous + 1} 次',
        );
    } catch (error) {
      debugPrint('STATE services_error=$error');
      if (mounted) setState(() => status = '检查失败：$error');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Colors.white,
    body: SafeArea(
      child: Center(
        child: SingleChildScrollView(
          child: SizedBox(
            width: 320,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('抖音小程序 · Flutter', style: TextStyle(fontSize: 24)),
                Image.asset('assets/logo.png', width: 64, height: 64),
                Image.network(
                  'https://httpbin.org/image/png',
                  width: 48,
                  height: 48,
                  frameBuilder: (context, child, frame, sync) {
                    if (frame != null) debugPrint('STATE network_image=ready');
                    return child;
                  },
                  errorBuilder: (context, error, stack) {
                    debugPrint('STATE network_image_error=$error');
                    return const Text('网络图片失败');
                  },
                ),
                ColoredBox(
                  color: const Color(0xffff7a3d),
                  child: SizedBox(
                    width: 64,
                    height: 64,
                    child: ClipPath(
                      clipper: TriangleClipper(),
                      clipBehavior: Clip.hardEdge,
                      child: const ColoredBox(color: Color(0xff6ee7a8)),
                    ),
                  ),
                ),
                Text('点击次数：$count', style: const TextStyle(fontSize: 24)),
                ElevatedButton(
                  onPressed: () {
                    setState(() => count++);
                    debugPrint('STATE count=$count');
                  },
                  child: const Text('点击验证'),
                ),
                TextField(
                  decoration: const InputDecoration(labelText: '输入中文和 emoji'),
                  onChanged: (value) => debugPrint('STATE text=$value'),
                  onSubmitted: (value) => debugPrint('STATE submit=$value'),
                ),
                Text(status),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

class TriangleClipper extends CustomClipper<Path> {
  @override
  Path getClip(Size size) => Path()
    ..moveTo(0, size.height)
    ..lineTo(size.width / 2, 0)
    ..lineTo(size.width, size.height)
    ..close();
  @override
  bool shouldReclip(TriangleClipper oldClipper) => false;
}
