'use strict';
/**
 * 构建期把 dart2js 产物里正则的 Unicode 属性转义 `\p{…}` / `\P{…}` 改写成
 * 等价的码点区间。
 *
 * 为什么需要:安卓微信的 JS 引擎不带 ICU,不支持 Unicode 属性转义,
 * `new RegExp('\\p{Space_Separator}', 'u')` 直接抛
 * `SyntaxError: Invalid regular expression: /\p{Space_Separator}/u: Invalid property name`。
 * Flutter 框架 text_painter.dart 里有两处这样的正则(`[\p{Space_Separator}\p{Punctuation}]`
 * 与 `\p{Space_Separator}`),插入文字时走到,异常让这次更新整个丢掉——输入框
 * 不回显,直到失焦才刷新。开发者工具(Chromium)与 iOS(JSCore)都支持,复现不了。
 *
 * 做法:
 *   · 用 acorn 解析产物,只看 JS 字符串字面量与正则字面量(dart2js 的 RegExp
 *     源码以字符串常量出现,运行时 `new RegExp(src, flags)`);
 *   · 在解码后的正则源码里跟踪字符类 `[...]` 状态(按 u 模式:字符类不嵌套,
 *     `\` 转义一个字符),遇到 `\p{NAME}` / `\P{NAME}`:
 *       - 字符类外:`\p{X}` → `[区间…]`,`\P{X}` → `[^区间…]`;
 *       - 字符类内:`\p{X}` → `区间…`,`\P{X}` → 补集区间…;
 *   · 区间由本机 Node(带 ICU)遍历 0..0x10FFFF 用 `\p{NAME}` 实测得出,同一个
 *     NAME 只算一次(进程内缓存);码点写成 `\u{XXXX}`(这些正则都带 u 标志);
 *   · 改写后的源码按原引号重新编码成 JS 字符串字面量(反斜杠再转义一层)。
 *
 * NAME 形如 `Letter` / `Script=Han` / `General_Category=Lu`;形状对但 Node 不认识
 * 的属性名报具名错误 UnicodePropsError('unknown-property'),不产出可能在真机上
 * 抛异常的产物。形状不对的(不是属性转义写法,比如普通文本)原样保留。
 *
 * 注意:字符串里的 `\p{…}` 只有在以 u 标志构造正则时才是属性转义;构建期看不到
 * 标志,一律按属性转义改写。不带 u 时 `\p{X}` 本就是非法/字面含义,Dart 代码里
 * 不会这样写。
 *
 * CLI:node unicode-props.js --in main.dart.js --out out.js
 *   stdout 打印 JSON {"rewrites":N,"properties":[...]};失败时 stderr 打印
 *   `[unicode-props] <code>: <message>`,退出码 2。
 */
const fs = require('fs');

const MAX_CP = 0x10ffff;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(=[A-Za-z0-9_]+)?$/;

class UnicodePropsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const cache = new Map();

/** NAME 对应的码点区间 [[lo, hi], ...](升序、不重叠、不相邻)。 */
function propertyRanges(name) {
  if (cache.has(name)) return cache.get(name);
  let re;
  try {
    re = new RegExp('^\\p{' + name + '}$', 'u');
  } catch (e) {
    throw new UnicodePropsError('unknown-property',
      `Unicode 属性 \\p{${name}} 本机 Node(${process.version},Unicode ${process.versions.unicode || '?'})也不认识:${e.message}`);
  }
  const ranges = [];
  let start = -1;
  for (let cp = 0; cp <= MAX_CP; cp++) {
    if (re.test(String.fromCodePoint(cp))) {
      if (start < 0) start = cp;
    } else if (start >= 0) {
      ranges.push([start, cp - 1]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, MAX_CP]);
  cache.set(name, ranges);
  return ranges;
}

function complement(ranges) {
  const out = [];
  let next = 0;
  for (const [lo, hi] of ranges) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CP) out.push([next, MAX_CP]);
  return out;
}

function cpEsc(cp) { return '\\u{' + cp.toString(16).toUpperCase() + '}'; }

function rangesSource(ranges) {
  let s = '';
  for (const [lo, hi] of ranges) {
    s += lo === hi ? cpEsc(lo) : hi === lo + 1 ? cpEsc(lo) + cpEsc(hi) : cpEsc(lo) + '-' + cpEsc(hi);
  }
  return s;
}

/**
 * 改写一段正则源码(已解码,即 `new RegExp` 拿到的那个字符串)。
 * 返回 { source, properties },没有属性转义时 source 原样返回。
 */
function rewriteRegexSource(src) {
  if (!/\\[pP]\{/.test(src)) return { source: src, properties: [] };
  let out = '';
  let inClass = false;
  const props = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      if ((n === 'p' || n === 'P') && src[i + 2] === '{') {
        const close = src.indexOf('}', i + 3);
        const name = close < 0 ? null : src.slice(i + 3, close);
        if (name !== null && NAME_RE.test(name)) {
          const ranges = propertyRanges(name);
          props.push(name);
          const negate = n === 'P';
          if (inClass) {
            out += rangesSource(negate ? complement(ranges) : ranges);
          } else {
            out += (negate ? '[^' : '[') + rangesSource(ranges) + ']';
          }
          i = close + 1;
          continue;
        }
      }
      // 普通转义(含 `\\`、`\[`、`\]`):原样带上被转义的那个字符
      out += c + (n === undefined ? '' : n);
      i += 2;
      continue;
    }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    out += c;
    i++;
  }
  return { source: out, properties: props };
}

/** 按 JS 字符串字面量规则编码(保持原引号)。 */
function encodeJsString(value, quote) {
  let s = quote;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    if (ch === '\\') s += '\\\\';
    else if (ch === quote) s += '\\' + quote;
    else if (ch === '\n') s += '\\n';
    else if (ch === '\r') s += '\\r';
    else if (ch === '\t') s += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ||
             (code >= 0xd800 && code <= 0xdfff)) {
      s += '\\u' + code.toString(16).padStart(4, '0');
    } else s += ch;
  }
  return s + quote;
}

/**
 * 改写整段 JS 源码里所有字符串字面量 / 正则字面量中的 Unicode 属性转义。
 * 返回 { code, rewrites, properties }。
 */
function rewriteJs(code) {
  // 快速路径:原文里连 `\p{` / `\P{` 都没有(字符串里是 `\\p{`,同样含这个子串)
  if (!/\\[pP]\{/.test(code)) return { code, rewrites: 0, properties: [] };
  const acorn = require('./vendor/acorn.js');
  const tokens = [];
  try {
    acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true,
      allowReturnOutsideFunction: true, onToken: tokens });
  } catch (e) {
    throw new UnicodePropsError('parse-failed', `解析 JS 失败:${e.message}`);
  }
  const edits = [];
  const props = new Set();
  for (const t of tokens) {
    const label = t.type.label;
    if (label === 'string') {
      const raw = code.slice(t.start, t.end);
      if (!/\\[pP]\{/.test(raw) || !/\\[pP]\{/.test(t.value)) continue;
      const r = rewriteRegexSource(t.value);
      if (r.properties.length === 0) continue;
      r.properties.forEach((p) => props.add(p));
      edits.push([t.start, t.end, encodeJsString(r.source, raw[0])]);
    } else if (label === 'regexp') {
      const { pattern, flags } = t.value;
      if (!/\\[pP]\{/.test(pattern)) continue;
      const r = rewriteRegexSource(pattern);
      if (r.properties.length === 0) continue;
      r.properties.forEach((p) => props.add(p));
      edits.push([t.start, t.end, '/' + r.source + '/' + flags]);
    } else if (label === 'template') {
      if (t.value && /\\[pP]\{/.test(t.value)) {
        throw new UnicodePropsError('unsupported-literal',
          `模板字符串里出现 Unicode 属性转义(位置 ${t.start}),未支持改写:${JSON.stringify(t.value.slice(0, 80))}`);
      }
    }
  }
  if (edits.length === 0) return { code, rewrites: 0, properties: [] };
  let out = '';
  let pos = 0;
  for (const [s, e, rep] of edits) {
    out += code.slice(pos, s) + rep;
    pos = e;
  }
  out += code.slice(pos);
  return { code: out, rewrites: edits.length, properties: [...props].sort() };
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const inPath = arg('--in');
  const outPath = arg('--out');
  if (!inPath || !outPath) {
    process.stderr.write('[unicode-props] usage: node unicode-props.js --in <file> --out <file>\n');
    process.exit(64);
  }
  try {
    const r = rewriteJs(fs.readFileSync(inPath, 'utf8'));
    fs.writeFileSync(outPath, r.code);
    process.stdout.write(JSON.stringify({ rewrites: r.rewrites, properties: r.properties }) + '\n');
  } catch (e) {
    process.stderr.write(`[unicode-props] ${e.code || 'error'}: ${e.message}\n`);
    process.exit(2);
  }
}

module.exports = { rewriteJs, rewriteRegexSource, propertyRanges, complement, encodeJsString, UnicodePropsError };

if (require.main === module) main(process.argv.slice(2));
