import 'dart:convert';

import 'package:flutter/material.dart';

// 交互验收:所有可观测结果用 print('STATE|...') 输出(Flutter Web 的 print 走 console.log)
void main() => runApp(const MaterialApp(home: InteractPage()));

class InteractPage extends StatefulWidget {
  const InteractPage({super.key});
  @override
  State<InteractPage> createState() => _InteractPageState();
}

class _InteractPageState extends State<InteractPage> {
  final scroll = ScrollController();
  final text = TextEditingController();
  int reported = -1;

  @override
  void initState() {
    super.initState();
    scroll.addListener(() {
      final off = scroll.offset.round();
      if ((off - reported).abs() >= 50) { reported = off; print('STATE|scroll=$off'); }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final v = View.of(context);
      final logical = v.physicalSize / v.devicePixelRatio;
      // 与小程序 windowWidth×windowHeight 比较由 E2E 做不到,这里只校验"逻辑宽度在手机合理范围"
      final ok = logical.width >= 300 && logical.width <= 500;
      print('STATE|size=${logical.width.round()}x${logical.height.round()} ${ok ? 'ok' : 'bad'}');
      // K1 安全区:用户代码零改动,MediaQuery.padding/viewPadding 应等于小程序安全区
      // (E2E 用 wx.getSystemInfoSync().safeArea 比对)
      final mq = MediaQuery.of(context);
      print('STATE|pad=${mq.padding.top.round()},${mq.padding.bottom.round()}'
          ' vpad=${mq.viewPadding.top.round()},${mq.viewPadding.bottom.round()}');
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: TextField(
                autofocus: true,
                controller: text,
                onChanged: (v) {
                  print('STATE|text=$v');
                  // 输入 # 即清空:聚焦期间、同一输入连接内引擎改值(提交后清空会重建连接)
                  if (v.endsWith('#')) text.clear();
                },
                // 聊天/搜索式"发送后清空":保持焦点(空 onEditingComplete 阻止默认失焦),
                // 验证引擎侧清空能推回原生输入框
                onEditingComplete: () {},
                onSubmitted: (v) { print('STATE|submit=$v'); text.clear(); },
              ),
            ),
            // 第二个输入框(多输入框切换验收:焦点 A→B 时被销毁的 A 原生框迟到的 blur
            // 不得关掉 B 的输入连接)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: TextField(onChanged: (v) {
                print('STATE|text2=$v');
                // K5 路由切换复现:输入 route 即 push 一个带图片+滚动的页面,
                // 该页随后 pushReplacement(与真实电商场景"申请售后→提交"同形)
                if (v == 'route') {
                  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const _RoutePage()));
                }
              }),
            ),
            Expanded(
              flex: 3,
              child: ListView.builder(
                controller: scroll,
                itemCount: 100,
                itemBuilder: (_, i) => ListTile(title: Text('第 $i 行')),
              ),
            ),
            Expanded(
              flex: 2,
              child: Row(children: [
                Expanded(child: GestureDetector(
                  onTap: () => print('STATE|tap=left'),
                  child: Container(color: const Color(0xFF3355FF)))),
                Expanded(child: GestureDetector(
                  onTap: () => print('STATE|tap=right'),
                  child: Container(color: const Color(0xFFFF5533)))),
              ]),
            ),
          ]),
        ),
      );
}

// 8×8 橙色 PNG:路由页里放真实图片解码/绘制,贴近业务页
final _png = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGP4H2r8Hx9mGBkKAFAloYEZ+uc7AAAAAElFTkSuQmCC');

class _RoutePage extends StatefulWidget {
  const _RoutePage();
  @override
  State<_RoutePage> createState() => _RoutePageState();
}

class _RoutePageState extends State<_RoutePage> {
  final scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    print('STATE|route=pushed');
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      // 转场动画进行中就开始滚动,再在滚动/转场帧密集时 pushReplacement
      scroll.animateTo(600, duration: const Duration(milliseconds: 500), curve: Curves.linear);
      await Future<void>.delayed(const Duration(milliseconds: 250));
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute<void>(builder: (_) => const _DonePage()));
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('申请售后')),
        body: ListView.builder(
          controller: scroll,
          itemCount: 40,
          itemBuilder: (_, i) => ListTile(
            leading: Image.memory(_png, width: 40, height: 40, fit: BoxFit.fill),
            title: Text('商品 $i'),
          ),
        ),
      );
}

class _DonePage extends StatefulWidget {
  const _DonePage();
  @override
  State<_DonePage> createState() => _DonePageState();
}

class _DonePageState extends State<_DonePage> {
  @override
  void initState() {
    super.initState();
    // 等转场动画(MaterialPageRoute 约 300ms)跑完再报,确保整段转场帧都已渲染
    Future<void>.delayed(const Duration(milliseconds: 800), () => print('STATE|route=replaced'));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('提交成功')),
        body: ListView(children: [
          for (var i = 0; i < 20; i++)
            ListTile(leading: Image.memory(_png, width: 40, height: 40), title: Text('进度 $i')),
        ]),
      );
}
