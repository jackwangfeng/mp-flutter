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

/// 显式严格校验时,Flutter 版本不在已验证矩阵内。
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
  /// 已验证的版本,不作为默认构建白名单;验收状态见 docs/support-matrix.md。
  static const supported = <String>[
    '3.41.9',
    '3.47.4',
    '3.41.10-ohos-0.0.2-beta',
  ];

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

  /// 默认允许其他版本尝试构建;调用方可收集警告,或显式启用严格校验。
  static void check(
    FlutterVersion v, {
    bool strict = false,
    void Function(String message)? warn,
  }) {
    if (supported.contains(v.version)) return;
    if (strict) throw UnsupportedFlutterVersion(v.version, supported);
    (warn ?? print)(
      '警告:Flutter ${v.version} 尚未经过本项目回归验证,继续尝试构建。'
      '已验证版本:${supported.join(', ')}。'
      '构建成功不代表运行验收通过,请在开发者工具及真机验证。',
    );
  }

  /// 查询指定版本的已知分叉差异。
  /// 如果版本不在支持矩阵内,返回空列表。
  static List<KnownDivergence> knownDivergences(FlutterVersion v) {
    return _knownDivergences[v.version] ?? [];
  }
}
