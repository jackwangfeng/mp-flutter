'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { splitDart2js } = require('../split');

const DART = process.env.DART || path.join(os.homedir(), 'development/flutter/bin/dart');
let compiled = null;
function fixtureJs() {
  if (compiled) return compiled;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dart-split-')), 'app.js');
  execFileSync(DART, ['compile', 'js', '-O4', '-o', out, path.join(__dirname, 'fixture/app.dart')], { stdio: 'pipe' });
  compiled = fs.readFileSync(out, 'utf8');
  return compiled;
}

// 在新 vm 上下文里执行,收集 print 输出。dart2js 的 print 优先调用 dartPrint。
function run(files) {
  const lines = [];
  const scope = {};
  const ctx = vm.createContext({
    dartPrint: (s) => lines.push(String(s)),
    console, setTimeout, clearTimeout, Promise, queueMicrotask,
  });
  ctx.self = ctx;
  for (const src of files) {
    const fn = vm.runInContext('(function(require){' + src + '\n})', ctx);
    fn((p) => { if (p === 'SCOPE') return scope; throw new Error('unexpected require ' + p); });
  }
  return new Promise((r) => setTimeout(() => r(lines.join('\n')), 200));
}

test('分片执行与整体执行输出一致(≥3 片)', async () => {
  const src = fixtureJs();
  const expected = await run([src]);
  assert.match(expected, /woof hi dog\|counter=2\|lazy=6\|const=true\|is=true false/);
  const { chunks } = splitDart2js(src, { budgetBytes: Math.ceil(src.length / 4), scopeRequire: 'SCOPE' });
  assert.ok(chunks.length >= 3, '预算取四分之一,应切出至少 3 片,实际 ' + chunks.length);
  assert.strictEqual(await run(chunks), expected);
});

test('每个分片都不超过预算(按 UTF-8 字节)', () => {
  const src = fixtureJs();
  const budget = Math.ceil(src.length / 4);
  const { chunks } = splitDart2js(src, { budgetBytes: budget, scopeRequire: 'SCOPE' });
  for (const c of chunks) assert.ok(Buffer.byteLength(c, 'utf8') <= budget, '分片 ' + Buffer.byteLength(c) + ' > ' + budget);
});

test('预算足够时只产出 1 片,且仍可正确执行', async () => {
  const src = fixtureJs();
  const { chunks } = splitDart2js(src, { budgetBytes: src.length * 2, scopeRequire: 'SCOPE' });
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(await run(chunks), await run([src]));
});

test('单条顶层语句超过预算:报 statement-too-large 并给出大小', () => {
  const src = fixtureJs();
  assert.throws(() => splitDart2js(src, { budgetBytes: 2000, scopeRequire: 'SCOPE' }),
    (e) => e.code === 'statement-too-large' && /\d+ 字节/.test(e.message));
});

test('不是 dart2js 的 IIFE 结构:报 no-iife', () => {
  assert.throws(() => splitDart2js('var a = 1;', { budgetBytes: 1e6, scopeRequire: 'SCOPE' }),
    (e) => e.code === 'no-iife');
});

test('顶层名在别处被重新赋值:报 reassigned(破坏别名前提)', () => {
  const src = '(function dartProgram(){function f(){} var A={}; A.x=1; function g(){A=2}})()';
  assert.throws(() => splitDart2js(src, { budgetBytes: 1e6, scopeRequire: 'SCOPE' }),
    (e) => e.code === 'reassigned' && /A/.test(e.message));
});

test('晚声明变量的初值不是对象:报 bad-late-init', () => {
  const src = '(function dartProgram(){var A={}; A.x=1; A.y=2; var t=5})()';
  assert.throws(() => splitDart2js(src, { budgetBytes: 30, scopeRequire: 'SCOPE' }),
    (e) => e.code === 'bad-late-init' || e.code === 'statement-too-large');
});

// 运行一组分片(不依赖 dartPrint),返回共享作用域对象,供直接检查
// __mpS 上的顶层名(对象身份、属性、数组内容等)。
function execChunks(chunks) {
  const scope = {};
  const ctx = vm.createContext({});
  for (const src of chunks) {
    const fn = vm.runInContext('(function(require){' + src + '\n})', ctx);
    fn((p) => { if (p === 'SCOPE') return scope; throw new Error('unexpected require ' + p); });
  }
  return scope;
}

// 一条足够大、和被测变量无关的顶层 var 声明,用来在贪心分组时把后面的
// 声明"挤"到下一片,从而制造"晚声明"场景,不必精确计算 overhead。写成对象
// 字面量(而不是字符串/数字字面量),这样即使它自己也被挤成"晚声明"
// (比如两条 pad 挨在一起,第二条也可能被挤到下一片),走的是受支持的
// Object.assign 路径,不会污染测试想验证的那个变量的报错/结果。
function padVar(id, n) { return 'var __pad' + id + '={x:"' + 'x'.repeat(n) + '"};'; }

test('晚声明数组元素数很多(超过分块阈值):按块 push.apply,数组完整且顺序不变', () => {
  const N = 6001; // 阈值是 5000,取 6001 保证至少切成 2 条 push.apply
  const els = Array.from({ length: N }, (_, i) => i % 10).join(',');
  const src = '(function dartProgram(){' + padVar(0, 15000) + padVar(1, 15000) + 'var big=[' + els + '];})()';
  const { chunks } = splitDart2js(src, { budgetBytes: 20000, scopeRequire: 'SCOPE' });
  assert.ok(chunks.length >= 2, 'big 应该被挤到片 0 之后,实际 ' + chunks.length + ' 片');
  const scope = execChunks(chunks);
  assert.strictEqual(scope.big.length, N);
  for (let i = 0; i < N; i++) assert.strictEqual(scope.big[i], i % 10, '下标 ' + i + ' 的值不对');
});

test('调用式晚声明:就地 IIFE 且所有 return 都是对象字面量,允许通过', () => {
  const src = '(function dartProgram(){' + padVar(0, 3000) + padVar(1, 3000) +
    'var t=(function(){return {a:1}})();})()';
  const { chunks } = splitDart2js(src, { budgetBytes: 4000, scopeRequire: 'SCOPE' });
  assert.ok(chunks.length >= 2, 't 应该被挤到片 0 之后,实际 ' + chunks.length + ' 片');
  const scope = execChunks(chunks);
  // scope.t 是在另一个 vm 上下文里创建的对象,和这里的 Object.prototype
  // 不是同一个,deepStrictEqual 会因为原型不同而判定"不是同一种结构"；
  // 直接比较自有属性即可。
  assert.deepStrictEqual(Object.keys(scope.t), ['a']);
  assert.strictEqual(scope.t.a, 1);
});

test('调用式晚声明:被调者不是就地函数表达式(具名函数调用),报 bad-late-init', () => {
  const src = '(function dartProgram(){' + padVar(0, 3000) + padVar(1, 3000) + 'var t=f2();})()';
  assert.throws(() => splitDart2js(src, { budgetBytes: 4000, scopeRequire: 'SCOPE' }),
    (e) => e.code === 'bad-late-init');
});

test('调用式晚声明:就地 IIFE 但 return 的不是对象字面量,报 bad-late-init', () => {
  const src = '(function dartProgram(){' + padVar(0, 3000) + padVar(1, 3000) +
    'var t=(function(){return g})();})()';
  assert.throws(() => splitDart2js(src, { budgetBytes: 4000, scopeRequire: 'SCOPE' }),
    (e) => e.code === 'bad-late-init');
});

test('晚声明变量初值是数字字面量(非对象/数组/IIFE):预算充足时明确走 bad-late-init(而非 statement-too-large 兜底)', () => {
  const src = '(function dartProgram(){' + padVar(0, 3000) + padVar(1, 3000) + 'var t=5;})()';
  assert.throws(() => splitDart2js(src, { budgetBytes: 4000, scopeRequire: 'SCOPE' }),
    (e) => e.code === 'bad-late-init');
});

test('对象字面量的字符串键 "__proto__" 也当作非普通对象字面量(晚声明报 bad-late-init)', () => {
  const src = '(function dartProgram(){' + padVar(0, 3000) + padVar(1, 3000) +
    'var A={"__proto__":{evil:1}};})()';
  assert.throws(() => splitDart2js(src, { budgetBytes: 4000, scopeRequire: 'SCOPE' }),
    (e) => e.code === 'bad-late-init');
});

test('大对象拆批单元若落在最后一个函数声明之前(mustStay 区间):放不下报 statement-too-large,不产出 late-function', () => {
  const props = Array.from({ length: 400 }, (_, i) => 'p' + i + ':' + i).join(',');
  const src = '(function dartProgram(){var A={' + props + '};function f(){}})()';
  assert.throws(() => splitDart2js(src, { budgetBytes: 1500, scopeRequire: 'SCOPE' }),
    (e) => e.code === 'statement-too-large');
});

test('对象字面量按属性拆批:跨多片后身份不变、属性齐全、枚举顺序与原字面量一致', () => {
  const props = Array.from({ length: 60 }, (_, i) => 'p' + i + ':' + i);
  const src = '(function dartProgram(){function getA(){return A}var A={' + props.join(',') + '}})()';
  const { chunks } = splitDart2js(src, { budgetBytes: 700, scopeRequire: 'SCOPE' });
  assert.ok(chunks.length >= 3, '应拆成多片,实际 ' + chunks.length);
  const scope = execChunks(chunks);
  assert.strictEqual(scope.getA(), scope.A, '身份必须和导出的 A 一致(闭包拿到同一个对象)');
  assert.deepStrictEqual(Object.keys(scope.A), props.map((_, i) => 'p' + i), '枚举顺序须与原字面量一致');
  for (let i = 0; i < props.length; i++) assert.strictEqual(scope.A['p' + i], i);
});

test('CLI:写出分片文件并打印 count', () => {
  const src = fixtureJs();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-split-cli-'));
  const inFile = path.join(dir, 'main.dart.js');
  fs.writeFileSync(inFile, src);
  const out = execFileSync('node', [path.join(__dirname, '../split.js'), '--in', inFile, '--out-dir', dir,
    '--budget', String(Math.ceil(src.length / 3)), '--scope-require', '../mp-dart-scope.js']).toString();
  const { count } = JSON.parse(out.trim());
  assert.ok(count >= 3);
  for (let i = 0; i < count; i++) assert.ok(fs.existsSync(path.join(dir, 'chunk-' + i + '.js')));
});
