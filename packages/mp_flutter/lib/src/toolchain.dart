import 'dart:io';

/// 管线依赖的外部命令行工具(brotli / esbuild)缺失或不可用。
///
/// 与 [TransformFailure]/[FlutterBuildFailure] 分开是有意的:这些不是
/// "构建/变换本身失败",而是运行环境缺东西——CLI 用专属退出码区分,方便
/// 脚本化调用判断"我该装什么"而不是去读一堆 Dart 栈猜原因。
class ToolchainMissing implements Exception {
  final String tool;
  final String hint;
  const ToolchainMissing(this.tool, this.hint);

  String get message => '缺少外部工具:$tool\n$hint';

  @override
  String toString() => 'ToolchainMissing: $message';
}

/// 预检 brotli 是否可用(I2)。
///
/// brotli 用于压缩 canvaskit.wasm(见 pipeline.dart Step 5),macOS/Linux 都不
/// 预装,是最容易踩到的首次运行失败。构建管线在 `flutter build web` **之前**
/// 调用它——不然用户要白等一次动辄几十秒到几分钟的构建,才在管线后半段发现
/// 缺工具;`doctor` 子命令也调用它作为独立检查项,提前告知。
void checkBrotliAvailable() {
  ProcessResult r;
  try {
    r = Process.runSync('brotli', ['--version']);
  } on ProcessException catch (e) {
    throw ToolchainMissing('brotli',
        '找不到 brotli 可执行文件($e)。canvaskit.wasm 压缩依赖它。\n'
        '安装:macOS `brew install brotli`;Debian/Ubuntu `apt install brotli`。');
  }
  if (r.exitCode != 0) {
    throw ToolchainMissing('brotli',
        'brotli --version 返回非零退出码(${r.exitCode}):${r.stderr}\n'
        '安装:macOS `brew install brotli`;Debian/Ubuntu `apt install brotli`。');
  }
}
