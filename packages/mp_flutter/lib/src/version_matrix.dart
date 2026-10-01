/// 单个已知的版本分叉差异。
class KnownDivergence {
  final String id;
  final String description;
  final String consequence;

  const KnownDivergence({
    required this.id,
    required this.description,
    required this.consequence,
  });
}

/// Flutter 版本不在支持矩阵内。
///
/// 垫片与构建期变换都打在 engine 产物的**内部形状**上(握手入口、
/// `window.flutterCanvasKit`、canvaskit.js 的补丁点)。这些不是公开 API,
/// 换版本随时会变。所以宁可显式拒绝,也不静默尝试。
class UnsupportedFlutterVersion implements Exception {
  final String found;
  final List<String> supported;
  const UnsupportedFlutterVersion(this.found, this.supported);

  String get message =>
      '不支持的 Flutter 版本:$found\n'
      '当前支持:${supported.join(', ')}\n'
      'mp_flutter 依赖 engine 产物的内部形状,换版本需先跑一遍回归套件。';

  @override
  String toString() => 'UnsupportedFlutterVersion: $message';
}

class FlutterVersion {
  final String version;
  final bool isOhosFork;
  const FlutterVersion(this.version, {this.isOhosFork = false});

  static final _re = RegExp(r'^Flutter\s+(\S+)', multiLine: true);

  /// 解析 `flutter --version` 的首行。
  static FlutterVersion parse(String flutterVersionOutput) {
    final m = _re.firstMatch(flutterVersionOutput);
    if (m == null) {
      throw FormatException(
        '无法从 flutter --version 输出中解析版本号',
        flutterVersionOutput,
      );
    }
    final v = m.group(1)!;
    return FlutterVersion(v, isOhosFork: v.contains('ohos'));
  }
}

class VersionMatrix {
  /// 已通过回归套件验证的版本。新增版本前必须先跑 tools/e2e。
  static const supported = <String>['3.41.9', '3.41.10-ohos-0.0.2-beta'];

  /// 已知的版本分叉差异映射。
  static const _knownDivergences = <String, List<KnownDivergence>>{
    '3.41.9': [],
    '3.41.10-ohos-0.0.2-beta': [
      KnownDivergence(
        id: 'missing_material_shaders',
        description:
            'Material shaders 未被打包 (ink_sparkle.frag、stretch_effect.frag)',
        consequence: '使用 Material InkSparkle 水波纹或 overscroll 拉伸的应用运行时取不到这两个资源。',
      ),
    ],
  };

  static void check(FlutterVersion v) {
    if (!supported.contains(v.version)) {
      throw UnsupportedFlutterVersion(v.version, supported);
    }
  }

  /// 查询指定版本的已知分叉差异。
  /// 如果版本不在支持矩阵内,返回空列表。
  static List<KnownDivergence> knownDivergences(FlutterVersion v) {
    return _knownDivergences[v.version] ?? [];
  }
}
