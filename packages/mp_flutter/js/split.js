'use strict';
/**
 * dart2js 产物分片。
 *
 * 为什么需要:微信单分包上限 2048KB(按源码大小),一个只有 TextField 的
 * Material 页面 main.dart.js 就有 2195KB。运行时下载/eval JS 是下架级违规,
 * 延迟加载(`deferred as`)又要求改业务代码 —— 只能在构建期把产物切开。
 *
 * 为什么可行:dart2js 产物是一个 IIFE,顶层只有几十个名字(helper 函数 +
 * holder 对象),其余几千条语句都是往 holder 上挂属性。把语句按顺序切成若干
 * 片、每片包进自己的函数,用一个共享作用域对象传递这几十个名字即可。
 * holder 是对象、只被修改不被重新绑定,所以各片里的同名局部别名指向同一
 * 个对象;少数"晚声明"的变量先在第 0 片建空对象占位,原声明处改成
 * Object.assign 填充,保证早先分片里的闭包拿到的也是同一个对象。
 *
 * 上述前提由 validate() 在构建期逐条检查,任何一条不成立都报错而不是
 * 产出可能在运行时出错的分片。
 */
const acorn = require('./vendor/acorn.js');
const fs = require('fs');
const path = require('path');

class SplitError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function bytes(s) { return Buffer.byteLength(s, 'utf8'); }

// 递归遍历 AST(不依赖 acorn-walk,只需要 type/子节点)
function visit(node, fn, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  if (fn(node, parents) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'type') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => visit(c, fn, parents.concat(node)));
    else if (v && typeof v.type === 'string') visit(v, fn, parents.concat(node));
  }
}

function findIife(ast) {
  const stmts = ast.body.filter((s) => !(s.type === 'ExpressionStatement' && s.directive));
  if (stmts.length !== 1) return null;
  const e = stmts[0].type === 'ExpressionStatement' ? stmts[0].expression : null;
  if (!e || e.type !== 'CallExpression' || e.arguments.length !== 0) return null;
  const callee = e.callee;
  if (callee.type !== 'FunctionExpression' || callee.params.length !== 0) return null;
  return callee;
}

function isPlainObjectLiteral(n) {
  return n.type === 'ObjectExpression' && n.properties.every((p) =>
    p.type === 'Property' && p.kind === 'init' && !isProtoKey(p));
}

// `{__proto__: x}` 和 `{"__proto__": x}` 都会在对象字面量求值时设置原型,
// 不是普通的自有属性;Object.assign 逐属性拷贝到占位对象上时,这个键会
// 静默改写占位对象的原型链而不是拷贝一个叫 __proto__ 的自有属性,和"分片
// 前后语义一致"的前提相悖,两种写法(标识符键、字符串字面量键)都要排除。
function isProtoKey(p) {
  if (p.computed) return false;
  if (p.key.type === 'Identifier') return p.key.name === '__proto__';
  if (p.key.type === 'Literal') return p.key.value === '__proto__';
  return false;
}

// dart2js 也会把顶层"晚声明"变量初始化为数组字面量(例如按下标引用刚建好的
// 几个 holder:`w=[A,J,B]`)。数组同样是"只被引用、不被重新赋值"的对象,
// 用同样的占位 + 填充手法即可保持跨分片的身份一致,只是占位符和填充方式
// (push.apply 而非 Object.assign)不同。没有 SpreadElement/elision 才安全。
function isPlainArrayLiteral(n) {
  return n.type === 'ArrayExpression' && n.elements.every((el) => el && el.type !== 'SpreadElement');
}

// Function.prototype.apply 把数组元素铺开成参数列表,受引擎参数个数上限约束
// (iOS 微信的 JSC 约 65536,V8 也有类似的栈上限)。晚声明数组元素很多时,
// 一次 push.apply 可能在真机上抛 RangeError;因此按固定块拆成多条
// push.apply,元素数远小于任何已知引擎上限。
const PUSH_APPLY_CHUNK_SIZE = 5000;
function chunkedPushApply(name, arrayNode, src) {
  const els = arrayNode.elements;
  const stmts = [];
  for (let i = 0; i < els.length; i += PUSH_APPLY_CHUNK_SIZE) {
    const slice = els.slice(i, i + PUSH_APPLY_CHUNK_SIZE).map((el) => src.slice(el.start, el.end));
    stmts.push('Array.prototype.push.apply(' + name + ',[' + slice.join(',') + ']);');
  }
  return stmts.join('\n');
}

// 调用式晚声明只允许"就地对象字面量工厂 IIFE":被调者必须是原地写的函数
// 表达式(不能是先声明再调用的具名函数,那样返回值可能是任意共享引用),
// 且函数体内(不含嵌套函数)所有顶层 return 语句都必须返回新建的对象字面量。
// 原因:分片对晚声明变量做的是"复制字段到占位对象"(Object.assign /
// __mpAssignPlain),而不是保留调用返回值本身的对象身份;只有"返回值就是
// 一次性新建的对象字面量"时,复制字段和保留身份在观察上才等价 —— 否则
// 复制出来的对象和原本"同一个引用"的语义就对不上。
function isPlainIifeReturningObjectLiterals(n) {
  if (n.type !== 'CallExpression' || n.callee.type !== 'FunctionExpression') return false;
  let sawReturn = false, ok = true;
  visit(n.callee.body, (node) => {
    if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression') return false;
    if (node.type === 'ReturnStatement') {
      sawReturn = true;
      if (!node.argument || !isPlainObjectLiteral(node.argument)) ok = false;
    }
  });
  return sawReturn && ok;
}

function analyze(src) {
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' }); }
  catch (e) { throw new SplitError('no-iife', 'main.dart.js 无法解析:' + e.message); }
  const iife = findIife(ast);
  if (!iife) throw new SplitError('no-iife', 'main.dart.js 不是预期的 dart2js 结构(单个无参 IIFE),无法分片');
  const body = iife.body.body;

  const names = [];               // 顶层名,按声明顺序
  let lastFunctionIdx = -1;
  body.forEach((s, i) => {
    if (s.type === 'FunctionDeclaration') {
      names.push(s.id.name); lastFunctionIdx = i;
    } else if (s.type === 'VariableDeclaration') {
      for (const d of s.declarations) {
        if (d.id.type !== 'Identifier') throw new SplitError('bad-late-init', '顶层解构声明不受支持');
        names.push(d.id.name);
      }
    }
  });
  return { ast, iife, body, names, lastFunctionIdx };
}

function validate(src, a) {
  const top = new Set(a.names);
  // 1. 顶层名不得在声明之外被重新绑定(initializeDeferredHunk 里的 x 例外:
  //    只在延迟加载时调用,管线会在检测到 deferred part 文件时拒绝分片)
  a.body.forEach((s) => {
    const inDeferredHelper = s.type === 'FunctionDeclaration' && s.id.name === 'initializeDeferredHunk';
    visit(s, (n) => {
      const target = n.type === 'AssignmentExpression' ? n.left : n.type === 'UpdateExpression' ? n.argument : null;
      if (target && target.type === 'Identifier' && top.has(target.name) && !inDeferredHelper) {
        throw new SplitError('reassigned', '顶层名 ' + target.name + ' 在声明之外被重新赋值(位置 ' + n.start + '),分片的别名前提不成立');
      }
    });
  });
  // 2. 顶层语句里不得出现不属于任何嵌套函数的 this(分片后每片包进新函数,this 会变)
  a.body.forEach((s) => {
    visit(s, (n) => {
      if (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration') return false;
      if (n.type === 'ThisExpression') throw new SplitError('top-level-this', 'IIFE 顶层语句直接使用了 this(位置 ' + n.start + '),分片后语义会变');
    });
  });
}

/**
 * 把顶层语句拆成"单元"(unit)。多数语句本身就是一个单元;但 dart2js -O4
 * 有时把一整个 holder 的成员压成一条 `var A = {很多属性};`,单个声明就可能
 * 超过预算,必须按属性再拆:
 *   var A = {}                         // 占位,和其它"晚声明"占位合并在片 0 顶部
 *   Object.assign(A, {prop1, prop2});  // 按预算分批,可落在任意片(除非原语句
 *   Object.assign(A, {prop3, ...});    // 本身在最后一个函数声明之前,见下)
 * 占位不作为普通 unit 参与分组(它必须始终在片 0),只在装配阶段统一插入。
 *
 * 若这条巨型声明本身就在"最后一个函数声明"之前(mustStay 区间内,和函数
 * 声明一样必须整体留在片 0——函数会被提升,中间不能插入别的分片边界),
 * 拆出来的 Object.assign 分批单元也必须继承 mustStay,不能被贪心算法当成
 * 可以随意挪到后面分片的普通内容;是否放得下由分组阶段的预算检查兜底。
 */
function buildUnits(a, src, maxContent) {
  const text = (s) => src.slice(s.start, s.end);
  const minFirst = a.lastFunctionIdx + 1;
  const units = [];
  a.body.forEach((s, i) => {
    const mustStay = i < minFirst;
    if (s.type === 'FunctionDeclaration') {
      units.push({ kind: 'fixed', text: text(s), mustStay, isFunction: true });
      return;
    }
    if (s.type !== 'VariableDeclaration') {
      units.push({ kind: 'fixed', text: text(s), mustStay });
      return;
    }
    for (const d of s.declarations) {
      const name = d.id.name;
      if (!d.init) { units.push({ kind: 'fixed', text: 'var ' + name + ';', mustStay }); continue; }
      const declText = 'var ' + name + '=' + text(d.init) + ';';
      if (bytes(declText) <= maxContent) {
        units.push({ kind: 'decl', text: declText, name, initNode: d.init, mustStay });
        continue;
      }
      if (!isPlainObjectLiteral(d.init)) {
        throw new SplitError('statement-too-large', '顶层变量 ' + name + ' 的初值有 ' + bytes(declText) +
          ' 字节,超过单片预算 ' + maxContent + ' 字节,且初值类型(' + d.init.type + ')不支持按属性分片');
      }
      // 按属性分批,压成若干条 Object.assign(name, {...})
      const wrapperOverhead = bytes('Object.assign(' + name + ',{});') + 4;
      let batch = [], batchBytes = 0;
      const flush = () => {
        if (!batch.length) return;
        units.push({ kind: 'fixed', text: 'Object.assign(' + name + ',{' + batch.join(',') + '});', mustStay, forceLate: name });
        batch = []; batchBytes = 0;
      };
      for (const p of d.init.properties) {
        const ptxt = text(p);
        const pb = bytes(ptxt) + 1;
        if (pb + wrapperOverhead > maxContent) {
          throw new SplitError('statement-too-large', '顶层变量 ' + name + ' 的一个属性有 ' + pb +
            ' 字节,超过单片预算 ' + maxContent + ' 字节,无法再拆');
        }
        if (batch.length && batchBytes + pb + wrapperOverhead > maxContent) flush();
        batch.push(ptxt); batchBytes += pb;
      }
      flush();
      // 占位本身很小,但不参与分组贪心(它必须永远落在片 0),故不 push 为 unit,
      // 而是记入 forceLate,由装配阶段统一生成 `var name={};`。
      units.push({ kind: 'placeholder', name });
    }
  });
  return units;
}

/**
 * 切片。第 0 片至少包含所有函数声明(函数声明会提升,不能落到后面的分片)。
 */
function splitDart2js(src, opts) {
  const budget = opts.budgetBytes;
  const scopeRequire = JSON.stringify(opts.scopeRequire);
  const a = analyze(src);
  validate(src, a);
  const { names } = a;

  // __mpAssignPlain 定义在片 0,但"晚声明 = 调用表达式"的改写可能落在任意
  // 片,所以它和 dart2js 的顶层名一样要走 __mpS 导出/别名。
  const exportAll = names.map((n) => '__mpS.' + n + '=' + n + ';').join('') + '__mpS.__mpAssignPlain=__mpAssignPlain;';
  const aliasAll = 'var ' + ['__mpAssignPlain'].concat(names).map((n) => n + '=__mpS.' + n).join(',') + ';';
  const assignPlain = 'function __mpAssignPlain(o,r,n){if(r===null||typeof r!=="object"||Object.getPrototypeOf(r)!==Object.prototype)' +
    'throw new Error("mp-flutter 分片:晚声明变量 "+n+" 的初值不是普通对象,分片前提被打破");Object.assign(o,r)}';

  const header = (i, n) => '// [mp-flutter] main.dart.js 分片 ' + (i + 1) + '/' + n + '(构建期生成,勿手改)\n' +
    'var __mpS=require(' + scopeRequire + ');\n';

  const overhead0 = bytes(header(0, 99) + '(function dartProgram(){\n' + assignPlain + '\n})();\n' + exportAll) + 200;
  const overheadN = bytes(header(1, 99) + '(function(){\n' + aliasAll + '\n})();\n') + 64;
  // 拆属性时不知道最终落在哪一片,用两种 overhead 里更严格的一个,保证无论
  // 落在片 0 还是片 i 都不会超预算。
  const maxContent = budget - Math.max(overhead0, overheadN);

  // buildUnits 里"单条语句/单个属性超预算"的判断也依赖 maxContent,budget
  // 本身太小(< overhead)时给出更直接的报错。
  if (maxContent <= 0) {
    throw new SplitError('statement-too-large', '预算 ' + budget + ' 字节小于分片自身的固定开销,无法分片');
  }

  const units = buildUnits(a, src, maxContent);
  const forceLate = new Set(units.filter((u) => u.kind === 'placeholder' || u.forceLate).map((u) => u.name || u.forceLate));
  // 占位符的具体形态('{}' 或 '[]');按属性拆批的晚声明变量一定来自对象字面量。
  const placeholderKind = new Map();
  forceLate.forEach((n) => placeholderKind.set(n, 'object'));

  // 贪心分组:仅对参与分组的 unit(kind !== 'placeholder')生效
  const groups = [];
  let cur = [], curBytes = 0;
  units.forEach((u) => {
    if (u.kind === 'placeholder') return;
    const overhead = groups.length === 0 ? overhead0 : overheadN;
    const b = bytes(u.text) + 1;
    if (b + overhead > budget) {
      throw new SplitError('statement-too-large', '单元 ' + JSON.stringify(u.text.slice(0, 40)) + ' 有 ' + b +
        ' 字节,超过单片预算 ' + budget + ' 字节,无法分片');
    }
    if (!u.mustStay && cur.length && curBytes + b + overhead > budget) {
      groups.push(cur); cur = []; curBytes = 0;
    }
    cur.push(u); curBytes += b;
    // mustStay 单元不能被挪走(函数声明必须整体留在片 0,和它挨在一起的
    // 内容——包括巨型对象拆批出的 Object.assign——也一样);这里放不下就
    // 没有"挪到下一片"的退路,只能明确报错,而不是悄悄超预算。
    if (u.mustStay && curBytes + overhead > budget) {
      throw new SplitError('statement-too-large', '函数声明之前的顶层语句必须留在第 0 片,合计 ' + curBytes +
        ' 字节,超过单片预算 ' + budget + ' 字节,无法分片');
    }
  });
  if (cur.length) groups.push(cur);
  if (!groups.length) groups.push([]);
  groups.forEach((g, gi) => g.forEach((u) => { u.groupIndex = gi; }));

  // 未被强制晚声明、但按贪心分组落在片 0 之后的 decl 单元,也要补进"晚声明"
  units.forEach((u) => {
    if (u.kind === 'decl' && u.groupIndex > 0) {
      forceLate.add(u.name);
      placeholderKind.set(u.name, isPlainArrayLiteral(u.initNode) ? 'array' : 'object');
    }
  });

  const finalText = (u) => {
    if (u.kind === 'fixed') {
      if (u.isFunction && u.groupIndex > 0) {
        throw new SplitError('late-function', '函数声明落在第 0 片之后,会破坏函数提升语义');
      }
      return u.text;
    }
    // kind === 'decl'
    if (!forceLate.has(u.name)) return u.text;
    const n = u.name, initNode = u.initNode;
    if (isPlainArrayLiteral(initNode)) return chunkedPushApply(n, initNode, src);
    if (isPlainObjectLiteral(initNode)) return 'Object.assign(' + n + ',' + src.slice(initNode.start, initNode.end) + ');';
    if (initNode.type === 'CallExpression') {
      if (!isPlainIifeReturningObjectLiterals(initNode)) {
        throw new SplitError('bad-late-init', '晚声明变量 ' + n + ' 的初值是调用表达式,但只支持返回新建对象字面量的就地 IIFE' +
          '(被调者必须是原地写的函数表达式,且函数体内所有顶层 return 都必须返回新建的对象字面量),' +
          '因为分片会用复制字段代替对象身份');
      }
      return '__mpAssignPlain(' + n + ',' + src.slice(initNode.start, initNode.end) + ',"' + n + '");';
    }
    throw new SplitError('bad-late-init', '晚声明变量 ' + n + ' 的初值类型为 ' + initNode.type + ',只支持对象字面量、数组字面量或返回普通对象的调用');
  };

  const total = groups.length;
  const chunks = groups.map((g, gi) => {
    const stmts = g.map(finalText).join('\n');
    if (gi === 0) {
      const placeholders = forceLate.size
        ? 'var ' + Array.from(forceLate).map((n) => n + '=' + (placeholderKind.get(n) === 'array' ? '[]' : '{}')).join(',') + ';\n'
        : '';
      return header(0, total) + '(function dartProgram(){\n' + assignPlain + '\n' + placeholders + stmts + '\n' + exportAll + '\n})();\n';
    }
    return header(gi, total) + '(function(){\n' + aliasAll + '\n' + stmts + '\n})();\n';
  });
  chunks.forEach((c, i) => {
    if (bytes(c) > budget) throw new SplitError('statement-too-large', '分片 ' + i + ' 改写后 ' + bytes(c) + ' 字节,超过预算 ' + budget + ' 字节');
  });
  return { chunks };
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const inFile = arg('--in'), outDir = arg('--out-dir'), budget = Number(arg('--budget')), scope = arg('--scope-require');
  if (!inFile || !outDir || !budget || !scope) {
    process.stderr.write('用法: node split.js --in <main.dart.js> --out-dir <dir> --budget <bytes> --scope-require <path>\n');
    process.exit(2);
  }
  try {
    const { chunks } = splitDart2js(fs.readFileSync(inFile, 'utf8'), { budgetBytes: budget, scopeRequire: scope });
    fs.mkdirSync(outDir, { recursive: true });
    chunks.forEach((c, i) => fs.writeFileSync(path.join(outDir, 'chunk-' + i + '.js'), c));
    process.stdout.write(JSON.stringify({ count: chunks.length }) + '\n');
  } catch (e) {
    if (e instanceof SplitError) { process.stderr.write('SPLIT_ERROR ' + e.code + ': ' + e.message + '\n'); process.exit(3); }
    throw e;
  }
}

module.exports = { splitDart2js, SplitError };
if (require.main === module) main(process.argv.slice(2));
