// 冒烟测试:底部导航 5 个 tab 都能构建、切换,且互不影响(每个 tab 至少
// 有一个特征 widget 被找到)。不触发真实网络/存储调用(见 network_page.dart
// 的注释——那些调用都由按钮触发,不在 build/initState 里自动发起)。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mp_flutter_example/main.dart';

void main() {
  testWidgets('底部导航 5 个 tab 均可切换且渲染各自内容', (WidgetTester tester) async {
    await tester.pumpWidget(const MpFlutterExampleApp());
    await tester.pumpAndSettle();

    // tab 0:触摸与滚动列表
    expect(find.byKey(const Key('touch-scroll-list')), findsOneWidget);
    await tester.tap(find.text('第 3 行 —— 点我试试触摸反馈'));
    await tester.pump();
    expect(find.textContaining('tap=3'), findsOneWidget);

    // tab 1:文本输入
    await tester.tap(find.text('文本输入'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('input-name')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('input-search')), '你好');
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await tester.pump();
    expect(find.byKey(const Key('input-submitted')), findsOneWidget);

    // tab 2:网络/存储(不触发真实请求,只验证 UI 就位)
    await tester.tap(find.text('网络/存储'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('http-button')), findsOneWidget);
    expect(find.byKey(const Key('storage-save')), findsOneWidget);

    // tab 3:微信能力——非小程序环境(flutter test 跑在 VM 上,恒定走 stub),
    // 应显示“仅小程序可用”提示。
    await tester.tap(find.text('微信能力'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('wechat-unavailable-banner')), findsOneWidget);
    expect(find.textContaining('仅小程序可用'), findsWidgets);

    // tab 4:原生组件——同样走 stub,mpNativeAvailable 恒为 false,渲染 fallback。
    await tester.tap(find.text('原生组件'));
    await tester.pumpAndSettle();
    expect(find.textContaining('mpNativeAvailable = false'), findsOneWidget);
    expect(find.textContaining('当前平台不支持视频组件'), findsOneWidget);
    expect(find.textContaining('当前平台不支持地图组件'), findsOneWidget);
  });
}
