import 'dart:io';

import '../toolchain.dart';

/// 构建期补丁失配。
///
/// 必须抛出而不是静默产出缺补丁的文件——用户只会看到运行时 GL 句柄为 0
/// 的黑屏,那是极难倒查的。
class TransformFailure implements Exception {
  final String patch;
  final String hint;

  /// 打补丁的产物文件名(报错点名用)。
  final String file;
  const TransformFailure(this.patch, this.hint, {this.file = 'canvaskit.js'});

  String get message =>
      '$file 构建期补丁失配:$patch\n'
      '$hint\n'
      '上游${file == 'canvaskit.js' ? ' CanvasKit' : ' Flutter 引擎'}可能改了结构。请跑 tools/e2e 回归并更新变换规则。';

  @override
  String toString() => 'TransformFailure: $message';
}

/// emscripten 的 Safari WebGL2 workaround。
///
/// 用结构化正则匹配,不绑死 minify 后的变量名:
/// ```
/// <obj>.<flag>||(<obj>.<flag>=<obj>.getContext,<obj>.getContext=function(..){..
/// instanceof WebGLRenderingContext..});
/// ```
final _safariWorkaround = RegExp(
  r'(\w+)\.(\w+)\|\|\(\1\.\2=\1\.getContext,\1\.getContext=function\([^)]*\)\{'
  r'[^{}]*instanceof WebGLRenderingContext[^{}]*\}\);',
);

/// 把上游的 canvaskit.js 变换成小程序可 require 的 CommonJS 模块。
String transformCanvasKitJs(String source) {
  var out = source;

  // ① ESM → CJS。小程序不支持 import.meta,且它是语法错误(不是运行时错误),
  //    即使那段分支永不执行也必须消掉。
  out = out.replaceAll(
    'var _scriptName = import.meta.url;',
    'var _scriptName = "";',
  );
  out = out.replaceAll(
    RegExp(r'\(new URL\("canvaskit\.wasm",\s*import\.meta\.url\)\)\.href'),
    '"canvaskit.wasm"',
  );
  if (out.contains('import.meta')) {
    throw const TransformFailure(
      'import.meta 未能全部消除',
      '出现了新的 import.meta 用法,需补充替换规则。',
    );
  }

  out = out.replaceFirst(
    RegExp(r'export default CanvasKitInit;\s*$'),
    'module.exports = CanvasKitInit;\n',
  );
  if (!out.contains('module.exports = CanvasKitInit;')) {
    throw const TransformFailure(
      'export default → module.exports 失败',
      '上游可能改了导出形式(检查文件末尾)。',
    );
  }

  // ② 摘掉 Safari workaround,保留 He 赋值让 emscripten 跳过包装。
  //
  // 重要性等级:必须摘,不是可选优化。原因分两层:
  //   1. 模拟器里能观察到的现象:小程序视图层 canvas 与逻辑层不是同一个
  //      realm,跨 realm `instanceof` 恒为 false,于是包装后的 getContext
  //      永远返回 null,GL 句柄恒为 0(黑屏)。
  //   2. 真机实测发现的更严重事实:真机 iOS 上根本没有 `WebGLRenderingContext`
  //      这个全局变量——那行代码在真机上是 **ReferenceError**,不是"返回
  //      false"那么温和。也就是说不摘掉它,真机上直接白屏崩溃,连模拟器
  //      里能看到的"黑屏但不崩"都不如。
  if (out.contains('instanceof WebGLRenderingContext')) {
    final m = _safariWorkaround.firstMatch(out);
    if (m == null) {
      throw const TransformFailure(
        'Safari WebGL2 workaround 结构不匹配',
        '仍存在 `instanceof WebGLRenderingContext`,但包装函数结构已变。'
            '不摘掉它,模拟器里 GL 句柄恒为 0(跨 realm instanceof 恒 false),'
            '真机 iOS 上更严重,会因为全局没有 WebGLRenderingContext 而 ReferenceError。',
      );
    }
    out = out.replaceFirstMapped(
      _safariWorkaround,
      (m) => '${m[1]}.${m[2]}||(${m[1]}.${m[2]}=${m[1]}.getContext);',
    );
  }

  return out;
}

/// ES2021+ 语法降级到 es2017。
///
/// 上游 canvaskit.js(以及 dart2js 产物)里含有 `||=`/`&&=`/`??=`/`?.`/`??`
/// 等 ES2021+ 写法。这些**全部来自上游**,不是本文件两处补丁引入的。
///
/// 为什么必须降级:微信开发者工具的**模拟器**不走这条语法检查,但**预览/
/// 上传时的上传校验器**会直接因为一个 `Unexpected token =`(比如
/// `q||={...}`)拒绝整个文件。开发者工具里把 `es6: true` 打开能让 babel
/// 顺手转掉这些语法,但 babel 同时会去转那个 0.93MB 的 dart2js 产物,是
/// 已知有风险的操作。正解是我们自己在构建期精确降级 canvaskit.js,让
/// babel 完全不需要介入(`es6: false`)。
///
/// 必须在前两处补丁(ESM→CJS、摘 Safari workaround)**之后**执行:esbuild
/// 的语法降级不会破坏已经打好的补丁,但顺序反了会让摘 workaround 的正则
/// 去匹配 esbuild 重写过的、结构不同的代码,徒增失配风险。
///
/// 需要外部工具 esbuild(纯 Dart 做不了语法降级)。[esbuildPath] 默认从
/// PATH 里找 `esbuild`;生产管线不能依赖 spike 目录下的那份,调用方应传入
/// 项目自己安装的 esbuild 路径。找不到时显式抛 [ToolchainMissing] 并给出
/// 安装指引——静默跳过的后果是用户拿到一个传不上微信的产物,而报错会指向
/// 完全无关的地方(上传校验器里一个语法错误行号,没人会想到是这里漏跑了
/// 一步)。
Future<String> downgradeToEs2017(
  String source, {
  String esbuildPath = 'esbuild',
}) async {
  final tempDir = await Directory.systemTemp.createTemp(
    'mp_flutter_canvaskit_esbuild_',
  );
  try {
    final inFile = File('${tempDir.path}/in.js');
    final outFile = File('${tempDir.path}/out.js');
    await inFile.writeAsString(source);

    ProcessResult result;
    try {
      result = await Process.run(esbuildPath, [
        inFile.path,
        '--target=es2017',
        '--format=cjs',
        '--platform=neutral',
        '--outfile=${outFile.path}',
      ]);
    } on ProcessException catch (e) {
      throw ToolchainMissing(
        'esbuild(esbuildPath="$esbuildPath")',
        '找不到 esbuild 可执行文件($e)。\n'
            '不做语法降级,微信上传校验器会因为 `||=`/`&&=`/`??=`/`?.`/`??` 等 '
            'ES2021+ 写法直接拒绝这个文件(报错形如 `SyntaxError: Unexpected '
            'token =`)。\n'
            '安装方式:`npm install -g esbuild`,或在项目里 `npm install esbuild` '
            '后把 node_modules/.bin/esbuild 的绝对路径传给 esbuildPath 参数。',
      );
    }

    if (result.exitCode != 0) {
      throw TransformFailure(
        'esbuild 降级失败(退出码 ${result.exitCode})',
        'stderr: ${result.stderr}\nstdout: ${result.stdout}',
      );
    }

    final out = await outFile.readAsString();

    for (final token in ['||=', '&&=', '??=', '?.', '??']) {
      if (out.contains(token)) {
        throw TransformFailure(
          '语法降级后仍残留 "$token"',
          'esbuild --target=es2017 应当已消除该写法;若仍出现,说明 esbuild '
              '版本、参数或输入有问题。微信上传校验器会因为残留的 $token 拒绝'
              '这个文件,报错通常是一个和这里毫无关系的行号。'
              '\n'
              '已知局限(针对 `?.` 检查):此检查是朴素的子串匹配,在 minify 后的代码里'
              '可能误报,例如三元表达式 `c ? .5 : 1` 被识别为 `c?.5`。'
              '这是安全失败(误报会抛出异常,不会产出坏文件);如遇到,请确认输出内容。',
        );
      }
    }

    if (!out.contains('module.exports')) {
      throw const TransformFailure(
        '语法降级破坏了 module.exports',
        'esbuild 的 --format=cjs 不应该改变已有的 CommonJS 导出,但降级后 '
            'module.exports 不见了,需要检查 esbuild 版本或参数变化。',
      );
    }

    if (out.contains('instanceof WebGLRenderingContext')) {
      throw const TransformFailure(
        '语法降级后 Safari workaround 复现',
        '不应该发生——说明降级步骤跑在了摘 workaround 之前,或者输入本身'
            '没有先摘掉 workaround。降级必须在 transformCanvasKitJs 之后执行。',
      );
    }

    return out;
  } finally {
    await tempDir.delete(recursive: true);
  }
}
