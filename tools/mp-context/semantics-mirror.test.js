'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');

const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

function setupShim(opts) {
  const c = createMpContext(opts);
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({ canvas: c.canvas, width: 390, height: 844, dpr: 3 });
  return { c, shim };
}

function loadSemanticsMirror(c) {
  return c.requireModule(path.join(RT, 'semantics-mirror.js'));
}

/** 建出探针文档 §5 描述的骨架:body 下直接挂 flt-semantics-host(带
 * scale(1/dpr) 变换)与 flt-semantics-placeholder。 */
function buildHostSkeleton(shim, { dpr = 3 } = {}) {
  const host = shim.document.createElement('flt-semantics-host');
  host.style.transform = 'scale(' + (1 / dpr) + ')';
  shim.document.body.append(host);
  const placeholder = shim.document.createElement('flt-semantics-placeholder');
  placeholder.setAttribute('role', 'button');
  placeholder.setAttribute('aria-label', 'Enable accessibility');
  shim.document.body.append(placeholder);
  return { host, placeholder };
}

/** 建一个语义节点:aria-label 表示(最常见路径)。 */
function addAriaNode(shim, parent, { id, label, x, y, w, h }) {
  const el = shim.document.createElement('flt-semantics');
  el.setAttribute('id', id);
  if (label != null) el.setAttribute('aria-label', label);
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.style.transform = 'matrix(1,0,0,1,' + x + ',' + y + ')';
  parent.append(el);
  return el;
}

function makeFakeInterval() {
  const timers = new Map();
  let seq = 1;
  return {
    setIntervalFn: (fn) => { const id = seq++; timers.set(id, fn); return id; },
    clearIntervalFn: (id) => { timers.delete(id); },
    fire() { timers.forEach((fn) => fn()); },
  };
}

test('激活:boot 完成后对 flt-semantics-placeholder 派发一次 click,且只派发一次', () => {
  const { c, shim } = setupShim();
  const { createSemanticsMirror } = loadSemanticsMirror(c);
  const { placeholder } = buildHostSkeleton(shim);

  let clicks = 0;
  let lastTarget = null;
  let lastClientX = null;
  let lastClientY = null;
  placeholder.addEventListener('click', (e) => {
    clicks++; lastTarget = e.target; lastClientX = e.clientX; lastClientY = e.clientY;
  });

  const { setIntervalFn, clearIntervalFn } = makeFakeInterval();
  const calls = [];
  const mirror = createSemanticsMirror({
    shim, setData: (p) => calls.push(p), setIntervalFn, clearIntervalFn,
  });
  mirror.start();
  assert.strictEqual(clicks, 1, '应该派发恰好一次 click');
  assert.strictEqual(lastTarget, placeholder, 'click 的 target 必须是占位元素本身');
  // 回归(2026-09-27 E2E 实测坑):引擎的 MobileSemanticsEnabler 按
  // getBoundingClientRect() 中点(±1px)校验落点,不看 target;bom-shim 的
  // getBoundingClientRect() 对所有元素都返回画布整体矩形,所以这里必须是
  // 画布中心,留空坐标会导致真实设备/开发者工具里语义树永远不会被打开。
  assert.strictEqual(lastClientX, shim.window.innerWidth / 2);
  assert.strictEqual(lastClientY, shim.window.innerHeight / 2);

  // 再次 start()(理论上不会发生,但防御一下)不应该再派发第二次。
  mirror.start();
  assert.strictEqual(clicks, 1, '重复 start() 不应重复派发激活 click');
});

test('激活:找不到占位元素时警告一次,不抛错,不影响后续扫描', () => {
  const { c, shim } = setupShim();
  const { createSemanticsMirror } = loadSemanticsMirror(c);
  // 故意不建 placeholder,只建 host。
  const host = shim.document.createElement('flt-semantics-host');
  host.style.transform = 'scale(0.333333)';
  shim.document.body.append(host);

  const origWarn = console.warn;
  let warnCount = 0;
  console.warn = () => { warnCount++; };
  try {
    const { setIntervalFn, clearIntervalFn } = makeFakeInterval();
    const mirror = createSemanticsMirror({
      shim, setData: () => {}, setIntervalFn, clearIntervalFn,
    });
    assert.doesNotThrow(() => mirror.start());
    assert.strictEqual(warnCount, 1);
  } finally {
    console.warn = origWarn;
  }
});

test('几何:从节点自身累加到 host(不含 host),再乘 host 的 dpr 换算系数', () => {
  const { c, shim } = setupShim();
  const { createSemanticsMirror } = loadSemanticsMirror(c);
  const { host } = buildHostSkeleton(shim, { dpr: 3 });
  // 嵌套一层容器(自己也有平移,但没有 aria-label——纯容器,不应该单独
  // 出现在结果里),子节点的偏移要与容器的偏移累加。
  const group = shim.document.createElement('flt-semantics');
  group.setAttribute('id', 'flt-semantic-node-1');
  group.style.width = '300px';
  group.style.height = '600px';
  group.style.transform = 'matrix(1,0,0,1,30,60)';
  host.append(group);
  addAriaNode(shim, group, { id: 'flt-semantic-node-2', label: '已知文本', x: 15, y: 9, w: 90, h: 30 });

  const { setIntervalFn, clearIntervalFn } = makeFakeInterval();
  const calls = [];
  const mirror = createSemanticsMirror({
    shim, setData: (p) => calls.push(p), setIntervalFn, clearIntervalFn,
  });
  mirror.scan();

  assert.strictEqual(calls.length, 1);
  const list = calls[0].mpSemantics;
  assert.strictEqual(list.length, 1, '纯容器节点(group,无 aria-label)不应出现在结果里');
  const entry = list[0];
  assert.strictEqual(entry.label, '已知文本');
  // 物理像素:(30+15, 60+9) = (45, 69),宽高 (90,30);乘 1/3 = (15, 23, 30, 10)
  assert.strictEqual(entry.left, 15);
  assert.strictEqual(entry.top, 23);
  assert.strictEqual(entry.width, 30);
  assert.strictEqual(entry.height, 10);
});

test('文案:domText(文本子节点)与 sizedSpan(子元素 .text 字段)两种表示都能取到', () => {
  const { c, shim } = setupShim();
  const { createSemanticsMirror } = loadSemanticsMirror(c);
  const { host } = buildHostSkeleton(shim);

  const domTextNode = shim.document.createElement('flt-semantics');
  domTextNode.setAttribute('id', 'a');
  domTextNode.style.width = '10px'; domTextNode.style.height = '10px';
  domTextNode.style.transform = 'matrix(1,0,0,1,0,0)';
  domTextNode.appendChild(shim.document.createTextNode('domText 文案'));
  host.append(domTextNode);

  const sizedSpanNode = shim.document.createElement('flt-semantics');
  sizedSpanNode.setAttribute('id', 'b');
  sizedSpanNode.style.width = '10px'; sizedSpanNode.style.height = '10px';
  sizedSpanNode.style.transform = 'matrix(1,0,0,1,0,0)';
  const span = shim.document.createElement('span');
  // 真实引擎(SizedSpanRepresentation)写的是 `.text`,dart2js 编译后落地的
  // 实际 JS 属性是 `.textContent`(`DomNode.text` 是 `@JS('textContent')`
  // 映射,见 dom.dart)——这里照真实产物的样子来,不是随手选一个属性名。
  span.textContent = 'sizedSpan 文案';
  sizedSpanNode.append(span);
  host.append(sizedSpanNode);

  const { setIntervalFn, clearIntervalFn } = makeFakeInterval();
  const calls = [];
  const mirror = createSemanticsMirror({ shim, setData: (p) => calls.push(p), setIntervalFn, clearIntervalFn });
  mirror.scan();

  // 结果数组是在 vm 沙盒里构造的(跨 realm),deepStrictEqual 对 Array 会比较
  // 原型链身份而不仅仅是内容——这里改用 JSON 序列化比较,只关心内容。
  const labels = calls[0].mpSemantics.map((e) => e.label).sort();
  assert.strictEqual(JSON.stringify(labels), JSON.stringify(['domText 文案', 'sizedSpan 文案']));
});

test('镜像 diff:内容不变时不重复 setData;内容变化后只发生变化那一次', () => {
  const { c, shim } = setupShim();
  const { createSemanticsMirror } = loadSemanticsMirror(c);
  const { host } = buildHostSkeleton(shim);
  const node = addAriaNode(shim, host, { id: 'n1', label: 'A', x: 0, y: 0, w: 10, h: 10 });

  const { setIntervalFn, clearIntervalFn } = makeFakeInterval();
  const calls = [];
  const mirror = createSemanticsMirror({ shim, setData: (p) => calls.push(p), setIntervalFn, clearIntervalFn });
  mirror.scan();
  mirror.scan();
  mirror.scan();
  assert.strictEqual(calls.length, 1, '内容没变,只应该 setData 一次');

  node.setAttribute('aria-label', 'B');
  mirror.scan();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].mpSemantics[0].label, 'B');

  mirror.scan();
  assert.strictEqual(calls.length, 2, '变化后再扫、内容又不变了,不应该再发');
});

test('上限:超过 500 条截断到前 500 条,且只警告一次', () => {
  const { c, shim } = setupShim();
  const { createSemanticsMirror } = loadSemanticsMirror(c);
  const { host } = buildHostSkeleton(shim);
  for (let i = 0; i < 520; i++) {
    addAriaNode(shim, host, { id: 'n' + i, label: 'L' + i, x: i, y: 0, w: 1, h: 1 });
  }

  const origWarn = console.warn;
  let warnCount = 0;
  console.warn = () => { warnCount++; };
  try {
    const { setIntervalFn, clearIntervalFn } = makeFakeInterval();
    const calls = [];
    const mirror = createSemanticsMirror({ shim, setData: (p) => calls.push(p), setIntervalFn, clearIntervalFn });
    mirror.scan();
    mirror.scan(); // 第二次扫描(数据没变)不应该重复警告
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mpSemantics.length, 500);
    assert.strictEqual(warnCount, 1);
  } finally {
    console.warn = origWarn;
  }
});

test('start() 按 500ms 间隔调度扫描,stop() 之后不再扫描', () => {
  const { c, shim } = setupShim();
  const { createSemanticsMirror } = loadSemanticsMirror(c);
  const { host } = buildHostSkeleton(shim);
  addAriaNode(shim, host, { id: 'n1', label: 'A', x: 0, y: 0, w: 10, h: 10 });

  const { setIntervalFn, clearIntervalFn, fire } = makeFakeInterval();
  const calls = [];
  const mirror = createSemanticsMirror({ shim, setData: (p) => calls.push(p), setIntervalFn, clearIntervalFn });
  mirror.start();
  assert.strictEqual(calls.length, 1, 'start() 自己先扫一次');

  mirror.stop();
  fire(); // 定时器已被 clear,不应该再触发
  assert.strictEqual(calls.length, 1);
});

test('空语义树:host 下没有任何 flt-semantics 节点时,首次扫描仍上报一次空数组,此后不再重复', () => {
  const { c, shim } = setupShim();
  const { createSemanticsMirror } = loadSemanticsMirror(c);
  buildHostSkeleton(shim); // 只有 host 自己,还没有任何真正的语义节点

  const { setIntervalFn, clearIntervalFn } = makeFakeInterval();
  const calls = [];
  const mirror = createSemanticsMirror({ shim, setData: (p) => calls.push(p), setIntervalFn, clearIntervalFn });
  mirror.scan();
  mirror.scan();
  assert.strictEqual(calls.length, 1, '"没有语义节点"本身也是一次状态,只应上报一次');
  assert.strictEqual(calls[0].mpSemantics.length, 0);
});

test('还没 boot 完成(host 尚不存在)时扫描直接跳过,不抛错也不 setData', () => {
  const { c, shim } = setupShim();
  const { createSemanticsMirror } = loadSemanticsMirror(c);
  // 故意不建任何骨架。

  const { setIntervalFn, clearIntervalFn } = makeFakeInterval();
  const calls = [];
  const mirror = createSemanticsMirror({ shim, setData: (p) => calls.push(p), setIntervalFn, clearIntervalFn });
  assert.doesNotThrow(() => mirror.scan());
  assert.strictEqual(calls.length, 0);
});
