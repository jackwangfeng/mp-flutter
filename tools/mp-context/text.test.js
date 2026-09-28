const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');

const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

function setup() {
  const c = createMpContext();
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({ canvas: c.canvas, width: 390, height: 844, dpr: 3 });
  const host = shim.document.createElement('flt-text-editing-host');
  shim.document.body.append(host);
  const states = [];
  const { createTextBridge } = c.requireModule(path.join(RT, 'text-bridge.js'));
  const bridge = createTextBridge({ shim, cssWidth: 390, onState: (s) => states.push(s) });
  // 模拟引擎:建 input、挂到 host、给几何、聚焦
  function engineInput(tag = 'input') {
    const el = shim.document.createElement(tag);
    host.append(el);
    el.style.setProperty('position', 'absolute');
    el.style.setProperty('top', '0');
    el.style.setProperty('left', '0');
    el.style.setProperty('width', '342px');
    el.style.setProperty('height', '24px');
    el.style.setProperty('transform', 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,24,120,0,1)');
    el.style.setProperty('font', 'normal 16px "Roboto"');
    const events = [];
    ['input', 'keydown', 'blur'].forEach((t) => el.addEventListener(t, (e) => events.push(t + (e.keyCode ? ':' + e.keyCode : ''))));
    return { el, events };
  }
  return { bom, shim, bridge, states, engineInput, last: () => states[states.length - 1] };
}

test('引擎聚焦输入框:桥给出可见状态与 CSS 像素几何', async () => {
  const { bridge, engineInput, last } = setup();
  const { el } = engineInput();
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  const s = last();
  assert.strictEqual(s.visible, true);
  assert.strictEqual(s.multiline, false);
  assert.deepStrictEqual([s.left, s.top, s.width, s.height, s.fontSize], [24, 120, 342, 24, 16]);
  assert.strictEqual(s.focus, true);
  bridge.dispose();
});

test('iOS 策略把元素放在 -9999px 期间视为几何未就绪,不显示原生框', async () => {
  const { bridge, engineInput, last } = setup();
  const { el } = engineInput();
  el.style.setProperty('top', '-9999px');
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(last() ? last().visible : false, false);
  bridge.dispose();
});

test('原生输入 → 引擎元素的 value/selection,并派发 input', async () => {
  const { bridge, engineInput } = setup();
  const { el, events } = engineInput();
  el.focus();
  bridge.nativeInput({ value: 'hello世界😀', cursor: 9 });
  assert.strictEqual(el.value, 'hello世界😀');
  assert.deepStrictEqual([el.selectionStart, el.selectionEnd], [9, 9]);
  assert.deepStrictEqual(events, ['input']);
  bridge.dispose();
});

test('代理对光标:光标按 UTF-16 码元,越界时截到末尾', () => {
  const { bridge, engineInput } = setup();
  const { el } = engineInput();
  el.focus();
  bridge.nativeInput({ value: '世界😀', cursor: 99 });
  assert.strictEqual(el.selectionStart, 4);
  bridge.dispose();
});

test('回写不覆盖正在组字的原生值:引擎值等于上次原生值时不推送 value', async () => {
  const { bridge, engineInput, states } = setup();
  const { el } = engineInput();
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  bridge.nativeInput({ value: 'ni', cursor: 2 });
  const before = states.length;
  await new Promise((r) => setTimeout(r, 50));
  const pushed = states.slice(before).filter((s) => s.value !== undefined && s.value !== 'ni');
  assert.deepStrictEqual(pushed, [], '引擎侧值未变时不应推送与原生不同的 value');
  el.value = 'NI';                       // 引擎主动改值(比如格式化)→ 必须推给原生
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(states[states.length - 1].value, 'NI');
  bridge.dispose();
});

test('原生确认键 → 引擎收到 keyCode 13 的 KeyboardEvent', () => {
  const { shim, bridge, engineInput } = setup();
  const { el } = engineInput();
  let isKE = false;
  el.addEventListener('keydown', (e) => { isKE = e instanceof shim.window.KeyboardEvent; });
  el.focus();
  bridge.nativeConfirm();
  assert.strictEqual(isKE, true);
  bridge.dispose();
});

test('引擎 blur 后桥状态为隐藏(失焦不能留下看不见的原生框)', async () => {
  const { bridge, engineInput, last } = setup();
  const { el } = engineInput();
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  el.blur();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(last().visible, false);
  bridge.dispose();
});

test('原生 blur → 引擎元素 blur(relatedTarget 为 null)', () => {
  const { bridge, engineInput } = setup();
  const { el, events } = engineInput();
  el.focus();
  bridge.nativeBlur();
  assert.ok(events.indexOf('blur') >= 0);
  bridge.dispose();
});

test('textarea → multiline 状态', async () => {
  const { bridge, engineInput, last } = setup();
  const { el } = engineInput('textarea');
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(last().multiline, true);
  bridge.dispose();
});

// 以下两例来自开发者工具里对引擎的实测(IOSTextEditingStrategy):离屏阶段是
// transform: translate(-9999px, -9999px)(top/left 仍为 0),几何就绪后是 2D 的
// matrix(a,b,c,d,e,f),不是 matrix3d。
test('实测:iOS 策略用 translate(-9999px,-9999px) 离屏时不显示原生框', async () => {
  const { bridge, engineInput, last } = setup();
  const { el } = engineInput();
  el.style.setProperty('width', '');
  el.style.setProperty('height', '');
  el.style.setProperty('transform', 'translate(-9999px, -9999px)');
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(last() ? last().visible : false, false);
  bridge.dispose();
});

test('实测:引擎用 2D matrix(...) 定位,取第 5、6 个分量为平移', async () => {
  const { bridge, engineInput, last } = setup();
  const { el } = engineInput();
  el.style.setProperty('width', '358px');
  el.style.setProperty('transform', 'matrix(1, 0, 0, 1, 16, 28)');
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  const s = last();
  assert.strictEqual(s.visible, true);
  assert.deepStrictEqual([s.left, s.top, s.width, s.height], [16, 28, 358, 24]);
  bridge.dispose();
});

// 实测:轮询读 el.type / el.inputMode(垫片元素上未定义)会被垫片记成"触达未实现 API",
// 每 16ms 一次,污染 accept.js 的垫片覆盖基线比对。
test('轮询不触达元素上未定义的属性(不污染垫片覆盖上报)', async () => {
  const { bom, bridge, engineInput } = setup();
  const { el } = engineInput();
  el.focus();
  await new Promise((r) => setTimeout(r, 50));
  bridge.dispose();
  // report() 返回的是 vm 上下文里的数组,跨 realm 不能 deepStrictEqual
  const bad = Array.from(bom.report()).filter((l) => /input<el>\.(type|inputMode)\b/.test(l));
  assert.strictEqual(bad.join('; '), '');
});

test('引擎把 type 设为 password → password 状态', async () => {
  const { bridge, engineInput, last } = setup();
  const { el } = engineInput();
  el.type = 'password';
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  bridge.dispose();
  assert.strictEqual(last().password, true);
});

test('inputmode=numeric 特性 → number 键盘', async () => {
  const { bridge, engineInput, last } = setup();
  const { el } = engineInput();
  el.setAttribute('inputmode', 'numeric');
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  bridge.dispose();
  assert.strictEqual(last().type, 'number');
});

// ---- 修复轮 1(I-1):引擎在聚焦期间清空/改回某值必须真正到达原生框 ----
test('引擎把值清空为 \'\' 时推送 \'\'', async () => {
  const { bridge, engineInput, last } = setup();
  const { el } = engineInput();
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  bridge.nativeInput({ value: 'hello世界😀', cursor: 9 });
  await new Promise((r) => setTimeout(r, 30));
  el.value = '';                                   // onSubmitted 里 controller.clear()
  await new Promise((r) => setTimeout(r, 30));
  bridge.dispose();
  assert.strictEqual(last().value, '');
});

test('引擎清空后又改回上次原生值:仍推送(原生框此时是空的)', async () => {
  const { bridge, engineInput, last } = setup();
  const { el } = engineInput();
  el.focus();
  bridge.nativeInput({ value: 'hello', cursor: 5 });
  await new Promise((r) => setTimeout(r, 30));
  el.value = '';
  await new Promise((r) => setTimeout(r, 30));
  el.value = 'hello';                              // 比如撤销清空
  await new Promise((r) => setTimeout(r, 30));
  bridge.dispose();
  assert.strictEqual(last().value, 'hello');
});

// 视图层模型:按"最坏情况"模拟 —— 新值与视图层上次数据相同则不更新组件(diff 空操作),
// 原生框的实际值只随用户输入与真正生效的 value 写入而变。
function fakeView() {
  const view = { data: {}, native: '', writes: [] };
  view.setData = (patch, cb) => {
    Object.keys(patch).forEach((k) => {
      if (view.data[k] === patch[k]) return;      // diff:值未变 → 不更新组件
      view.data[k] = patch[k];
      if (k === 'mpInput.value') { view.native = patch[k]; view.writes.push(patch[k]); }
    });
    if (cb) setTimeout(cb, 0);
  };
  return view;
}

test('推送值等于页面上次推送值(但与原生值不同)时仍然生效', async () => {
  const c = createMpContext();
  const { createViewSync } = c.requireModule(path.join(RT, 'text-bridge.js'));
  const view = fakeView();
  const sync = createViewSync(view.setData);
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });      // 首次聚焦推 ''
  view.native = 'hello世界😀'; sync.nativeInput('hello世界😀');          // 用户输入,页面数据仍是 ''
  sync.apply({ visible: true, focus: true, cursor: 9 });
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });      // 引擎清空
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(view.native, '');
});

test('state 不带 value(输入法组字中)时不写原生值', async () => {
  const c = createMpContext();
  const { createViewSync } = c.requireModule(path.join(RT, 'text-bridge.js'));
  const view = fakeView();
  const sync = createViewSync(view.setData);
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });
  view.native = 'ni'; sync.nativeInput('ni');
  sync.apply({ visible: true, focus: true, cursor: 2 });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(view.native, 'ni');
  assert.strictEqual(view.writes.length, 1, '只有首次聚焦那一次 value 写入');
});

// ---- 修复轮 2 ----
// 带延迟回调的视图层:第一步写与回调之间可以插入新的 apply / 原生输入
function slowView(delay) {
  const view = { data: {}, native: '' };
  view.setData = (patch, cb) => {
    Object.keys(patch).forEach((k) => {
      if (view.data[k] === patch[k]) return;
      view.data[k] = patch[k];
      if (k === 'mpInput.value') view.native = patch[k];
    });
    if (cb) setTimeout(cb, delay);
  };
  return view;
}

test('两步写的回调过期(期间有新 apply)时放弃,页面数据为最新值', async () => {
  const c = createMpContext();
  const { createViewSync } = c.requireModule(path.join(RT, 'text-bridge.js'));
  const view = slowView(20);
  const sync = createViewSync(view.setData);
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });
  view.native = 'hello'; sync.nativeInput('hello');
  sync.apply({ visible: true, focus: true, cursor: 5 });
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });        // 引擎清空 → 两步写
  await new Promise((r) => setTimeout(r, 5));
  view.native = 'z'; sync.nativeInput('z');                                 // 回调之前用户又敲了 z
  sync.apply({ visible: true, focus: true, cursor: 1, value: 'z' });
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(view.data['mpInput.value'], 'z');
  assert.strictEqual(view.native, 'z');
});

test('两步写的回调之前只有原生输入(没有带 value 的 apply)时也放弃,不把新输入覆盖掉', async () => {
  const c = createMpContext();
  const { createViewSync } = c.requireModule(path.join(RT, 'text-bridge.js'));
  const view = slowView(20);
  const sync = createViewSync(view.setData);
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });
  view.native = 'hello'; sync.nativeInput('hello');
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });
  await new Promise((r) => setTimeout(r, 5));
  view.native = 'z'; sync.nativeInput('z');
  sync.apply({ visible: true, focus: true, cursor: 1 });
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(view.native, 'z');
  // 之后引擎把值改成页面数据里残留的中间值,也必须真正写到原生
  sync.apply({ visible: true, focus: true, cursor: 5, value: 'hello' });
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(view.native, 'hello');
});

test('程序化改值后仅移动光标(值不变):状态里不再带 value', async () => {
  const { bridge, engineInput, states } = setup();
  const { el } = engineInput();
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  bridge.nativeInput({ value: 'hello', cursor: 5 });
  await new Promise((r) => setTimeout(r, 30));
  el.value = 'HELLO';
  el.setSelectionRange(5, 5);
  await new Promise((r) => setTimeout(r, 30));
  const n = states.length;
  el.setSelectionRange(2, 2);
  await new Promise((r) => setTimeout(r, 30));
  el.setSelectionRange(3, 3);
  await new Promise((r) => setTimeout(r, 30));
  bridge.dispose();
  const after = states.slice(n);
  assert.ok(after.length >= 2, '光标移动应产生状态');
  assert.strictEqual(after.filter((s) => 'value' in s).length, 0);
  assert.strictEqual(after[after.length - 1].cursor, 3);
});

// ---- 修复轮 3:只有可能冲突的事件才使两步写失效 ----
test('两步写等待期间只来一次不带 value 的心跳 apply:第二步照常落地', async () => {
  const c = createMpContext();
  const { createViewSync } = c.requireModule(path.join(RT, 'text-bridge.js'));
  const view = slowView(20);
  const sync = createViewSync(view.setData);
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });
  view.native = 'hello'; sync.nativeInput('hello');
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });        // 引擎清空 → 两步写
  sync.apply({ visible: true, focus: true, cursor: 0, top: 30 });          // 心跳:只有几何变化
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(view.native, '');
  assert.strictEqual(view.data['mpInput.top'], 30);
});

test('两步写等待期间来了真实原生输入:过期写入放弃,之后引擎值与原生不同会重新推送', async () => {
  const c = createMpContext();
  const { createViewSync } = c.requireModule(path.join(RT, 'text-bridge.js'));
  const view = slowView(20);
  const sync = createViewSync(view.setData);
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });
  view.native = 'hello'; sync.nativeInput('hello');
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });
  await new Promise((r) => setTimeout(r, 5));
  view.native = 'hellox'; sync.nativeInput('hellox');                      // 用户在回调前又敲了 x
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(view.native, 'hellox', '过期的清空不应覆盖新输入');
  sync.apply({ visible: true, focus: true, cursor: 0, value: '' });        // 引擎仍要清空
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(view.native, '');
  assert.strictEqual(view.data['mpInput.value'], '');
});

test('每次新的聚焦元素递增 session,状态里带上它', async () => {
  const { bridge, engineInput, last } = setup();
  const a = engineInput();
  a.el.focus();
  await new Promise((r) => setTimeout(r, 30));
  const s1 = last().session;
  const b = engineInput();
  b.el.focus();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(typeof s1, 'number');
  assert.strictEqual(last().session, s1 + 1);
  bridge.dispose();
});

test('焦点 A→B 后迟到的 A 框 blur(旧 session)被丢弃,B 保持聚焦', async () => {
  const { shim, bridge, engineInput, last } = setup();
  const a = engineInput();
  a.el.focus();
  await new Promise((r) => setTimeout(r, 30));
  const sa = last().session;
  const b = engineInput();
  b.el.focus();
  await new Promise((r) => setTimeout(r, 30));
  bridge.nativeBlur(sa);                 // 被销毁的 A 框的 blur 晚到
  assert.deepStrictEqual(b.events.filter((e) => e === 'blur'), []);
  assert.strictEqual(shim.document.activeElement, b.el);
  // WXML dataset 可能给字符串:同值的当前会话照常转发
  bridge.nativeBlur(String(last().session));
  assert.deepStrictEqual(b.events.filter((e) => e === 'blur'), ['blur']);
  bridge.dispose();
});

test('桥创建前引擎已聚焦的输入框:创建时直接接管', async () => {
  const c = createMpContext();
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({ canvas: c.canvas, width: 390, height: 844, dpr: 3 });
  const el = shim.document.createElement('input');
  shim.document.body.append(el);
  el.style.setProperty('width', '342px');
  el.style.setProperty('height', '24px');
  el.focus();
  const states = [];
  const { createTextBridge } = c.requireModule(path.join(RT, 'text-bridge.js'));
  const bridge = createTextBridge({ shim, cssWidth: 390, onState: (s) => states.push(s) });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(states[states.length - 1].visible, true);
  bridge.nativeInput({ value: 'ab', cursor: 2 });
  assert.strictEqual(el.value, 'ab');
  bridge.dispose();
});

test('pause 停掉轮询,resume 恢复并立即同步', async () => {
  const { bridge, engineInput, states, last } = setup();
  const { el } = engineInput();
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  bridge.pause();
  const n = states.length;
  el.style.setProperty('width', '100px');      // 暂停期间几何变化不应上报
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(states.length, n);
  bridge.resume();
  assert.strictEqual(last().width, 100);
  el.style.setProperty('width', '200px');      // 恢复后轮询继续
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(last().width, 200);
  bridge.dispose();
});

// ---- I3 修复:--semantics-mirror 打开、语义树激活后,SemanticsTextEditingStrategy
// 把 <input> 挂进它自己的 <flt-semantics> 节点(自身 left/top 恒为 0、无
// transform),真正的位置来自这条祖先链,一路累加到 <flt-semantics-host> 的
// scale(1/dpr)。见 text-bridge.js 文件头"I3 修复"一节与 semantics-mirror.js
// 的 computeRect(同一套引擎约定)。
test('I3:语义树激活后,<input> 位置来自 <flt-semantics> 祖先链而不是自己的 left/top', async () => {
  const { shim, bridge, states } = setup();
  // 祖先链:flt-semantics-host(scale(1/3),对应 dpr=3) > flt-semantics(外层
  // 分组,自己有一段平移,模拟滚动容器) > flt-semantics(文本框自身节点,
  // SemanticsObject.recomputePositionAndSize 写的 transform) > input(自身
  // left:0;top:0,SemanticTextField._initializeEditableElement 的约定)。
  const semHost = shim.document.createElement('flt-semantics-host');
  semHost.style.setProperty('transform', 'scale(0.3333333333333333)');
  shim.document.body.append(semHost);
  const group = shim.document.createElement('flt-semantics');
  group.style.setProperty('transform', 'matrix(1,0,0,1,30,60)'); // 物理像素
  semHost.append(group);
  const field = shim.document.createElement('flt-semantics');
  field.style.setProperty('transform', 'matrix(1,0,0,1,42,120)'); // 物理像素
  group.append(field);
  const el = shim.document.createElement('input');
  el.style.setProperty('position', 'absolute');
  el.style.setProperty('top', '0');
  el.style.setProperty('left', '0');
  el.style.setProperty('width', '1026px');  // 物理像素(342 逻辑 * dpr 3)
  el.style.setProperty('height', '72px');   // 物理像素(24 逻辑 * dpr 3)
  field.append(el);

  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  const s = states[states.length - 1];
  assert.strictEqual(s.visible, true);
  // (30+42)*1/3 = 24;(60+120)*1/3 = 60;宽高同样按 1/3 换算回逻辑像素。
  assert.deepStrictEqual([s.left, s.top, s.width, s.height], [24, 60, 342, 24]);
  bridge.dispose();
});

test('I3:标准场景(无 flt-semantics-host 祖先)不受影响,行为与修复前一致', async () => {
  const { bridge, engineInput, last } = setup();
  const { el } = engineInput();
  el.focus();
  await new Promise((r) => setTimeout(r, 30));
  const s = last();
  assert.deepStrictEqual([s.left, s.top, s.width, s.height, s.fontSize], [24, 120, 342, 24, 16]);
  bridge.dispose();
});

test('暂停期间发生的焦点切换不启动定时器,resume 后才轮询', async () => {
  const { bridge, engineInput, states, last } = setup();
  bridge.pause();
  const { el } = engineInput();
  el.focus();                                   // 焦点通知本身同步 tick 一次
  const n = states.length;
  el.style.setProperty('width', '100px');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(states.length, n);
  bridge.resume();
  assert.strictEqual(last().width, 100);
  bridge.dispose();
});
