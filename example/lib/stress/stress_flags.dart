/// 压力测试页的构建开关与图片来源配置。
///
/// [kStressMode] 是编译期常量:只有显式传
/// `--dart-define=MP_STRESS=true`(`dart run flutter_miniprogram ... --dart-define=MP_STRESS=true`
/// 或 `flutter run/build web --dart-define=MP_STRESS=true`)才为 `true`。正式
/// 构建不带这个 define 时,`main.dart` 里 `if (kStressMode) { ... }` 的 then
/// 分支在 dart2js 看来是永远不可达的死代码——`stress/` 目录下所有类/函数都
/// 只从这个分支可达,整体被摇树删掉,不进产物、不占体积(见
/// `tools/ci/check.sh` 与 README 里“不带 MP_STRESS 时产物不含压测代码”的验证
/// 方式:构建两次比对 `build/weapp` 体积 + grep 本文件里的 `[mp-stress]`
/// 前缀字符串确认不存在)。
const bool kStressMode = bool.fromEnvironment('MP_STRESS', defaultValue: false);

/// 压测遥测行的固定前缀,accept-stress.js 与真机人工核对都认这个前缀。
/// 也是“不带 MP_STRESS 构建时产物不应包含压测代码”的 grep 目标字符串——
/// 这个前缀只在 [kStressMode] 为 true 的分支里被 `print()`,摇树后不会剩在
/// 产物 JS 里。
const String kStressLogPrefix = '[mp-stress]';

/// 压测图片来源:命令行 `--dart-define=STRESS_IMG=<url 模板>` 可覆盖,默认用
/// picsum.photos(国内访问可能慢,真机测量建议换成自己的图床,见 README/报告
/// 里的说明,仓库里不写真实业务域名)。
///
/// 模板占位符:
///   {i} — 图片 id,按 [n] 轮换(见 [urlFor])
///   {w} — 图片宽度,按 [widths] 轮换
///   {k} — 原样序号(0-based),用来让每张图的 URL 唯一,
///         例如自定义模板写 `...&v={k}` 避免 CDN/浏览器把不同尺寸的同一张图
///         误判成同一个可复用响应。
class StressImgConfig {
  const StressImgConfig._();

  static const String template =
      String.fromEnvironment('STRESS_IMG', defaultValue: 'https://picsum.photos/seed/{i}/{w}/{w}');

  static const String _nRaw = String.fromEnvironment('STRESS_IMG_N', defaultValue: '');
  static const String _widthsRaw = String.fromEnvironment('STRESS_IMG_WIDTHS', defaultValue: '');

  /// 图片服务一共有多少个不同 id 可用;<=0 表示不轮换(第 k 张直接用 id=k+1)。
  static int get n => int.tryParse(_nRaw) ?? 0;

  /// 图片服务支持的宽度档位;解析失败或未配置时退回单一档位 240。
  static List<int> get widths {
    if (_widthsRaw.trim().isEmpty) return const [240];
    final parsed = _widthsRaw
        .split(',')
        .map((s) => int.tryParse(s.trim()))
        .whereType<int>()
        .where((w) => w > 0)
        .toList();
    return parsed.isEmpty ? const [240] : parsed;
  }

  /// 第 k 张图(0-based)对应的 id。
  static int idFor(int k) => n > 0 ? (k % n) + 1 : k + 1;

  /// 第 k 张图(0-based)对应的宽度。
  static int widthFor(int k) {
    final ws = widths;
    return ws[k % ws.length];
  }

  /// 第 k 张图(0-based)最终请求的 URL。
  static String urlFor(int k) {
    final i = idFor(k);
    final w = widthFor(k);
    return template.replaceAll('{i}', '$i').replaceAll('{w}', '$w').replaceAll('{k}', '$k');
  }
}
