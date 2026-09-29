// 压测页冒烟测试(缩小规模跑一遍,不是真机意义上的压测):把 StressConfig
// 的各项规模调到很小、滚动速度调到很快、项间等待清零,跑完整套 A~G 流程,
// 断言每一项都打印了一行 `[mp-stress] <id> ...`、最后打印 `[mp-stress] done`、
// 过程中没有未捕获异常。
//
// 不触发真实网络请求:`StressConfig.buildImage` 换成读内存里的一张 1x1
// PNG,而不是真的 `NetworkImage`(与 network_page.dart 一贯的“测试不发真实
// 网络请求”的约定一致,`flutter test` 环境本来也不保证有网)。
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mp_flutter_example/stress/stress_config.dart';
import 'package:mp_flutter_example/stress/stress_home.dart';

// 众所周知的 1x1 透明 PNG(见 pub 包 transparent_image 的 kTransparentImage),
// 用来在测试里喂给 Image widget,不发真实网络请求也能正常解码上屏。
const _kTinyPng = <int>[
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
  0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

void main() {
  testWidgets('压测页缩小规模跑一遍全部 A~G 项,均有遥测输出且无异常', (WidgetTester tester) async {
    // 缩小规模 + 加速,让整套流程在测试里的虚拟时间内很快跑完。
    StressConfig.listCount = 6;
    StressConfig.imageCount = 6;
    StressConfig.textParagraphTarget = 6;
    StressConfig.textCharTarget = 120;
    StressConfig.formFieldCount = 6;
    StressConfig.formFocusSampleCount = 2;
    StressConfig.cardCount = 6;
    StressConfig.scrollSpeedPxPerSec = 200000;
    StressConfig.betweenCasesDelay = Duration.zero;
    final memoryImage = MemoryImage(Uint8List.fromList(_kTinyPng));
    StressConfig.buildImage = (url) => memoryImage;
    addTearDown(StressConfig.resetToDefaults);

    final captured = <String>[];
    await runZoned(() async {
      await tester.pumpWidget(const StressExampleApp());
      // 首帧的 addPostFrameCallback 会自动触发 StressRunner.run,之后一路靠
      // 小步长轮询推进——不用 pumpAndSettle:项间/聚焦间用的是纯
      // `Future.delayed`(那段时间没有帧被调度),pumpAndSettle 只认“是否
      // 还有帧被调度”,会在这类间隙里误判为已经稳定而提前退出。
      var done = false;
      for (var i = 0; i < 600 && !done; i++) {
        await tester.pump(const Duration(milliseconds: 50));
        done = captured.any((l) => l == '[mp-stress] done');
      }
      expect(done, isTrue, reason: '600 次轮询(虚拟时间共 30s)后仍未看到 [mp-stress] done,captured=$captured');
    }, zoneSpecification: ZoneSpecification(
      print: (self, parent, zone, line) => captured.add(line),
    ));

    expect(tester.takeException(), isNull);

    const ids = ['A_long_list', 'B_image_wall', 'C_long_text_single', 'D_long_text_listview', 'E_big_form', 'F_effects', 'G_native'];
    for (final id in ids) {
      expect(
        captured.any((l) => l.startsWith('[mp-stress] $id ')),
        isTrue,
        reason: '没有找到 $id 的 [mp-stress] 遥测行,captured=$captured',
      );
    }
    expect(captured.where((l) => l == '[mp-stress] done').length, 1);
  });
}
