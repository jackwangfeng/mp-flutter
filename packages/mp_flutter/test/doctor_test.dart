import 'package:test/test.dart';
import 'package:flutter_miniprogram/src/doctor.dart';
import 'package:flutter_miniprogram/src/esbuild_resolver.dart';
import 'package:flutter_miniprogram/src/flutter_build.dart';
import 'package:flutter_miniprogram/src/toolchain.dart';

DoctorCheck _find(List<DoctorCheck> checks, String label) =>
    checks.firstWhere((c) => c.label == label);

void main() {
  group('runDoctorChecks —— 各项均用注入的探测函数,不碰真实环境/网络', () {
    test('全部正常:五项都是 ✓', () async {
      final checks = await runDoctorChecks(
        checkNode: () {}, // 不抛即视为可用
        checkBrotli: () {},
        resolveEsbuildFn: ({override, probeOnly = false}) async => '/usr/local/bin/esbuild',
        readFlutterVersionFn: (bin) async => 'Flutter 3.41.9 • channel stable\n',
        resolveFlutterBinFn: (override, {projectPath}) => override ?? 'flutter',
        wechatCliCandidatesFn: () => ['/Applications/wechatwebdevtools.app/Contents/MacOS/cli'],
        pathExists: (path) => true,
      );
      expect(checks.every((c) => c.ok), isTrue);
      expect(_find(checks, 'Node (≥18)').ok, isTrue);
      expect(_find(checks, 'esbuild').ok, isTrue);
      expect(_find(checks, 'brotli').ok, isTrue);
      expect(_find(checks, 'flutter').ok, isTrue);
      expect(_find(checks, '微信开发者工具 CLI').ok, isTrue);
    });

    test('brotli 探测抛 ToolchainMissing:该项 ✗,不计入 warnOnly(计入退出码)', () async {
      final checks = await runDoctorChecks(
        checkNode: () {},
        checkBrotli: () => throw const ToolchainMissing('brotli', 'brew install brotli'),
        resolveEsbuildFn: ({override, probeOnly = false}) async => 'esbuild',
        readFlutterVersionFn: (bin) async => 'Flutter 3.41.9 • channel stable\n',
        wechatCliCandidatesFn: () => [],
      );
      final brotli = _find(checks, 'brotli');
      expect(brotli.ok, isFalse);
      expect(brotli.warnOnly, isFalse);
      expect(brotli.detail, contains('brew install brotli'));
    });

    test('flutter SDK 不一致(FlutterSdkMismatch,D1):flutter 项判 ✗,其余检查项仍继续跑', () async {
      final checks = await runDoctorChecks(
        checkNode: () {},
        checkBrotli: () {},
        resolveEsbuildFn: ({override, probeOnly = false}) async => 'esbuild',
        resolveFlutterBinFn: (override, {projectPath}) =>
            throw const FlutterSdkMismatch('/explicit/flutter', '/inferred/bin/flutter'),
        readFlutterVersionFn: (bin) async => 'Flutter 3.41.9 • channel stable\n',
        wechatCliCandidatesFn: () => [],
      );
      final flutter = _find(checks, 'flutter');
      expect(flutter.ok, isFalse);
      expect(flutter.detail, contains('/inferred/bin/flutter'));
      // 没有因为 flutter 项失败就提前退出,esbuild/微信开发者工具 CLI 仍然跑了。
      expect(checks.any((c) => c.label == 'esbuild'), isTrue);
      expect(checks.any((c) => c.label == '微信开发者工具 CLI'), isTrue);
    });

    test('Node 探测抛 ToolchainMissing:该项 ✗', () async {
      final checks = await runDoctorChecks(
        checkNode: () => throw const ToolchainMissing('node', '找不到 node'),
        checkBrotli: () {},
        resolveEsbuildFn: ({override, probeOnly = false}) async => 'esbuild',
        readFlutterVersionFn: (bin) async => 'Flutter 3.41.9 • channel stable\n',
        wechatCliCandidatesFn: () => [],
      );
      expect(_find(checks, 'Node (≥18)').ok, isFalse);
    });

    test('esbuild 尚未安装(EsbuildNotInstalled):不算失败,仍是 ✓ 并提示将自动安装', () async {
      final checks = await runDoctorChecks(
        checkNode: () {},
        checkBrotli: () {},
        resolveEsbuildFn: ({override, probeOnly = false}) async =>
            throw const EsbuildNotInstalled('将自动安装 esbuild@0.28.2'),
        readFlutterVersionFn: (bin) async => 'Flutter 3.41.9 • channel stable\n',
        wechatCliCandidatesFn: () => [],
      );
      final esbuild = _find(checks, 'esbuild');
      expect(esbuild.ok, isTrue);
      expect(esbuild.detail, contains('自动安装'));
    });

    test('esbuild 显式覆盖路径无效(ToolchainMissing):判 ✗', () async {
      final checks = await runDoctorChecks(
        checkNode: () {},
        checkBrotli: () {},
        resolveEsbuildFn: ({override, probeOnly = false}) async =>
            throw const ToolchainMissing('esbuild', '路径不存在'),
        readFlutterVersionFn: (bin) async => 'Flutter 3.41.9 • channel stable\n',
        wechatCliCandidatesFn: () => [],
      );
      expect(_find(checks, 'esbuild').ok, isFalse);
    });

    test('flutter 版本在支持矩阵内:标注"已验证"', () async {
      final checks = await runDoctorChecks(
        checkNode: () {},
        checkBrotli: () {},
        resolveEsbuildFn: ({override, probeOnly = false}) async => 'esbuild',
        readFlutterVersionFn: (bin) async => 'Flutter 3.41.9 • channel stable\n',
        wechatCliCandidatesFn: () => [],
      );
      expect(_find(checks, 'flutter').detail, contains('已验证'));
      expect(_find(checks, 'flutter').ok, isTrue);
    });

    test('flutter 版本不在支持矩阵内:标注"未验证",但仍是 ✓(能跑就行)', () async {
      final checks = await runDoctorChecks(
        checkNode: () {},
        checkBrotli: () {},
        resolveEsbuildFn: ({override, probeOnly = false}) async => 'esbuild',
        readFlutterVersionFn: (bin) async => 'Flutter 9.9.9 • channel stable\n',
        wechatCliCandidatesFn: () => [],
      );
      final flutter = _find(checks, 'flutter');
      expect(flutter.ok, isTrue);
      expect(flutter.detail, contains('未验证'));
    });

    test('flutter 不可执行:判 ✗', () async {
      final checks = await runDoctorChecks(
        checkNode: () {},
        checkBrotli: () {},
        resolveEsbuildFn: ({override, probeOnly = false}) async => 'esbuild',
        readFlutterVersionFn: (bin) async => throw StateError('无法执行 $bin --version'),
        wechatCliCandidatesFn: () => [],
      );
      expect(_find(checks, 'flutter').ok, isFalse);
    });

    test('微信开发者工具 CLI:候选路径都不存在时判 ✗,但 warnOnly(M4:不计入退出码)', () async {
      final checks = await runDoctorChecks(
        checkNode: () {},
        checkBrotli: () {},
        resolveEsbuildFn: ({override, probeOnly = false}) async => 'esbuild',
        readFlutterVersionFn: (bin) async => 'Flutter 3.41.9 • channel stable\n',
        wechatCliCandidatesFn: () => ['/Applications/wechatwebdevtools.app/Contents/MacOS/cli'],
        pathExists: (path) => false,
      );
      final wechat = _find(checks, '微信开发者工具 CLI');
      expect(wechat.ok, isFalse);
      expect(wechat.warnOnly, isTrue);
    });

    test('微信开发者工具 CLI:平台无已知候选路径(空列表)时不判失败', () async {
      final checks = await runDoctorChecks(
        checkNode: () {},
        checkBrotli: () {},
        resolveEsbuildFn: ({override, probeOnly = false}) async => 'esbuild',
        readFlutterVersionFn: (bin) async => 'Flutter 3.41.9 • channel stable\n',
        wechatCliCandidatesFn: () => [],
      );
      expect(_find(checks, '微信开发者工具 CLI').ok, isTrue);
    });
  });
}
