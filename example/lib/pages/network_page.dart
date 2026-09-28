import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// 网络 + 本地存储 + 网络图片:三者在 mp-flutter 编译产物里都是**零改动**
/// 透明接管(`package:http`/`shared_preferences`/`Image.network` 底层被垫片
/// 替换为小程序 API,见仓库根 README「网络与存储」一节)。
///
/// 所有网络/存储调用都由按钮触发,不在 `initState`/`build` 里自动发起——
/// 一是避免小程序真机因合法域名未配置而在页面刚打开就报错刷屏,二是让
/// widget 冒烟测试(`flutter test`)不会意外触发真实网络请求。
class NetworkPage extends StatefulWidget {
  const NetworkPage({super.key});

  @override
  State<NetworkPage> createState() => _NetworkPageState();
}

class _NetworkPageState extends State<NetworkPage> {
  String _httpResult = '(尚未请求)';
  bool _httpLoading = false;

  String _storageResult = '(尚未读取)';
  int _counter = 0;

  static const _kCounterKey = 'mp_flutter_example.counter';

  // 长期稳定的公开 HTTPS 图床(flutter 官方文档示例长期使用这张图,不会失效)。
  // 真机上小程序只能访问后台配置过的合法域名——这里没配置(游客态 appid 也
  // 无法配置),所以真机大概率会走到下面的 errorBuilder;开发者工具默认不校验
  // 域名(project.config.json 的 urlCheck),通常能正常显示。
  static const _imageUrl = 'https://flutter.github.io/assets-for-api-docs/assets/widgets/owl.jpg';

  Future<void> _doHttpGet() async {
    setState(() {
      _httpLoading = true;
      _httpResult = '请求中…';
    });
    try {
      final resp = await http
          .get(Uri.parse('https://httpbin.org/get?from=mp_flutter_example'))
          .timeout(const Duration(seconds: 10));
      final body = jsonDecode(resp.body) as Map<String, Object?>;
      setState(() => _httpResult = 'HTTP ${resp.statusCode} · url=${body['url']}');
    } catch (e) {
      // 优雅处理失败:真机上 touristappid 没有配置任何合法域名,这里必然失败,
      // 但不应该崩溃或卡住,而是把原因显示出来。
      setState(() => _httpResult = '请求失败(真机需在小程序后台配置合法域名):$e');
    } finally {
      if (mounted) setState(() => _httpLoading = false);
    }
  }

  Future<void> _loadCounter() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _counter = prefs.getInt(_kCounterKey) ?? 0;
      _storageResult = '已读取:$_counter';
    });
  }

  Future<void> _incrementAndSave() async {
    final prefs = await SharedPreferences.getInstance();
    final next = (prefs.getInt(_kCounterKey) ?? 0) + 1;
    await prefs.setInt(_kCounterKey, next);
    setState(() {
      _counter = next;
      _storageResult = '已保存:$next(小程序里由 wx.setStorageSync 承载,重启小程序仍在)';
    });
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text('网络图片', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: Image.network(
            _imageUrl,
            key: const Key('network-image'),
            height: 160,
            fit: BoxFit.cover,
            loadingBuilder: (context, child, progress) =>
                progress == null ? child : const SizedBox(height: 160, child: Center(child: CircularProgressIndicator())),
            errorBuilder: (context, error, stack) => Container(
              height: 160,
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
              alignment: Alignment.center,
              child: const Padding(
                padding: EdgeInsets.all(12),
                child: Text('图片加载失败(域名未在小程序后台配置合法域名列表,或当前无网络)', textAlign: TextAlign.center),
              ),
            ),
          ),
        ),
        const Divider(height: 32),
        const Text('HTTP 请求', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        Text(_httpResult, key: const Key('http-result')),
        const SizedBox(height: 8),
        FilledButton(
          key: const Key('http-button'),
          onPressed: _httpLoading ? null : _doHttpGet,
          child: Text(_httpLoading ? '请求中…' : '发起 GET 请求'),
        ),
        const Divider(height: 32),
        const Text('本地存储', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        Text(_storageResult, key: const Key('storage-result')),
        const SizedBox(height: 8),
        Row(
          children: [
            OutlinedButton(key: const Key('storage-load'), onPressed: _loadCounter, child: const Text('读取计数')),
            const SizedBox(width: 12),
            FilledButton(key: const Key('storage-save'), onPressed: _incrementAndSave, child: const Text('计数 +1 并保存')),
          ],
        ),
      ],
    );
  }
}
