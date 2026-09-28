const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');

const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

function setup() {
  const c = createMpContext();
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({ canvas: c.canvas, width: 390, height: 844, dpr: 3 });
  const view = shim.document.createElement('flutter-view');
  shim.document.body.append(view);
  const got = [];
  // 修复轮 1 Minor 1:调用一次 getModifierState('Shift') —— 之前 rec() 从不
  // 调它,测不出 bom-shim 缺这个方法的阻断性缺陷(见 shim.test.js 里的
  // getModifierState 专项单测)。这里如果该方法缺失/报错,dispatchEvent 的
  // try/catch 会吞掉这次 push,导致 got 数组缺条目,让下面几乎所有断言失败。
  const rec = (where) => (e) => got.push({ where, type: e.type, id: e.pointerId, x: e.offsetX, y: e.offsetY,
    buttons: e.buttons, target: e.target === view ? 'view' : 'other', isPE: e instanceof shim.window.PointerEvent,
    ptype: e.pointerType, mod: e.getModifierState('Shift') });
  view.addEventListener('pointerdown', rec('view'));
  view.addEventListener('pointercancel', rec('view'));
  shim.window.addEventListener('pointermove', rec('window'));
  shim.window.addEventListener('pointerup', rec('window'));
  const { createTouchBridge } = c.requireModule(path.join(RT, 'touch-bridge.js'));
  const bridge = createTouchBridge({ shim, cssWidth: 390 });
  return { bridge, got };
}
const T = (identifier, x, y) => ({ identifier, x, y });

test('单指点击:down 发到 flutter-view,up 发到 window;都是 PointerEvent,target 为 flutter-view', () => {
  const { bridge, got } = setup();
  bridge.handle({ type: 'touchstart', timeStamp: 1, changedTouches: [T(0, 10, 20)], touches: [T(0, 10, 20)] });
  bridge.handle({ type: 'touchend', timeStamp: 2, changedTouches: [T(0, 10, 20)], touches: [] });
  assert.deepStrictEqual(got.map((g) => [g.where, g.type, g.target, g.isPE, g.ptype]), [
    ['view', 'pointerdown', 'view', true, 'touch'],
    ['window', 'pointerup', 'view', true, 'touch'],
  ]);
  assert.deepStrictEqual([got[0].x, got[0].y, got[0].buttons], [10, 20, 1]);
  assert.strictEqual(got[1].buttons, 0);
});

test('拖动:move 发到 window 并带当前坐标', () => {
  const { bridge, got } = setup();
  bridge.handle({ type: 'touchstart', timeStamp: 1, changedTouches: [T(3, 100, 100)], touches: [T(3, 100, 100)] });
  bridge.handle({ type: 'touchmove', timeStamp: 2, changedTouches: [T(3, 100, 160)], touches: [T(3, 100, 160)] });
  const mv = got.find((g) => g.type === 'pointermove');
  assert.deepStrictEqual([mv.where, mv.y, mv.buttons], ['window', 160, 1]);
});

test('两指交错按下抬起:pointerId 互不相同,抬起一指不影响另一指', () => {
  const { bridge, got } = setup();
  bridge.handle({ type: 'touchstart', timeStamp: 1, changedTouches: [T(0, 10, 10)], touches: [T(0, 10, 10)] });
  bridge.handle({ type: 'touchstart', timeStamp: 2, changedTouches: [T(1, 200, 10)], touches: [T(0, 10, 10), T(1, 200, 10)] });
  bridge.handle({ type: 'touchend', timeStamp: 3, changedTouches: [T(0, 10, 10)], touches: [T(1, 200, 10)] });
  bridge.handle({ type: 'touchmove', timeStamp: 4, changedTouches: [T(1, 220, 10)], touches: [T(1, 220, 10)] });
  const downs = got.filter((g) => g.type === 'pointerdown');
  assert.notStrictEqual(downs[0].id, downs[1].id);
  const up = got.find((g) => g.type === 'pointerup');
  assert.strictEqual(up.id, downs[0].id);
  const mv = got.find((g) => g.type === 'pointermove');
  assert.deepStrictEqual([mv.id, mv.x], [downs[1].id, 220]);
});

test('touchcancel → pointercancel(发到 flutter-view),不再发 pointerup', () => {
  const { bridge, got } = setup();
  bridge.handle({ type: 'touchstart', timeStamp: 1, changedTouches: [T(0, 10, 10)], touches: [T(0, 10, 10)] });
  bridge.handle({ type: 'touchcancel', timeStamp: 2, changedTouches: [T(0, 10, 10)], touches: [] });
  assert.deepStrictEqual(got.map((g) => g.type), ['pointerdown', 'pointercancel']);
  assert.strictEqual(got[1].where, 'view');
});

test('坐标换算:innerWidth 与 CSS 宽度不同单位时按比例换算', () => {
  const c = createMpContext();
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({ canvas: c.canvas, width: 1170, height: 2532, dpr: 3 });  // innerWidth 为物理像素
  const view = shim.document.createElement('flutter-view');
  shim.document.body.append(view);
  let x = null;
  view.addEventListener('pointerdown', (e) => { x = e.offsetX; });
  const { createTouchBridge } = c.requireModule(path.join(RT, 'touch-bridge.js'));
  createTouchBridge({ shim, cssWidth: 390 }).handle({ type: 'touchstart', timeStamp: 1, changedTouches: [T(0, 100, 0)], touches: [] });
  assert.strictEqual(x, 300);
});

test('引擎还没注册 pointerdown(启动未完成)时丢弃事件而不是抛错', () => {
  const c = createMpContext();
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({ canvas: c.canvas, width: 390, height: 844, dpr: 3 });
  const { createTouchBridge } = c.requireModule(path.join(RT, 'touch-bridge.js'));
  assert.doesNotThrow(() => createTouchBridge({ shim, cssWidth: 390 })
    .handle({ type: 'touchstart', timeStamp: 1, changedTouches: [T(0, 1, 1)], touches: [] }));
});

test('x/y 缺失(miniprogram-automator 驱动 E2E 时的真实情况)回退用 clientX/clientY', () => {
  const { bridge, got } = setup();
  bridge.handle({
    type: 'touchstart', timeStamp: 1,
    changedTouches: [{ identifier: 0, clientX: 30, clientY: 40 }],
    touches: [{ identifier: 0, clientX: 30, clientY: 40 }],
  });
  assert.deepStrictEqual([got[0].x, got[0].y], [30, 40]);
});

// 修复轮 1 Minor 3:x/y 与 clientX/clientY 都缺时,不产生 NaN 坐标,丢弃该
// 触点并 console.warn 一次说明缺坐标。
test('x/y 与 clientX/clientY 都缺时:丢弃该触点、警告一次,不派发任何事件', () => {
  const { bridge, got } = setup();
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    bridge.handle({
      type: 'touchstart', timeStamp: 1,
      changedTouches: [{ identifier: 0 }],
      touches: [{ identifier: 0 }],
    });
  } finally {
    console.warn = origWarn;
  }
  assert.deepStrictEqual(got, []);
  assert.strictEqual(warnings.length, 1);
});

// 修复轮 1 Minor 2:同一 identifier 连续两次 touchstart(小程序偶发漏报
// touchend/touchcancel)时,覆盖映射前先对旧 pointerId 补发 pointercancel,
// 不能让引擎里残留"按下"状态。
test('同一 identifier 重复 touchstart:覆盖前先对旧 pointerId 发 pointercancel', () => {
  const { bridge, got } = setup();
  bridge.handle({ type: 'touchstart', timeStamp: 1, changedTouches: [T(0, 10, 10)], touches: [T(0, 10, 10)] });
  bridge.handle({ type: 'touchstart', timeStamp: 2, changedTouches: [T(0, 50, 60)], touches: [T(0, 50, 60)] });
  assert.deepStrictEqual(got.map((g) => [g.where, g.type]), [
    ['view', 'pointerdown'],
    ['view', 'pointercancel'],
    ['view', 'pointerdown'],
  ]);
  assert.strictEqual(got[1].id, got[0].id, 'pointercancel 用的是旧 pointerId');
  assert.notStrictEqual(got[2].id, got[0].id, '新按下分配的是新 pointerId');
});

// 修复轮 1 Minor 2:cancelAll —— 承载页 onHide 用它清理所有活跃指针。
test('cancelAll:对所有活跃指针发 pointercancel 并清空,之后 touchend 不再发 pointerup', () => {
  const { bridge, got } = setup();
  bridge.handle({ type: 'touchstart', timeStamp: 1, changedTouches: [T(0, 10, 10)], touches: [T(0, 10, 10)] });
  bridge.handle({ type: 'touchstart', timeStamp: 2, changedTouches: [T(1, 200, 10)], touches: [T(0, 10, 10), T(1, 200, 10)] });
  bridge.cancelAll(999);
  const cancels = got.filter((g) => g.type === 'pointercancel');
  assert.strictEqual(cancels.length, 2);
  assert.deepStrictEqual(cancels.map((c) => c.where), ['view', 'view']);
  const before = got.length;
  bridge.handle({ type: 'touchend', timeStamp: 3, changedTouches: [T(0, 10, 10)], touches: [] });
  bridge.handle({ type: 'touchend', timeStamp: 4, changedTouches: [T(1, 200, 10)], touches: [] });
  assert.strictEqual(got.length, before, 'cancelAll 之后活跃指针已清空,touchend 不应再派发任何事件');
});

// 修复轮 1 Minor 7:多个元素都注册过 pointerdown 监听器时(例如未来的插件/
// 平台视图),必须优先派发给 flutter-view,不能简单地"取最后注册的一个"。
test('多个元素注册过 pointerdown 时优先派发给 flutter-view', () => {
  const c = createMpContext();
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({ canvas: c.canvas, width: 390, height: 844, dpr: 3 });
  const before = shim.document.createElement('div');
  shim.document.body.append(before);
  before.addEventListener('pointerdown', () => {});
  const view = shim.document.createElement('flutter-view');
  shim.document.body.append(view);
  const got = [];
  view.addEventListener('pointerdown', (e) => got.push(e.target === view ? 'view' : 'other'));
  const after = shim.document.createElement('div');
  shim.document.body.append(after);
  after.addEventListener('pointerdown', () => {});
  const { createTouchBridge } = c.requireModule(path.join(RT, 'touch-bridge.js'));
  createTouchBridge({ shim, cssWidth: 390 })
    .handle({ type: 'touchstart', timeStamp: 1, changedTouches: [T(0, 10, 10)], touches: [T(0, 10, 10)] });
  assert.deepStrictEqual(got, ['view']);
});
