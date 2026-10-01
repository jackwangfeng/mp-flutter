import 'package:flutter/widgets.dart';

/// 各压测项的规模/时序参数,集中放这里而不是散在各个 case 文件里,方便
/// 冒烟 widget test(`example/test/stress_smoke_test.dart`)整体调小规模、
/// 调快节奏——真机/E2E 跑的是默认值(见各字段注释里的“真机默认”)。
///
/// 除 [buildImage] 外全部是可变静态字段,测试在 `pumpWidget` 之前覆盖,
/// 用完不需要恢复(每个 test 进程只跑一次)。
class StressConfig {
  const StressConfig._();

  /// A:长列表行数。真机默认 500。
  static int listCount = 500;

  /// B:图片墙张数。真机默认至少 120。
  static int imageCount = 120;

  /// C/D:长图文段落数下限与总字数下限。真机默认 150 段 / 6000 字。
  static int textParagraphTarget = 150;
  static int textCharTarget = 6000;

  /// E:大表单输入框数量,以及依次 focus/unfocus 的输入框个数。
  static int formFieldCount = 30;
  static int formFocusSampleCount = 5;

  /// F:效果卡片数量。真机默认约 40。
  static int cardCount = 40;

  /// 自动滚动速度(像素/秒),到底再回顶,保证可复现。真机默认 3000。
  static double scrollSpeedPxPerSec = 3000;

  /// 每项结束后 pop、进下一项前的等待时间。真机默认 1s;冒烟测试里调成 0
  /// 避免 `WidgetTester.pump` 在这段真实无帧调度的等待上卡住
  /// (`pumpAndSettle` 只认“是否还有帧被调度”,纯 `Future.delayed` 的等待
  /// 期间没有帧,测试侧改用有限次数的 `pump(小步长)` 轮询,见冒烟测试)。
  static Duration betweenCasesDelay = const Duration(seconds: 1);

  /// 首页首帧之后、开始第一项之前的等待。真机默认 3s——模拟用户先看一眼首页
  /// 再点进列表(运行时的着色器预热只在空闲时进行,见
  /// packages/mp_flutter/runtime/shader-warmup.js;不留这段空闲,A 项测到的就是"启动瞬间就进列表"
  /// 的最坏情况)。冒烟测试里调成 0。
  static Duration startDelay = const Duration(seconds: 3);

  /// B/A 里网络图片的 [ImageProvider] 构造方式。默认真去请求 [StressImgConfig]
  /// 算出的 URL;冒烟 widget test 会替换成不发真实网络请求的内存图片
  /// (`flutter test` 环境里发真实 HTTP 请求既慢又可能因为没有网络而挂起,
  /// 与 `network_page.dart` 里“测试不触发真实网络”的既有约定一致)。
  static ImageProvider Function(String url) buildImage = (url) => NetworkImage(url);

  /// 重置成真机默认值——冒烟测试跑完后不是必需的(进程即将退出),提供出来
  /// 只是为了以后有别的测试想复用这个文件时不必手写一遍默认值。
  static void resetToDefaults() {
    listCount = 500;
    imageCount = 120;
    textParagraphTarget = 150;
    textCharTarget = 6000;
    formFieldCount = 30;
    formFocusSampleCount = 5;
    cardCount = 40;
    scrollSpeedPxPerSec = 3000;
    betweenCasesDelay = const Duration(seconds: 1);
    startDelay = const Duration(seconds: 3);
    buildImage = (url) => NetworkImage(url);
  }
}
