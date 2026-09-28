import 'dart:io';
import 'package:test/test.dart';
import 'package:mp_flutter/src/toolchain.dart';
import 'package:mp_flutter/src/transform/canvaskit_js.dart' show TransformFailure;
import 'package:mp_flutter/src/transform/split_main_dart_js.dart';

void main() {
  // `dart test` 的工作目录固定是包根(packages/mp_flutter),split.js/acorn
  // 现在随包分发在 js/ 下,包根本身就是 resolveDartSplitTool 要找的
  // packageRoot,不再需要往上跳到 monorepo 根。
  final packageRoot = Directory.current.path;

  test('resolveDartSplitTool:包目录不完整(缺 js/split.js)时抛 ToolchainMissing', () async {
    final empty = Directory.systemTemp.createTempSync('mpf_nosplit_');
    addTearDown(() => empty.deleteSync(recursive: true));
    await expectLater(
        resolveDartSplitTool(packageRoot: empty.path),
        throwsA(isA<ToolchainMissing>().having((e) => e.message, 'message', contains('js/split.js'))));
  });

  test('resolveDartSplitTool:随包分发的 js/split.js 找得到', () async {
    final tool = await resolveDartSplitTool(packageRoot: packageRoot);
    expect(File(tool).existsSync(), isTrue);
    expect(tool, endsWith('js/split.js'));
  });

  test('小源码切成 1 片,分片头部 require 共享作用域', () async {
    final chunks = await splitMainDartJs(
        '(function dartProgram(){function f(){} var A={}; A.x=1})()',
        budgetBytes: 100000, scopeRequire: '../mp-dart-scope.js',
        toolPath: await resolveDartSplitTool(packageRoot: packageRoot));
    expect(chunks, hasLength(1));
    expect(chunks.single, contains('require("../mp-dart-scope.js")'));
  });

  test('分片失败转成 TransformFailure,带出工具的诊断原文', () async {
    await expectLater(
        splitMainDartJs('var a=1;', budgetBytes: 100000, scopeRequire: 'x',
            toolPath: await resolveDartSplitTool(packageRoot: packageRoot)),
        throwsA(isA<TransformFailure>().having((e) => e.message, 'message', contains('no-iife'))));
  });

  group('checkNodeAvailable', () {
    test('node 可用且版本 ≥18 时不抛异常', () {
      expect(checkNodeAvailable, returnsNormally);
    });

    test('找不到可执行文件时抛 ToolchainMissing', () {
      expect(() => checkNodeAvailable(nodeBin: '/nonexistent/node-xyz'),
          throwsA(isA<ToolchainMissing>().having((e) => e.tool, 'tool', 'node')));
    });

    test('版本号解析不出来 / 过低时抛 ToolchainMissing(用桩脚本模拟旧版本输出)', () {
      final stub = File(
          '${Directory.systemTemp.createTempSync('mpf_oldnode_').path}/node');
      addTearDown(() => stub.parent.deleteSync(recursive: true));
      stub.writeAsStringSync('#!/bin/bash\necho "v16.20.0"\n');
      Process.runSync('chmod', ['+x', stub.path]);
      expect(
        () => checkNodeAvailable(nodeBin: stub.path),
        throwsA(isA<ToolchainMissing>()
            .having((e) => e.tool, 'tool', 'node')
            .having((e) => e.message, 'message', contains('过低'))),
      );
    });
  });
}
