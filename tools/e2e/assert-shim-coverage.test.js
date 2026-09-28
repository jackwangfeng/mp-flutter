const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { assertShimCoverage } = require('./assert-shim-coverage');

const BASE = path.join(__dirname, 'baseline/shim-report.json');

test('只触达基线内的 API → 通过', () => {
  const r = assertShimCoverage(
    ['1× window.Window →undefined', '2× canvas<el>.He →undefined'], BASE);
  assert.strictEqual(r.ok, true);
});

test('触达基线外的 API → 失败,并列出新增项', () => {
  const r = assertShimCoverage(
    ['1× window.Window →undefined', '1× window.brandNewApi →undefined'], BASE);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.novel, ['window.brandNewApi']);
  assert.match(r.message, /静默黑屏/);
});

test('非 undefined 的触达不计入', () => {
  const r = assertShimCoverage(['5× document.createElement(canvas)'], BASE);
  assert.strictEqual(r.ok, true);
});

test('同一 API 多次触达只报一次', () => {
  const r = assertShimCoverage(
    ['1× window.newApi →undefined', '3× window.newApi →undefined'], BASE);
  assert.deepStrictEqual(r.novel, ['window.newApi']);
});

test('格式异常的行被识别为 malformed,测试失败', () => {
  const r = assertShimCoverage(
    ['1× window.Window →undefined', '1× api →undefined_typo'], BASE);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.malformed, ['1× api →undefined_typo']);
  assert.match(r.message, /格式可能已变更|无法识别/);
});

test('垫片 report() 格式整体变更 → 预警失效,必须被检测到', () => {
  // 垫片改了输出格式,比如从 "1× api →undefined" 变成 "window.foo = undefined"
  const r = assertShimCoverage(
    ['window.foo = undefined', 'window.bar = undefined'], BASE);
  assert.strictEqual(r.ok, false, '格式变更时必须 ok=false');
  assert.strictEqual(r.novel.length, 0, '应该没有识别出来的新增 API');
  assert.strictEqual(r.malformed.length, 2, '所有行都应该进 malformed');
  assert.match(r.message, /格式可能已变更/, '消息必须明确指出格式变更问题');
  assert.match(r.message, /预警机制失效/, '消息必须指出预警失效');
});

test('空输入或全空行 → 不误报', () => {
  const r = assertShimCoverage(['', '  ', '', null, '  '], BASE);
  assert.strictEqual(r.ok, true, '空输入应该 ok=true');
  assert.strictEqual(r.novel.length, 0);
  assert.strictEqual(r.malformed.length, 0, '空行不应该进 malformed');
});
