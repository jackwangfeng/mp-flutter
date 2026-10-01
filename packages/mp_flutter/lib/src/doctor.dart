import 'dart:io';

import 'esbuild_resolver.dart';
import 'flutter_build.dart';
import 'toolchain.dart';
import 'transform/split_main_dart_js.dart';
import 'version_matrix.dart';

/// `dart run flutter_miniprogram doctor` 单项检查的结果。
///
/// [ok] 为 false 且 [warnOnly] 为 false 时,doctor 命令整体退出码为 1(见
/// bin/flutter_miniprogram.dart)。[warnOnly] 为 true 的项(M4:微信开发者工具 CLI
/// 缺失)即使 [ok] 为 false 也只提示、不计入退出码——它只影响命令行自动
/// 上传/预览,不影响本地构建产物,不该让 `doctor` 在正常开发机上返回非零。
class DoctorCheck {
  final String label;
  final bool ok;
  final String detail;
  final bool warnOnly;
  const DoctorCheck({
    required this.label,
    required this.ok,
    required this.detail,
    this.warnOnly = false,
  });

  /// 供 CLI 打印的一行:`✓ label: detail` / `✗ label: detail` /
  /// `⚠ label: detail`(warnOnly 且未通过时)。
  String render() {
    final mark = ok ? '✓' : (warnOnly ? '⚠' : '✗');
    return '$mark $label:$detail';
  }
}

/// 微信开发者工具 CLI 的默认安装路径,按平台给出候选列表。
///
/// 未知平台(非 macOS/Windows)返回空列表——doctor 侧对空列表不判 ✗
/// (没有已知默认路径可查,不是"确认缺失"),避免在 Linux CI 上误报。
List<String> wechatCliCandidates() {
  if (Platform.isMacOS) {
    return const ['/Applications/wechatwebdevtools.app/Contents/MacOS/cli'];
  }
  if (Platform.isWindows) {
    // 微信开发者工具 Windows 默认安装路径;新旧安装包用过中英两种目录名,
    // 都列出来,存在任一个即算找到。
    return const [
      r'C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat',
      r'C:\Program Files\Tencent\微信web开发者工具\cli.bat',
      r'C:\Program Files (x86)\Tencent\wechatwebdevtools\cli.bat',
    ];
  }
  return const [];
}

/// 跑全部 doctor 检查项。所有外部交互(进程调用/文件系统)都可注入——
/// 单元测试不需要真的探测本机环境,也绝不联网。
///
/// [flutterBin]/[esbuildOverride] 对应 CLI 的 `--flutter`/`--esbuild`(doctor
/// 也遵循同样的显式覆盖)。[projectPath] 是工程根(找不到时为 null,见
/// bin/flutter_miniprogram.dart)——用于 D1 的 flutter SDK 探测(优先用
/// `.dart_tool/package_config.json` 里 flutter 包所在 SDK)。
Future<List<DoctorCheck>> runDoctorChecks({
  String? flutterBin,
  String? esbuildOverride,
  String? projectPath,
  void Function() checkNode = checkNodeAvailable,
  void Function() checkBrotli = checkBrotliAvailable,
  Future<String> Function({String? override, bool probeOnly}) resolveEsbuildFn =
      _resolveEsbuildDefault,
  Future<String> Function(String flutterBin) readFlutterVersionFn =
      readFlutterVersion,
  String Function(String? override, {String? projectPath}) resolveFlutterBinFn =
      resolveFlutterBin,
  bool Function(String path) pathExists = _pathExistsDefault,
  List<String> Function() wechatCliCandidatesFn = wechatCliCandidates,
}) async {
  final checks = <DoctorCheck>[];

  // 1. Node ≥18(main.dart.js 分片依赖)。
  try {
    checkNode();
    checks.add(const DoctorCheck(label: 'Node (≥18)', ok: true, detail: ' 可用'));
  } on ToolchainMissing catch (e) {
    checks.add(
      DoctorCheck(label: 'Node (≥18)', ok: false, detail: ' ${e.message}'),
    );
  }

  // 2. esbuild —— 只探测,不触发自动安装。探测不到时不算失败:构建时会
  //    自动装,这里只是提前告知。
  try {
    final path = await resolveEsbuildFn(
      override: esbuildOverride,
      probeOnly: true,
    );
    checks.add(DoctorCheck(label: 'esbuild', ok: true, detail: ' 已就绪($path)'));
  } on EsbuildNotInstalled catch (e) {
    checks.add(
      DoctorCheck(label: 'esbuild', ok: true, detail: ' 尚未安装,${e.hint}'),
    );
  } on ToolchainMissing catch (e) {
    // 只有显式指定了坏路径(--esbuild/MP_FLUTTER_ESBUILD)才会走到这——
    // 这才是真的配置错误,判 ✗。
    checks.add(
      DoctorCheck(label: 'esbuild', ok: false, detail: ' ${e.message}'),
    );
  }

  // 3. brotli(I2):canvaskit.wasm 压缩依赖,macOS/Linux 都不预装。
  try {
    checkBrotli();
    checks.add(const DoctorCheck(label: 'brotli', ok: true, detail: ' 可用'));
  } on ToolchainMissing catch (e) {
    checks.add(
      DoctorCheck(label: 'brotli', ok: false, detail: ' ${e.message}'),
    );
  }

  // 4. flutter 可执行 + 版本(是否在已验证矩阵内只是标注,不影响 ✓/✗——
  //    未验证版本仍然可能跑得通,只是没有回归证据)。SDK 不一致(D1)时
  //    resolveFlutterBinFn 会抛 FlutterSdkMismatch,doctor 判该项 ✗,后续
  //    仍继续跑完其余检查项(不提前 return)。
  String? bin;
  try {
    bin = resolveFlutterBinFn(flutterBin, projectPath: projectPath);
  } on FlutterSdkMismatch catch (e) {
    checks.add(
      DoctorCheck(label: 'flutter', ok: false, detail: ' ${e.message}'),
    );
  }
  if (bin != null) {
    try {
      final out = await readFlutterVersionFn(bin);
      final version = FlutterVersion.parse(out);
      final verified = VersionMatrix.supported.contains(version.version);
      checks.add(
        DoctorCheck(
          label: 'flutter',
          ok: true,
          detail:
              ' $bin — ${version.version}'
              '${version.isOhosFork ? ' (ohos fork)' : ''}'
              '(${verified ? '已验证' : '未验证'})',
        ),
      );
    } catch (e) {
      checks.add(
        DoctorCheck(
          label: 'flutter',
          ok: false,
          detail: ' $bin 不可执行或版本无法解析:$e',
        ),
      );
    }
  }

  // 5. 微信开发者工具 CLI(M4:命令行自动上传/预览依赖它,不影响本地构建
  //    产物——缺失只警告,不计入 doctor 整体退出码,见 DoctorCheck.warnOnly)。
  final candidates = wechatCliCandidatesFn();
  if (candidates.isEmpty) {
    checks.add(
      const DoctorCheck(
        label: '微信开发者工具 CLI',
        ok: true,
        detail: ' 当前平台无已知默认路径,跳过检测',
      ),
    );
  } else {
    final found = candidates.where(pathExists).toList();
    if (found.isNotEmpty) {
      checks.add(
        DoctorCheck(
          label: '微信开发者工具 CLI',
          ok: true,
          detail: ' 已找到:${found.first}',
        ),
      );
    } else {
      checks.add(
        DoctorCheck(
          label: '微信开发者工具 CLI',
          ok: false,
          warnOnly: true,
          detail:
              ' 未在默认路径找到(${candidates.join('; ')})。'
              '不影响 flutter_miniprogram 构建,仅影响命令行自动上传/预览。',
        ),
      );
    }
  }

  return checks;
}

Future<String> _resolveEsbuildDefault({
  String? override,
  bool probeOnly = false,
}) {
  return resolveEsbuild(override: override, probeOnly: probeOnly);
}

bool _pathExistsDefault(String path) => File(path).existsSync();
