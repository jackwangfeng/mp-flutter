import 'dart:io';

import 'package:test/test.dart';
import 'package:mp_flutter/src/esbuild_resolver.dart';
import 'package:mp_flutter/src/toolchain.dart';
import 'package:mp_flutter/src/transform/canvaskit_js.dart';

/// 真实 canvaskit.js 的最小骨架,保留三个补丁点的确切形状。
const _fixture = '''
var CanvasKitInit = (() => {
  var _scriptName = import.meta.url;
  return (
function(moduleArg = {}) {
var r=moduleArg;
na=(a,b)=>{a.He||(a.He=a.getContext,a.getContext=function(e,f){f=a.He(e,f);return"webgl"==e==f instanceof WebGLRenderingContext?f:null});var c=1<b.majorVersion?a.getContext("webgl2",b):a.getContext("webgl",b);return c?ad(c,b):0};
Ra??=r.locateFile?"canvaskit.wasm":(new URL("canvaskit.wasm",import.meta.url)).href;
return moduleRtn;
}
);
})();
export default CanvasKitInit;
''';

void main() {
  test('去掉所有 import.meta(小程序不支持)', () {
    final out = transformCanvasKitJs(_fixture);
    expect(out, isNot(contains('import.meta')));
  });

  test('ESM export 转成 CommonJS', () {
    final out = transformCanvasKitJs(_fixture);
    expect(out, isNot(contains('export default')));
    expect(out, contains('module.exports = CanvasKitInit;'));
  });

  test('摘掉 Safari workaround,但保留 He 赋值', () {
    final out = transformCanvasKitJs(_fixture);
    expect(out, isNot(contains('instanceof WebGLRenderingContext')));
    expect(out, contains('a.He||(a.He=a.getContext);'));
    // getContext 调用本身必须原样保留
    expect(out, contains('a.getContext("webgl",b)'));
  });

  test('不依赖 minify 后的具体变量名', () {
    // 换一套变量名,变换仍须成功
    final renamed = _fixture
        .replaceAll('a.He', 'q.Zz')
        .replaceAll('a.getContext', 'q.getContext')
        .replaceAll('(a,b)=>{q.Zz', '(q,b)=>{q.Zz');
    final out = transformCanvasKitJs(renamed);
    expect(out, isNot(contains('instanceof WebGLRenderingContext')));
    expect(out, contains('q.Zz||(q.Zz=q.getContext);'));
  });

  test('instantiateWasm 钩子必须原样保留', () {
    const withHook = 'var x=1; if(r.instantiateWasm)try{return r.instantiateWasm(b,a)}catch(c){} '
        'export default CanvasKitInit;';
    final out = transformCanvasKitJs(withHook);
    expect(out, contains('r.instantiateWasm(b,a)'));
  });

  group('上游结构变化时必须显式失败,不能静默产出坏文件', () {
    test('Safari workaround 结构变了 → 抛 TransformFailure', () {
      // instanceof 还在,但包装函数换了形状(正则匹配不上)
      const changed = '''
na=(a,b)=>{ a.setupCtx(function(e,f){ return f instanceof WebGLRenderingContext ? f : null }); };
export default CanvasKitInit;
''';
      expect(
        () => transformCanvasKitJs(changed),
        throwsA(isA<TransformFailure>()
            .having((e) => e.patch, 'patch', contains('Safari'))
            .having((e) => e.message, 'message', contains('GL 句柄恒为 0'))),
      );
    });

    test('出现新的 import.meta 用法 → 抛 TransformFailure', () {
      const changed = 'var u = import.meta.resolve("x"); export default CanvasKitInit;';
      expect(
        () => transformCanvasKitJs(changed),
        throwsA(isA<TransformFailure>()
            .having((e) => e.patch, 'patch', contains('import.meta'))),
      );
    });

    test('导出形式变了 → 抛 TransformFailure', () {
      const changed = 'var x=1; export { CanvasKitInit };';
      expect(
        () => transformCanvasKitJs(changed),
        throwsA(isA<TransformFailure>()
            .having((e) => e.patch, 'patch', contains('module.exports'))),
      );
    });
  });

  group('语法降级到 es2017(真机上传校验器不认 ES2021+ 写法)', () {
    // 用真实的 resolveEsbuild(PATH / ~/.mp_flutter 缓存 / 自动安装)解析出
    // 一份真实 esbuild 二进制,供测试直接调用(不 mock——降级这一步的正确性
    // 只有跑真实 esbuild 才能验证)。
    // 用真实 resolveEsbuild 解析一份 esbuild;解析失败(离线且无缓存)时不让
    // setUpAll 直接炸掉整组——第一条测试自己检查 _esbuildError 并显式失败/跳过,
    // 其余测试(用桩脚本模拟坏 esbuild)不依赖这份真实二进制。
    late final String? _esbuildPath;
    late final Object? _esbuildError;

    setUpAll(() async {
      try {
        // 单测不触网:只探测 PATH / 缓存,拒绝自动 npm install(拿不到就显式失败)。
        _esbuildPath = await resolveEsbuild(
          run: (exe, args, {environment, includeParentEnvironment = true}) {
            if (exe.startsWith('npm')) {
              throw StateError('单测禁止自动安装 esbuild;请先 npm i -g esbuild 或设 MP_FLUTTER_ESBUILD');
            }
            return Process.run(exe, args,
                environment: environment,
                includeParentEnvironment: includeParentEnvironment);
          },
        );
        _esbuildError = null;
      } catch (e) {
        _esbuildPath = null;
        _esbuildError = e;
      }
    });

    test('含 ||= / &&= / ??= / ?. / ?? 的输入,降级后残留为 0 且补丁完好', () async {
      // 先看是否显式要求跳过
      if (Platform.environment['MP_FLUTTER_SKIP_ESBUILD_TESTS'] == '1') {
        markTestSkipped('MP_FLUTTER_SKIP_ESBUILD_TESTS=1,显式跳过 esbuild 相关测试');
        return;
      }
      if (_esbuildPath == null) {
        throw StateError('resolveEsbuild() 失败,无法拿到真实 esbuild 二进制:$_esbuildError');
      }
      const patched = '''
var q; q||={a:1}; var z = q?.a ?? 2; z &&= 3;
a.He||(a.He=a.getContext);
module.exports = CanvasKitInit;
''';
      final out =
          await downgradeToEs2017(patched, esbuildPath: _esbuildPath!);
      for (final token in ['||=', '&&=', '??=', '?.', '??']) {
        expect(out, isNot(contains(token)), reason: '残留 token: $token');
      }
      expect(out, contains('module.exports'));
      expect(out, contains('a.He'));
      expect(out, contains('a.getContext'));
      expect(out, isNot(contains('instanceof WebGLRenderingContext')));
    });

    test('esbuild 输出缺 module.exports 时抛 TransformFailure', () async {
      // 用临时的 shell 脚本桩模拟坏的 esbuild,输出不含 module.exports 的 JS
      final tempDir = await Directory.systemTemp.createTemp('mp_flutter_stub_');
      addTearDown(() => tempDir.delete(recursive: true));

      final stubScript = File('${tempDir.path}/esbuild');
      await stubScript.writeAsString('''#!/bin/bash
# 模拟 esbuild,输出一段不含 module.exports 的 JS
outfile=""
for arg in "\$@"; do
  if [[ \$arg == --outfile=* ]]; then
    outfile="\${arg#--outfile=}"
    break
  fi
done
if [ -n "\$outfile" ]; then
  echo "var x = 1; var y = 2;" > "\$outfile"
fi
''');
      await Process.run('chmod', ['+x', stubScript.path]);

      expect(
        () => downgradeToEs2017('var x = 1;', esbuildPath: stubScript.path),
        throwsA(isA<TransformFailure>()
            .having((e) => e.patch, 'patch', contains('module.exports'))),
      );
    });

    test('esbuild 输出复现 instanceof WebGLRenderingContext 时抛 TransformFailure',
        () async {
      // 用临时的 shell 脚本桩模拟坏的 esbuild,输出含有 instanceof WebGLRenderingContext 的 JS
      final tempDir = await Directory.systemTemp.createTemp('mp_flutter_stub_');
      addTearDown(() => tempDir.delete(recursive: true));

      final stubScript = File('${tempDir.path}/esbuild');
      await stubScript.writeAsString('''#!/bin/bash
# 模拟 esbuild,输出一段含有 instanceof WebGLRenderingContext 的 JS
outfile=""
for arg in "\$@"; do
  if [[ \$arg == --outfile=* ]]; then
    outfile="\${arg#--outfile=}"
    break
  fi
done
if [ -n "\$outfile" ]; then
  echo "var x = 1 instanceof WebGLRenderingContext; module.exports = x;" > "\$outfile"
fi
''');
      await Process.run('chmod', ['+x', stubScript.path]);

      expect(
        () => downgradeToEs2017('var x = 1;', esbuildPath: stubScript.path),
        throwsA(isA<TransformFailure>()
            .having((e) => e.patch, 'patch', contains('Safari workaround'))),
      );
    });

    test('esbuild 不存在时抛出可诊断的错误(含安装指引)', () async {
      expect(
        () => downgradeToEs2017(
          'var x=1; module.exports = x;',
          esbuildPath: '/nonexistent/path/to/esbuild-xyz',
        ),
        throwsA(isA<ToolchainMissing>()
            .having((e) => e.tool, 'tool', contains('esbuild'))
            .having((e) => e.message, 'message', contains('npm install'))),
      );
    });
  });
}
