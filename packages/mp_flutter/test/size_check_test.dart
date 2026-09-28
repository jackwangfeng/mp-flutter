import 'package:test/test.dart';
import 'package:mp_flutter/src/size_check.dart';

const kb = 1024;

void main() {
  test('全部在限内 → ok', () {
    // 数值取自真机实测:主包 1.1MB / 分包 1.5MB,均在 2048KB 内
    final r = checkSizes([
      const PackageEntry(path: 'main.dart.js', sourceBytes: 978135, package: 'main'),
      const PackageEntry(path: 'canvaskit.js', sourceBytes: 139264, package: 'main'),
      const PackageEntry(path: 'pkg-wasm/canvaskit.wasm.br', sourceBytes: 1611250, package: 'pkg-wasm'),
    ]);
    expect(r.ok, isTrue);
    expect(r.violations, isEmpty);
  });

  test('上限是 2048KB 源码字节,不是 2MB 压缩后', () {
    expect(kPackageLimitBytes, 2048 * 1024);
  });

  test('主包超限 → 报出违规(真机实测值 3127KB)', () {
    final r = checkSizes([
      const PackageEntry(path: 'main.dart.js', sourceBytes: 3127 * kb, package: 'main'),
    ]);
    expect(r.ok, isFalse);
    expect(r.violations.single.package, 'main');
    expect(r.violations.single.actualBytes, 3127 * kb);
    expect(r.violations.single.limitBytes, 2048 * kb);
  });

  test('按包聚合体积', () {
    final r = checkSizes([
      const PackageEntry(path: 'a.js', sourceBytes: 100, package: 'main'),
      const PackageEntry(path: 'b.js', sourceBytes: 200, package: 'main'),
      const PackageEntry(path: 'c.js', sourceBytes: 50, package: 'pkg-assets'),
    ]);
    expect(r.perPackageBytes['main'], 300);
    expect(r.perPackageBytes['pkg-assets'], 50);
  });

  test('恰好等于上限不算超限', () {
    final r = checkSizes([
      const PackageEntry(path: 'exact.js', sourceBytes: 2048 * kb, package: 'main'),
    ]);
    expect(r.ok, isTrue);
  });

  group('超限时必须可诊断', () {
    test('错误信息指名道姓列出最大的文件', () {
      final r = checkSizes([
        const PackageEntry(path: 'assets/huge-font.js', sourceBytes: 1800 * kb, package: 'main'),
        const PackageEntry(path: 'main.dart.js', sourceBytes: 500 * kb, package: 'main'),
        const PackageEntry(path: 'tiny.js', sourceBytes: 1024, package: 'main'),
      ]);
      expect(r.ok, isFalse);
      final msg = r.violations.single.message;
      expect(msg, contains('assets/huge-font.js'), reason: '没指出最大的文件');
      expect(msg, contains('超限'));
      expect(msg, contains('分包'), reason: '没给出可操作的建议');
      expect(msg, contains('源码大小'), reason: '没说明体积口径,用户会误以为是压缩后');
      expect(msg, contains('动态下发'), reason: '没警告绕开限制的违规做法');
      expect(r.violations.single.offenders.first.path, 'assets/huge-font.js');
    });

    test('多个包同时超限 → 每个都单独报告', () {
      final r = checkSizes([
        const PackageEntry(path: 'a.js', sourceBytes: 3000 * kb, package: 'main'),
        const PackageEntry(path: 'b.js', sourceBytes: 3000 * kb, package: 'pkg-assets'),
      ]);
      expect(r.violations, hasLength(2));
      expect(r.violations.map((v) => v.package), containsAll(['main', 'pkg-assets']));
    });

    test('render() 同时给出全局概览和违规明细', () {
      final r = checkSizes([
        const PackageEntry(path: 'big.js', sourceBytes: 3000 * kb, package: 'main'),
      ]);
      final out = r.render();
      expect(out, contains('包体积'));
      expect(out, contains('源码大小'));
      expect(out, contains('big.js'));
    });

    test('超限 1 字节也算超限', () {
      final r = checkSizes([
        const PackageEntry(path: 'x.js', sourceBytes: 2048 * kb + 1, package: 'main'),
      ]);
      expect(r.ok, isFalse);
    });
  });
}
