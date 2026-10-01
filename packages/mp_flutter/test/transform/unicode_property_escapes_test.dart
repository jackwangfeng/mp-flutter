import 'dart:io';
import 'package:test/test.dart';
import 'package:flutter_miniprogram/src/toolchain.dart';
import 'package:flutter_miniprogram/src/transform/canvaskit_js.dart' show TransformFailure;
import 'package:flutter_miniprogram/src/transform/unicode_property_escapes.dart';

void main() {
  final packageRoot = Directory.current.path;

  test('resolveUnicodePropsTool:随包分发的 js/unicode-props.js 找得到;缺失时 ToolchainMissing', () async {
    expect(await resolveUnicodePropsTool(packageRoot: packageRoot), endsWith('js/unicode-props.js'));
    final empty = Directory.systemTemp.createTempSync('mpf_noprops_');
    addTearDown(() => empty.deleteSync(recursive: true));
    await expectLater(resolveUnicodePropsTool(packageRoot: empty.path),
        throwsA(isA<ToolchainMissing>().having((e) => e.message, 'message', contains('unicode-props.js'))));
  });

  test('没有属性转义:原样返回,不启动 Node', () async {
    const src = 'A.hz("\\\\d+",!0,!0)';
    expect(await rewriteUnicodePropertyEscapes(src, toolPath: '/nonexistent/tool.js'), src);
  });

  test('text_painter 两处模式改写成码点区间,产物里不再有 \\p{', () async {
    const src = 's(\$,"aKK","avZ",()=>A.hz("[\\\\p{Space_Separator}\\\\p{Punctuation}]",!0,!0))\n'
        's(\$,"aL5","awb",()=>A.hz("\\\\p{Space_Separator}",!0,!0))\n';
    int? count;
    List<String>? props;
    final out = await rewriteUnicodePropertyEscapes(src,
        toolPath: await resolveUnicodePropsTool(packageRoot: packageRoot),
        onRewritten: (n, p) { count = n; props = p; });
    expect(count, 2);
    expect(props, ['Punctuation', 'Space_Separator']);
    expect(out, isNot(contains('p{')));
    expect(out, contains(r'A.hz("[\\u{20}\\u{A0}\\u{1680}\\u{2000}-\\u{200A}\\u{202F}\\u{205F}\\u{3000}]",!0,!0)'));
    expect(out, contains(r'A.hz("[\\u{20}\\u{A0}\\u{1680}\\u{2000}-\\u{200A}\\u{202F}\\u{205F}\\u{3000}\\u{21}-'));
  });

  test('Node 也不认识的属性名:TransformFailure 带出具名错误码', () async {
    await expectLater(
        rewriteUnicodePropertyEscapes('x("\\\\p{Bogus_Prop}")',
            toolPath: await resolveUnicodePropsTool(packageRoot: packageRoot)),
        throwsA(isA<TransformFailure>()
            .having((e) => e.message, 'message', allOf(contains('unknown-property'), contains('Bogus_Prop')))));
  });
}
