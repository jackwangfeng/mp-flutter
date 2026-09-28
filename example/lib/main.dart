import 'package:flutter/material.dart';

import 'pages/native_page.dart';
import 'pages/network_page.dart';
import 'pages/text_input_page.dart';
import 'pages/touch_scroll_page.dart';
import 'pages/wechat_page.dart';

/// mp-flutter 示例工程:底部导航 + 5 个功能页,覆盖 Phase 6 Task 4 要求的
/// 每一类能力。所有页面在 `flutter run -d chrome`(普通浏览器,零改动)与
/// `dart run mp_flutter` 编译出的微信小程序里都应该能跑——区别只在于
/// 「仅小程序可用」的能力(微信登录/支付/扫码等、原生 video/map)在普通
/// 浏览器上会显示占位提示,而不是报错崩溃。
void main() {
  runApp(const MpFlutterExampleApp());
}

class MpFlutterExampleApp extends StatelessWidget {
  const MpFlutterExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'mp_flutter 示例',
      theme: ThemeData(colorSchemeSeed: const Color(0xFF3355FF), useMaterial3: true),
      home: const HomeShell(),
    );
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  static const _pages = [
    TouchScrollPage(),
    TextInputPage(),
    NetworkPage(),
    WechatPage(),
    NativePage(),
  ];

  static const _destinations = [
    NavigationDestination(icon: Icon(Icons.touch_app_outlined), selectedIcon: Icon(Icons.touch_app), label: '触摸/滚动'),
    NavigationDestination(icon: Icon(Icons.edit_outlined), selectedIcon: Icon(Icons.edit), label: '文本输入'),
    NavigationDestination(icon: Icon(Icons.cloud_outlined), selectedIcon: Icon(Icons.cloud), label: '网络/存储'),
    NavigationDestination(icon: Icon(Icons.wechat_outlined), selectedIcon: Icon(Icons.wechat), label: '微信能力'),
    NavigationDestination(icon: Icon(Icons.videocam_outlined), selectedIcon: Icon(Icons.videocam), label: '原生组件'),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // SafeArea 在 mp-flutter 编译产物里零改动生效(构建时自动注入安全区,
      // 见仓库根 README「安全区」一节),这里不用再手动处理状态栏/Home 指示条。
      body: SafeArea(child: IndexedStack(index: _index, children: _pages)),
      bottomNavigationBar: NavigationBar(
        key: const Key('bottom-nav'),
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: _destinations,
      ),
    );
  }
}
