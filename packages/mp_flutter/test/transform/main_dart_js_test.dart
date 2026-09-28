import 'package:test/test.dart';
import 'package:mp_flutter/src/transform/main_dart_js.dart';
import 'package:mp_flutter/src/transform/canvaskit_js.dart' show TransformFailure;

const _fixture = '''
(function dartProgram(){
var v={G:typeof self!="undefined"?self:this};
if(typeof document==="undefined"){a(null)}
self._flutter.loader.didCreateEngineInitializer(x);
})();
''';

void main() {
  test('preamble 出现在原始代码之前', () {
    final out = injectPreamble(_fixture);
    expect(out.indexOf('var __mp = require'), lessThan(out.indexOf('dartProgram')));
  });

  test('遮蔽了引擎会用到的全部浏览器全局', () {
    final out = injectPreamble(_fixture);
    for (final name in ['window', 'document', 'navigator', 'self', 'location']) {
      expect(out, contains(RegExp('\\b$name = __mp\\.')),
          reason: '$name 未被模块级 var 遮蔽');
    }
  });

  // K4:dart:math 的 Random.secure().nextInt() 编译出裸标识符
  // `crypto.getRandomValues(...)`(不像 self.crypto 那样限定作用域),必须靠
  // 模块级 var 遮蔽才能落到 bom-shim 装好的对象上,否则解析到宿主环境本就
  // 没有的全局 crypto,直接 TypeError(2026-09-28 E2E 实测踩到)。
  test('crypto 也被模块级 var 遮蔽(裸标识符引用,读 __mp.self.crypto)', () {
    final out = injectPreamble(_fixture);
    expect(out, contains(RegExp('\\bcrypto = __mp\\.self\\.crypto\\b')),
        reason: 'crypto 未被模块级 var 遮蔽');
  });

  test('原始代码一字不改地保留', () {
    final out = injectPreamble(_fixture);
    expect(out.endsWith(_fixture), isTrue);
  });

  test('shim 路径可配置', () {
    final out = injectPreamble(_fixture, shimPath: '../runtime/bom-shim.js');
    expect(out, contains("require('../runtime/bom-shim.js')"));
  });

  test('已经注入过的文件再次注入 → 抛出,避免重复 preamble', () {
    final once = injectPreamble(_fixture);
    expect(() => injectPreamble(once), throwsA(isA<TransformFailure>()));
  });
}
