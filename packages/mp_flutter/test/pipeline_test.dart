import 'package:test/test.dart';
import 'package:flutter_miniprogram/src/pipeline.dart';

void main() {
  // resolveEsbuildPath 已在 Phase 6 拆分/替换为 esbuild_resolver.dart 的
  // resolveEsbuild(见 esbuild_resolver_test.dart),这里只保留和 pipeline.dart
  // 直接相关的部分(ToolchainMissing 仍从这里 export)。
  test('ToolchainMissing 的消息同时带出工具名与安装指引', () {
    const e = ToolchainMissing('brotli', 'brew install brotli');
    expect(e.message, allOf(contains('brotli'), contains('brew install')));
  });
}
