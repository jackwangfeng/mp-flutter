import 'package:flutter/material.dart';

import 'stress_runner.dart';

/// 压测页专用的最小 App 壳(只在 `kStressMode` 分支下被 `runApp`,见
/// `main.dart`)。不带底部导航等正式产物的任何页面,只有这一个入口页。
class StressExampleApp extends StatelessWidget {
  const StressExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'flutter_miniprogram 压力测试',
      theme: ThemeData(colorSchemeSeed: const Color(0xFF3355FF), useMaterial3: true),
      home: const StressHomePage(),
    );
  }
}

/// 压测入口页:首帧渲染完就自动开始(不用等真机上去点「开始」,方便
/// `tools/e2e/accept-stress.js` 自动化);「开始」按钮留着给真机上想手动
/// 重跑一遍的场景用。
class StressHomePage extends StatefulWidget {
  const StressHomePage({super.key});

  @override
  State<StressHomePage> createState() => _StressHomePageState();
}

class _StressHomePageState extends State<StressHomePage> {
  bool _running = false;
  bool _done = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  Future<void> _start() async {
    if (_running) return;
    setState(() {
      _running = true;
      _done = false;
    });
    await StressRunner.run(context);
    if (mounted) {
      setState(() {
        _running = false;
        _done = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('mp-flutter 压力测试')),
      body: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                _running ? '压测进行中……(结果见控制台 [mp-stress] 行)' : (_done ? '压测已完成,结果见控制台 [mp-stress] 行' : '准备就绪'),
                key: const Key('stress-status'),
              ),
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('stress-start-button'),
                onPressed: _running ? null : _start,
                child: Text(_running ? '进行中…' : (_done ? '重新开始' : '开始')),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
