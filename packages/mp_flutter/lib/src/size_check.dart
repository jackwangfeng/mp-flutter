/// 微信小程序单个代码包的体积上限。
///
/// ★ 按**源码大小(未压缩字节数)**计算,不是压缩后。
///   真机实测微信报错原文:
///     main package source size 3127KB exceed max limit 2048KB
///   佐证:开发者工具预览输出 `main 1.1 MB (1187992 bytes)`,
///   与主包各文件源码字节数之和吻合。
const int kPackageLimitBytes = 2048 * 1024;

class PackageEntry {
  final String path;

  /// 文件的源码字节数(未压缩)
  final int sourceBytes;
  final String package; // 'main' 或分包 root 名
  const PackageEntry({
    required this.path,
    required this.sourceBytes,
    required this.package,
  });
}

class SizeViolation {
  final String package;
  final int actualBytes;
  final int limitBytes;

  /// 按体积降序排列的贡献者,用于给出"该挪哪个文件"的建议。
  final List<PackageEntry> offenders;
  const SizeViolation({
    required this.package,
    required this.actualBytes,
    required this.limitBytes,
    required this.offenders,
  });

  String get message {
    final over = actualBytes - limitBytes;
    final b = StringBuffer()
      ..writeln(
        '包 "$package" 超限 ${_kb(over)}'
        '(实际 ${_kb(actualBytes)} / 上限 ${_kb(limitBytes)},按源码大小计)',
      )
      ..writeln('  体积贡献前几名:');
    for (final e in offenders.take(5)) {
      b.writeln('    ${_kb(e.sourceBytes).padLeft(10)}  ${e.path}');
    }
    b
      ..writeln('  建议:把上面最大的文件移入新的分包(单个分包上限同样是 2048KB)。')
      ..write(
        '  警告:严禁改为运行时下载 JS 来绕开限制 —— '
        '动态下发代码是微信明令禁止、下架级的违规。',
      );
    return b.toString();
  }
}

String _kb(int bytes) => '${(bytes / 1024).toStringAsFixed(0)}KB';

class SizeReport {
  final Map<String, int> perPackageBytes;
  final List<SizeViolation> violations;
  const SizeReport(this.perPackageBytes, this.violations);

  bool get ok => violations.isEmpty;

  String render() {
    final b = StringBuffer('包体积(源码大小):\n');
    final names = perPackageBytes.keys.toList()..sort();
    for (final n in names) {
      b.writeln('  ${_kb(perPackageBytes[n]!).padLeft(10)}  $n');
    }
    for (final v in violations) {
      b
        ..writeln()
        ..writeln(v.message);
    }
    return b.toString();
  }
}

SizeReport checkSizes(
  List<PackageEntry> entries, {
  int mainLimit = kPackageLimitBytes,
  int subLimit = kPackageLimitBytes,
}) {
  final per = <String, int>{};
  final byPackage = <String, List<PackageEntry>>{};
  for (final e in entries) {
    per[e.package] = (per[e.package] ?? 0) + e.sourceBytes;
    (byPackage[e.package] ??= []).add(e);
  }

  final violations = <SizeViolation>[];
  per.forEach((pkg, bytes) {
    final limit = pkg == 'main' ? mainLimit : subLimit;
    if (bytes > limit) {
      final offenders = [...byPackage[pkg]!]
        ..sort((a, b) => b.sourceBytes.compareTo(a.sourceBytes));
      violations.add(
        SizeViolation(
          package: pkg,
          actualBytes: bytes,
          limitBytes: limit,
          offenders: offenders,
        ),
      );
    }
  });
  return SizeReport(per, violations);
}
