import 'dart:io';

import 'package:flutter_miniprogram/src/entrypoint.dart';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';

void main() {
  late Directory tmp;
  setUp(() => tmp = Directory.systemTemp.createTempSync('mpf_entry_'));
  tearDown(() => tmp.deleteSync(recursive: true));

  void project({String pubspec = 'name: my_app\n', bool mainDart = true}) {
    File(p.join(tmp.path, 'pubspec.yaml')).writeAsStringSync(pubspec);
    if (mainDart) {
      File(p.join(tmp.path, 'lib', 'main.dart'))
        ..createSync(recursive: true)
        ..writeAsStringSync('void main() {}\n');
    }
  }

  test('写到 .dart_tool/flutter_miniprogram/entrypoint.dart,按包名导入用户 main', () {
    project();
    final rel = writeEntrypoint(tmp.path);
    expect(rel, kEntrypointRelPath);
    final src = File(p.join(tmp.path, rel)).readAsStringSync();
    expect(src, contains("import 'package:my_app/main.dart' as app;"));
    // 用户 lib/main.dart 不被改动
    expect(File(p.join(tmp.path, 'lib', 'main.dart')).readAsStringSync(), 'void main() {}\n');
  });

  test('入口包装:用户 main 之前装绑定,覆盖 wrapWithDefaultView,读 self.__mpSafeArea', () {
    final src = buildEntrypointSource('x');
    expect(src.indexOf('_MpBinding();'), lessThan(src.indexOf('m();')));
    expect(src, contains('Widget wrapWithDefaultView(Widget rootWidget)'));
    expect(src, contains("@JS('__mpSafeArea')"));
    expect(src, contains('data.copyWith(viewPadding: vp, padding: pad)'));
  });

  test('入口包装:首帧之后才 listen self.__mpLateFonts,晚到的粗体经 ui.loadFontFromList 补注册', () {
    final src = buildEntrypointSource('x');
    expect(src, contains("@JS('__mpLateFonts')"));
    expect(src.indexOf('_listenLateFonts();'), lessThan(src.indexOf('m();')));
    expect(src, contains('addPostFrameCallback'));
    expect(src, contains('ui.loadFontFromList(bytes.toDart, fontFamily: family.toDart)'));
  });

  test('入口包装:iOS 目标平台在用户 main 之前让光标常亮(不跑 60fps 淡入淡出动画)', () {
    final src = buildEntrypointSource('x');
    expect(src.indexOf('_steadyCursorOnIOS();'), lessThan(src.indexOf('m();')));
    expect(src, contains('defaultTargetPlatform == TargetPlatform.iOS'));
    expect(src, contains('EditableText.debugDeterministicCursor = true;'));
  });

  // I1 修复:密码框最后一位明文常驻——iOS 常亮光标让 obscureText 的短暂明文
  // 展示计时(靠光标 tick 递减)永远不会被消费。入口包装监听
  // self.__mpPasswordFocus(text-bridge.js 在密码框聚焦/失焦时维护),聚焦时
  // 临时把标志切回 false、失焦后恢复 true。
  test('入口包装:监听 self.__mpPasswordFocus,密码框聚焦/失焦时切换 debugDeterministicCursor', () {
    final src = buildEntrypointSource('x');
    expect(src, contains("@JS('__mpPasswordFocus')"));
    expect(src, contains('extension type _PasswordFocusBridge'));
    // 监听回调必须能同时切到 false(聚焦)与恢复 true(失焦),不是写死一个值
    expect(src, contains('EditableText.debugDeterministicCursor = !obscure;'));
    // 监听注册在 _steadyCursorOnIOS 的 iOS/macOS 分支里,与常亮设置同生命周期
    final steadyBody = src.substring(
        src.indexOf('void _steadyCursorOnIOS()'), src.indexOf('@JS(\'__mpPasswordFocus\')'));
    expect(steadyBody, contains('_passwordFocusBridge'));
  });

  test('入口包装:--perf-hud 帧分项只在 self.__mpFrameProf 存在时生效,否则全部走 super', () {
    final src = buildEntrypointSource('x');
    expect(src, contains("@JS('__mpFrameProf')"));
    expect(src, contains('_prof == null ? super.createRootPipelineOwner() : _ProfRootPipelineOwner()'));
    expect(src, contains('if (prof == null) return super.handleDrawFrame();'));
    expect(src, contains('final class _ProfRootPipelineOwner extends PipelineOwner'));
  });

  test('没有 lib/main.dart:跳过(不致命)', () {
    project(mainDart: false);
    expect(() => writeEntrypoint(tmp.path), throwsA(isA<EntrypointSkipped>()));
  });

  test('pubspec 没有合法 name:跳过', () {
    project(pubspec: 'description: x\n');
    expect(() => writeEntrypoint(tmp.path), throwsA(isA<EntrypointSkipped>()));
  });

  group('--target(M5):自定义入口文件', () {
    test('target 在 lib/ 子目录下:仍用 package: URI(相对 lib/ 拼路径)', () {
      project();
      File(p.join(tmp.path, 'lib', 'pages', 'custom_main.dart'))
        ..createSync(recursive: true)
        ..writeAsStringSync('void main() {}\n');
      final rel = writeEntrypoint(tmp.path, targetRelPath: 'lib/pages/custom_main.dart');
      expect(rel, kEntrypointRelPath);
      final src = File(p.join(tmp.path, rel)).readAsStringSync();
      expect(src, contains("import 'package:my_app/pages/custom_main.dart' as app;"));
    });

    test('target 在 lib/ 之外:退回相对入口包装自身目录的相对 import', () {
      project();
      File(p.join(tmp.path, 'tool', 'alt_main.dart'))
        ..createSync(recursive: true)
        ..writeAsStringSync('void main() {}\n');
      final rel = writeEntrypoint(tmp.path, targetRelPath: 'tool/alt_main.dart');
      final src = File(p.join(tmp.path, rel)).readAsStringSync();
      // 入口包装本身在 .dart_tool/flutter_miniprogram/ 下,相对它到工程根下的
      // tool/alt_main.dart 是 ../../tool/alt_main.dart。
      expect(src, contains("import '../../tool/alt_main.dart' as app;"));
      // 两种 import 形式都要能被真正解析:这里只断言字符串生成正确
      // (dart2js 实际编译由 consumer_smoke_test.dart /手动验证覆盖)。
    });

    test('target 指向的文件不存在:跳过(不致命),错误信息带上该路径', () {
      project();
      expect(
        () => writeEntrypoint(tmp.path, targetRelPath: 'lib/does_not_exist.dart'),
        throwsA(isA<EntrypointSkipped>().having(
            (e) => e.reason, 'reason', contains('lib/does_not_exist.dart'))),
      );
    });

    test('entrypointImportFor:target 就是默认 lib/main.dart 时与旧行为一致', () {
      expect(
        entrypointImportFor('/repo/app', 'my_app', '/repo/app/lib/main.dart'),
        'package:my_app/main.dart',
      );
    });

    test('entrypointImportFor:target 是绝对路径也能正确识别 lib/ 内外', () {
      expect(
        entrypointImportFor('/repo/app', 'my_app', '/repo/app/lib/foo/bar.dart'),
        'package:my_app/foo/bar.dart',
      );
      expect(
        entrypointImportFor('/repo/app', 'my_app', '/repo/app/scripts/entry.dart'),
        '../../scripts/entry.dart',
      );
    });
  });
}
