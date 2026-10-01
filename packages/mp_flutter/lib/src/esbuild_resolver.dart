import 'dart:io';

import 'package:path/path.dart' as p;

import 'toolchain.dart';

/// esbuild 精确版本。取自原 `tools/esbuild/package-lock.json` 锁定的版本——
/// 语法降级(见 `transform/canvaskit_js.dart` 的 `downgradeToEs2017`)的行为
/// 依赖具体版本,自动安装必须钉死这一个版本,不能让消费者机器装到任意新版本。
/// 升级 esbuild 只需要改这一个常量。
const kEsbuildVersion = '0.28.2';

/// `resolveEsbuild(probeOnly: true)` 探测不到已安装的 esbuild 时抛出——
/// 与 [ToolchainMissing] 故意区分开:这不是"缺工具、构建会失败",而是
/// "现在没有,但正常构建时会自动装好",doctor 侧应展示为提示而非失败项。
class EsbuildNotInstalled implements Exception {
  final String hint;
  const EsbuildNotInstalled(this.hint);

  @override
  String toString() => 'EsbuildNotInstalled: $hint';
}

/// [Process.run] 的签名,供测试注入(断言命令行、不真的联网/落盘)。
typedef ProcessRunner =
    Future<ProcessResult> Function(
      String executable,
      List<String> arguments, {
      Map<String, String>? environment,
      bool includeParentEnvironment,
    });

Future<ProcessResult> _defaultRunner(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
  bool includeParentEnvironment = true,
}) {
  return Process.run(
    executable,
    arguments,
    environment: environment,
    includeParentEnvironment: includeParentEnvironment,
  );
}

/// 缓存目录 `~/.mp_flutter`(自动安装 esbuild 的落点)。
///
/// [env] 仅供测试注入;为 null 时用真实 `Platform.environment` 取 HOME/
/// USERPROFILE。
String _defaultCacheHome(Map<String, String>? env) {
  final environment = env ?? Platform.environment;
  final home = Platform.isWindows
      ? (environment['USERPROFILE'] ?? '.')
      : (environment['HOME'] ?? '.');
  return p.join(home, '.mp_flutter');
}

/// 定位 esbuild 可执行文件,解析顺序(任一步失败都抛 [ToolchainMissing],
/// 不静默跳过——理由见 `pipeline.dart` 里旧版 `resolveEsbuildPath` 的文档,
/// 跳过语法降级的后果是产物在模拟器里正常、却在微信上传校验器那一步被拒):
///
///   1. [override] —— CLI `--esbuild` 显式指定的路径
///   2. `env['MP_FLUTTER_ESBUILD']` —— 环境变量显式指定
///   3. PATH 上的 `esbuild`
///   4. 缓存 `~/.mp_flutter/esbuild-<ver>/node_modules/.bin/esbuild`
///      (上一次自动安装留下的)
///   5. 自动执行 `npm install --prefix <缓存目录> esbuild@<ver>`(全流程唯一
///      允许联网的一步,安装前打印一行说明,方便离线环境的用户看懂在等什么)
///
/// [env] 为 null 时使用真实环境变量与 PATH;传入非 null 值可在测试里完全
/// 隔离真实机器状态。[cacheHome] 仅供测试注入,覆盖 `~/.mp_flutter`。
/// [run] 仅供测试注入,断言真正会执行的命令行而不实际运行它们。
///
/// [probeOnly] 为 true 时用于 `doctor` 子命令:只做 1–4 步的只读探测
/// (override/环境变量/PATH/缓存),第 5 步(`npm install`)绝不执行——
/// doctor 的定位是"快速自检",不该有副作用(联网/写盘)。走到第 5 步时不
/// 报错,而是抛 [EsbuildNotInstalled],让调用方(doctor)把它当成"正常但
/// 尚未安装,构建时会自动装"来展示,而不是失败项。
Future<String> resolveEsbuild({
  String? override,
  Map<String, String>? env,
  String? cacheHome,
  ProcessRunner run = _defaultRunner,
  bool probeOnly = false,
}) async {
  if (override != null) {
    if (!File(override).existsSync()) {
      throw ToolchainMissing(
        'esbuild($override 不存在)',
        '显式指定的 esbuild 路径找不到对应文件。请检查 --esbuild 参数,或去掉它'
            '让工具按默认顺序探测/自动安装。',
      );
    }
    return override;
  }

  final useCustomEnv = env != null;
  final fromEnvVar = (env ?? Platform.environment)['MP_FLUTTER_ESBUILD'];
  if (fromEnvVar != null && fromEnvVar.isNotEmpty) {
    if (!File(fromEnvVar).existsSync()) {
      throw ToolchainMissing(
        'esbuild(MP_FLUTTER_ESBUILD=$fromEnvVar 不存在)',
        '环境变量 MP_FLUTTER_ESBUILD 指定的路径找不到对应文件。请检查该路径,或'
            '取消设置这个环境变量让工具按默认顺序探测/自动安装。',
      );
    }
    return fromEnvVar;
  }

  // `which`/`where` 本身也可能在极简环境里不存在,探测失败一律当作"PATH 里
  // 没有 esbuild"处理,落到下面的缓存/自动安装,而不是让 ProcessException
  // 未捕获地往上抛。
  ProcessResult probe;
  try {
    probe = await run(
      Platform.isWindows ? 'where' : 'which',
      ['esbuild'],
      environment: env,
      includeParentEnvironment: !useCustomEnv,
    );
  } on ProcessException {
    probe = ProcessResult(0, 1, '', '');
  }
  if (probe.exitCode == 0) return 'esbuild';

  final cache = cacheHome ?? _defaultCacheHome(env);
  final installDir = p.join(cache, 'esbuild-$kEsbuildVersion');
  final cachedBin = p.join(installDir, 'node_modules/.bin/esbuild');
  if (File(cachedBin).existsSync()) return cachedBin;

  if (probeOnly) {
    throw EsbuildNotInstalled(
      'esbuild 尚未安装,首次真正构建时会自动执行 '
      'npm install --prefix $installDir esbuild@$kEsbuildVersion(需要联网)。',
    );
  }

  // 全流程唯一允许联网的一步:先打印说明,离线环境的用户能立刻看懂接下来
  // 卡住/失败是在等网络,而不是一个无解释的挂起。
  stdout.writeln(
    '[mp-flutter] 首次使用 esbuild($kEsbuildVersion 未安装),'
    '正在执行 npm install --prefix $installDir esbuild@$kEsbuildVersion …',
  );

  try {
    Directory(installDir).createSync(recursive: true);
  } on FileSystemException catch (e) {
    throw ToolchainMissing(
      'esbuild',
      '创建缓存目录失败($installDir):$e\n'
          '请检查该路径的写权限,或用 --esbuild / MP_FLUTTER_ESBUILD 指定一个已装好的 esbuild。',
    );
  }

  ProcessResult install;
  try {
    install = await run(
      'npm',
      ['install', '--prefix', installDir, 'esbuild@$kEsbuildVersion'],
      environment: env,
      includeParentEnvironment: !useCustomEnv,
    );
  } on ProcessException catch (e) {
    throw ToolchainMissing(
      'esbuild',
      '自动安装失败:找不到 npm 可执行文件($e)。\n'
          '请手动安装 Node.js(附带 npm),或用 --esbuild / MP_FLUTTER_ESBUILD 指定一个'
          '已装好的 esbuild 可执行文件路径。',
    );
  }
  if (install.exitCode != 0) {
    throw ToolchainMissing(
      'esbuild',
      'npm install --prefix $installDir esbuild@$kEsbuildVersion 失败'
          '(退出码 ${install.exitCode})。\n'
          'stdout: ${install.stdout}\nstderr: ${install.stderr}\n'
          '可能是离线环境——请联网后重试,或手动安装 esbuild 后用 --esbuild / '
          'MP_FLUTTER_ESBUILD 指定路径。',
    );
  }
  if (!File(cachedBin).existsSync()) {
    throw ToolchainMissing(
      'esbuild',
      'npm install 报告成功,但 $cachedBin 仍不存在——esbuild 包的产物结构'
          '可能变了,需要更新这里的探测路径。',
    );
  }
  return cachedBin;
}

/// M8:esbuild 从 PATH 解析出来时(`resolveEsbuild` 返回裸命令名 `esbuild`,
/// 见其文档第 3 步),版本可能是用户自己装的、和自动安装会用的
/// [kEsbuildVersion] 不一致——语法降级(`transform/canvaskit_js.dart` 的
/// `downgradeToEs2017`)行为理论上可能因版本差异略有不同。只警告一次,不
/// 阻断构建:PATH 上的版本大概率是用户自己管理的,不该仅因为版本不同就
/// 拒绝构建;真出问题时提示里已经给了绕开方式。
///
/// [run] 仅供测试注入。探测失败(比如 `esbuild --version` 本身跑不通)不算
/// 需要警告的情况,静默跳过——不能让一个"顺手的版本提示"反过来变成构建
/// 失败的新原因。
Future<void> warnIfEsbuildVersionMismatch(
  String esbuildBin, {
  ProcessRunner run = _defaultRunner,
  void Function(String message)? warn,
}) async {
  final warnFn = warn ?? (m) => stderr.writeln(m);
  try {
    final r = await run(esbuildBin, ['--version']);
    if (r.exitCode != 0) return;
    final actual = (r.stdout as String).trim();
    if (actual.isNotEmpty && actual != kEsbuildVersion) {
      warnFn(
        '⚠️  esbuild 版本($actual)与已验证版本($kEsbuildVersion)不一致'
        '(从 PATH 解析,未固定版本)。继续构建;如遇到语法降级相关的怪问题,'
        '可用 --esbuild / MP_FLUTTER_ESBUILD 指定 $kEsbuildVersion 版本。',
      );
    }
  } catch (_) {
    /* 探测失败不阻断构建,见上文档 */
  }
}
