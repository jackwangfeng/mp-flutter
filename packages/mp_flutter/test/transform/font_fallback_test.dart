import 'dart:io';

import 'package:mp_flutter/src/transform/canvaskit_js.dart' show TransformFailure;
import 'package:mp_flutter/src/transform/font_fallback.dart';
import 'package:test/test.dart';

// 3.41.9 dart2js 压缩产物里的原样片段(真实业务构建产物)
const _minified = r'''
b65(a){return B.d.bx(a.a,"Noto Sans KR")},
aZM(a,b){var s=t.S,r=v.G.window.navigator.language,q=A.d0(null,t.H),p=A.b(["Roboto"],t.s)
s=new A.a8S(a,A.aR(s),A.aR(s),b,r,B.b.a4U(b,new A.a8T()),q,p,A.aR(s))
p=t.Te
s.b=new A.Wn(s,A.aR(p),A.n(t.N,p))
return s},
A.a8S.prototype={
atP(a,b){var s,r,q,p,o,n,m=this
if($.io==null)$.io=B.de
s=A.aR(t.S)
for(r=new A.akq(a),q=m.d,p=m.c;r.n();){o=r.d
if(!(o<160||q.t(0,o)||p.t(0,o)))s.I(0,o)}if(s.a===0)return
n=A.M(s,s.$ti.c)
if(m.a.a3D(n,b).length!==0)m.aqk(n)},
aqk(a){var s=this
''';

// --profile(不压缩)时的写法
const _profile = r'''
    FontFallbackManager$_(_registry, _fallbackFonts) {
      var t1 = type$.int,
        t2 = A._asString(A._asJSObject(A._asJSObject(init.G.window).navigator).language),
        t3 = A.Future_Future$value(null, type$.void),
        t4 = A._setArrayType(["Roboto"], type$.JSArray_String);
      t1 = new A.FontFallbackManager(_registry, A.LinkedHashSet_LinkedHashSet$_empty(t1), t2, t3, t4);
    },
    ensureFontsSupportText$2(text, fontFamilies) {
      var runesToCheck, t1, t2, t3, rune, codePoints, _this = this;
      for (t1 = new A.RuneIterator(text), t2 = _this._knownCoveredCodePoints, t3 = _this._codePointsWithNoKnownFont; t1.moveNext$0();) {
        rune = t1._currentCodePoint;
        if (!(rune < 160 || t2.contains$1(0, rune) || t3.contains$1(0, rune)))
          runesToCheck.add$1(0, rune);
      }
      if (runesToCheck._collection$_length === 0)
        return;
      codePoints = A.List_List$_of(runesToCheck, runesToCheck.$ti._precomputed1);
      if (_this._registry.getMissingCodePoints$2(codePoints, fontFamilies).length !== 0)
        _this.addMissingCodePoints$1(codePoints);
    },
''';

void main() {
  test('压缩产物:回退表初值加上合一字体;缺字检测算上它且只把缺的码点交给贪心', () {
    final out = patchFontFallback(_minified, family: 'MpNotoSansSC');
    expect(out, contains('p=A.b(["Roboto","MpNotoSansSC"],t.s)'));
    expect(out, contains('{if(b.indexOf("MpNotoSansSC")<0)b.push("MpNotoSansSC");'
        'var __mpMiss=m.a.a3D(n,b);if(__mpMiss.length!==0)m.aqk(__mpMiss)}},'));
    expect(out, isNot(contains('m.aqk(n)')));
  });

  test('--profile 产物同样认得', () {
    final out = patchFontFallback(_profile, family: 'MpNotoSansSC');
    expect(out, contains('A._setArrayType(["Roboto","MpNotoSansSC"], type\$.JSArray_String)'));
    expect(out, contains('{if(fontFamilies.indexOf("MpNotoSansSC")<0)fontFamilies.push("MpNotoSansSC");'
        'var __mpMiss=_this._registry.getMissingCodePoints\$2(codePoints,fontFamilies);'
        'if(__mpMiss.length!==0)_this.addMissingCodePoints\$1(__mpMiss)};'));
  });

  test('补丁后的片段语义:只有真正缺的码点进入贪心', () async {
    final out = patchFontFallback(_minified, family: 'F');
    final start = out.indexOf('atP(a,b){');
    final end = out.indexOf('aqk(a){');
    final method = out.substring(start, end).replaceFirst(RegExp(r'\},\s*$'), '}');
    // 用最小桩跑一遍 atP:getMissingCodePoints 只认 family "F" 覆盖 20013(中)
    final js = '''
var \$ = {}, B = {de: 1}, t = {S: 0};
var A = {
  aR: () => { const s = new Set(); return { t: (_, x) => s.has(x), I: (_, x) => s.add(x), get a() { return s.size; }, \$ti: {c: 0}, s }; },
  akq: function (str) { const it = Array.from(str).map((c) => c.codePointAt(0)); let i = -1; this.n = () => ++i < it.length; Object.defineProperty(this, 'd', { get: () => it[i] }); },
  M: (s) => Array.from(s.s),
};
const self = {
  d: A.aR(), c: A.aR(),
  a: { a3D: (cps, fams) => cps.filter((c) => !(fams.includes('F') && c === 20013)) },
  aqk: (cps) => console.log(JSON.stringify(cps)),
  $method
};
self.atP('a中文', ['Roboto']);
self.atP('中', ['Roboto']);
''';
    final dir = Directory.systemTemp.createTempSync('mpf_ff_');
    addTearDown(() => dir.deleteSync(recursive: true));
    final f = File('${dir.path}/t.js')..writeAsStringSync(js);
    final r = await Process.run('node', [f.path]);
    expect(r.stderr.toString(), isEmpty);
    // '中' 被 F 覆盖:第一段只把 '文'(25991)交给贪心;第二段整段覆盖,不触发
    expect(r.stdout.toString().trim(), '[25991]');
  });

  test('失配时点名是哪一处补丁,不静默产出', () {
    expect(() => patchFontFallback('var x = 1;', family: 'F'),
        throwsA(isA<TransformFailure>().having((e) => e.message, 'message', contains('补丁 A'))));
    final noB = _minified.replaceFirst('if(m.a.a3D(n,b).length!==0)m.aqk(n)', 'm.aqk(n)');
    expect(() => patchFontFallback(noB, family: 'F'),
        throwsA(isA<TransformFailure>().having((e) => e.message, 'message', contains('补丁 B'))));
    // 出现两处也要拒绝(说明结构变了,不能猜改哪处)
    expect(() => patchFontFallback(_minified + _minified, family: 'F'), throwsA(isA<TransformFailure>()));
  });
}
