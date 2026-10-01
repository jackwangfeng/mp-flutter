'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const {
  rewriteJs, rewriteRegexSource, propertyRanges, complement, encodeJsString, UnicodePropsError,
} = require('../unicode-props');

const TOOL = path.join(__dirname, '../unicode-props.js');
const MAX_CP = 0x10ffff;

// 在全部码点上断言改写前后行为一致。wrap 把单个码点放进测试串(多字符模式用)。
function assertEquivalent(src, flags = 'u', wrap = (ch) => ch) {
  const { source } = rewriteRegexSource(src);
  assert.ok(!/\\[pP]\{/.test(source), `改写后不应再有属性转义:${source.slice(0, 80)}`);
  const a = new RegExp(src, flags);
  const b = new RegExp(source, flags);
  for (let cp = 0; cp <= MAX_CP; cp++) {
    const s = wrap(String.fromCodePoint(cp));
    if (a.test(s) !== b.test(s)) {
      assert.fail(`/${src}/${flags} 在 U+${cp.toString(16).toUpperCase()} 上不一致`);
    }
  }
  return source;
}

test('字符类外:\\p{X} 包成 [区间],码点用 \\u{…}', () => {
  const out = assertEquivalent('\\p{Space_Separator}');
  assert.strictEqual(out, '[\\u{20}\\u{A0}\\u{1680}\\u{2000}-\\u{200A}\\u{202F}\\u{205F}\\u{3000}]');
});

test('字符类内:\\p{X} 展开成不带外层方括号的区间', () => {
  const out = assertEquivalent('[\\p{Space_Separator}x]');
  assert.ok(out.startsWith('[\\u{20}\\u{A0}'), out);
  assert.ok(out.endsWith('\\u{3000}x]'), out);
  assert.strictEqual(out.split('[').length - 1, 1, '只有原来那一对方括号');
});

test('\\P:字符类外用 [^…],字符类内展开成补集区间,否定字符类里也成立', () => {
  assert.ok(assertEquivalent('\\P{Letter}').startsWith('[^'));
  const inClass = assertEquivalent('[\\P{Letter}]');
  assert.ok(inClass.startsWith('[\\u{0}-'), inClass.slice(0, 40));
  assertEquivalent('[^\\P{Nd}]');
  assertEquivalent('[^\\p{Nd}_]');
});

test('多个属性,含 Script= / General_Category= / Script_Extensions= 写法', () => {
  const r = rewriteRegexSource('\\p{Script=Han}[\\p{General_Category=Lu}\\P{gc=Nd}]\\p{Script_Extensions=Latin}');
  assert.deepStrictEqual(r.properties, ['Script=Han', 'General_Category=Lu', 'gc=Nd', 'Script_Extensions=Latin']);
  assertEquivalent('[\\p{Script=Han}\\p{General_Category=Lu}]');
  assertEquivalent('a\\p{Script=Greek}b', 'u', (ch) => 'a' + ch + 'b');
});

test('转义的方括号不影响字符类状态;\\\\p{ 是字面反斜杠不改写', () => {
  // \[ 不开字符类:\p 仍在字符类外,要包 [...]
  const out = assertEquivalent('\\[\\p{Nd}\\]', 'u', (ch) => '[' + ch + ']');
  assert.ok(out.startsWith('\\[[\\u{30}-\\u{39}'), out.slice(0, 40));
  // 字符类里的 \] 不关字符类:\p 仍在字符类内,不包方括号
  const inner = assertEquivalent('[\\]\\p{Nd}]');
  assert.ok(inner.startsWith('[\\]\\u{30}-\\u{39}'), inner.slice(0, 40));
  assertEquivalent('[\\[\\p{Nd}]\\p{Lu}');
  // 字面反斜杠 + p{L}:原样保留
  assert.strictEqual(rewriteRegexSource('\\\\p{L}').source, '\\\\p{L}');
  // 形状不像属性名的不动
  assert.strictEqual(rewriteRegexSource('\\p{not a prop}').source, '\\p{not a prop}');
});

test('大小写不敏感(iu)下改写前后同样一致', () => {
  assertEquivalent('\\p{Lu}', 'iu');
  assertEquivalent('[\\P{Ll}]', 'iu');
});

test('text_painter 两处模式:dart2js 产物里的字符串常量被真实还原', () => {
  // 与 dart2js 产物同形(源码里是 \\p{…})
  const code = 's($,"aKK","avZ",()=>A.hz("[\\\\p{Space_Separator}\\\\p{Punctuation}]",!0,!0))\n' +
               's($,"aL5","awb",()=>A.hz("\\\\p{Space_Separator}",!0,!0))\n';
  const r = rewriteJs(code);
  assert.strictEqual(r.rewrites, 2);
  assert.deepStrictEqual(r.properties, ['Punctuation', 'Space_Separator']);
  assert.ok(!/\\\\[pP]\{/.test(r.code));
  const got = [];
  vm.runInNewContext(r.code, { s: (a, b, c, f) => f(), $: 0, A: { hz: (src) => got.push(src) } });
  assert.strictEqual(got.length, 2);
  for (const [orig, now] of [['[\\p{Space_Separator}\\p{Punctuation}]', got[0]], ['\\p{Space_Separator}', got[1]]]) {
    assert.strictEqual(now, rewriteRegexSource(orig).source);
    const a = new RegExp(orig, 'u');
    const b = new RegExp(now, 'u');
    for (let cp = 0; cp <= MAX_CP; cp++) {
      const ch = String.fromCodePoint(cp);
      if (a.test(ch) !== b.test(ch)) assert.fail(`${orig} 在 U+${cp.toString(16)} 上不一致`);
    }
  }
});

test('单引号字符串、正则字面量也改写;无关字符串与无属性转义的源码原样返回', () => {
  const r = rewriteJs("var a='\\\\p{Nd}+', b=/[\\p{Lu}]x/u, c=\"\\\\d{2}\", d=1/2/3;");
  assert.strictEqual(r.rewrites, 2);
  const ctx = {};
  vm.runInNewContext(r.code, ctx);
  assert.strictEqual(ctx.a, '[\\u{30}-\\u{39}' + ctx.a.slice('[\\u{30}-\\u{39}'.length));
  assert.ok(!/\\p\{/.test(ctx.a));
  assert.strictEqual(ctx.b.flags, 'u');
  assert.ok(ctx.b.test('Äx') && !ctx.b.test('äx'));
  assert.strictEqual(ctx.c, '\\d{2}');
  const plain = 'var x = "abc";';
  assert.strictEqual(rewriteJs(plain).code, plain);
});

test('encodeJsString:按原引号转义,往返一致', () => {
  for (const v of ['a"b\'c\\d\n \ud800', '\\u{20}-\\u{7E}']) {
    for (const q of ['"', "'"]) assert.strictEqual(vm.runInNewContext(encodeJsString(v, q)), v);
  }
});

test('同一个属性名只算一次(缓存);补集覆盖全部码点', () => {
  assert.strictEqual(propertyRanges('Nd'), propertyRanges('Nd'));
  const c = complement([[0, 9], [20, MAX_CP - 1]]);
  assert.deepStrictEqual(c, [[10, 19], [MAX_CP, MAX_CP]]);
});

test('Node 也不认识的属性名:具名错误 unknown-property', () => {
  assert.throws(() => rewriteRegexSource('\\p{No_Such_Property}'),
    (e) => e instanceof UnicodePropsError && e.code === 'unknown-property' && /No_Such_Property/.test(e.message));
});

test('CLI:成功输出 JSON 计数;未知属性退出码 2 且 stderr 带错误码', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicode-props-'));
  const inF = path.join(dir, 'in.js');
  const outF = path.join(dir, 'out.js');
  fs.writeFileSync(inF, 'x("\\\\p{Space_Separator}");');
  const ok = spawnSync(process.execPath, [TOOL, '--in', inF, '--out', outF], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.deepStrictEqual(JSON.parse(ok.stdout), { rewrites: 1, properties: ['Space_Separator'] });
  assert.ok(!fs.readFileSync(outF, 'utf8').includes('p{'));
  fs.writeFileSync(inF, 'x("\\\\p{Bogus_Prop}");');
  const bad = spawnSync(process.execPath, [TOOL, '--in', inF, '--out', outF], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /\[unicode-props\] unknown-property: .*Bogus_Prop/);
});
