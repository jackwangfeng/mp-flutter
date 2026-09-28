const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');

const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

/**
 * 建出与真实引擎一致的两棵树(dom_manager.dart / 探针文档 §2,2026-09-27
 * 评审修复轮 1 订正——占位 div 不与 flt-platform-view-slot 同树,中间隔着
 * flt-glass-pane 的 shadow root 边界):
 *
 *   轻量 DOM: flutter-view > flt-glass-pane > flt-platform-view[slot=name] >
 *             div[data-mp-native]
 *   影子 DOM(glassPane.attachShadow() 里): flt-scene > flt-clip* >
 *             flt-platform-view-slot > slot[name=name]
 *
 * `createGlassPane` 建一次(一个小程序只有一个 flutter-view/glass-pane),
 * `addPlatformView` 可以在同一个 glassPane 上调多次,给每个视图分配互不相同
 * 的 slot 名——这才是多个平台视图共存的真实拓扑(并列的兄弟子树,不是嵌套)。
 */
function createGlassPane(shim) {
  const flutterView = shim.document.createElement('flutter-view');
  shim.document.body.append(flutterView);
  const glassPane = shim.document.createElement('flt-glass-pane');
  flutterView.append(glassPane);
  const shadow = glassPane.attachShadow();
  const scene = shim.document.createElement('flt-scene');
  shadow.append(scene);
  return { flutterView, glassPane, scene };
}

let slotSeq = 0;
function addPlatformView(shim, gp, { clips, slotStyle, viewAttrs, slotName }) {
  const name = slotName || ('flt-pv-slot-' + (slotSeq++));
  const pv = shim.document.createElement('flt-platform-view');
  pv.setAttribute('slot', name);
  gp.glassPane.append(pv);
  const div = shim.document.createElement('div');
  Object.keys(viewAttrs || {}).forEach((k) => { div.setAttribute(k, viewAttrs[k]); });
  pv.append(div);

  let parent = gp.scene;
  const clipEls = [];
  (clips || []).forEach((c) => {
    const clip = shim.document.createElement('flt-clip');
    Object.keys(c).forEach((k) => { clip.style[k] = c[k]; });
    parent.appendChild(clip);
    clipEls.push(clip);
    parent = clip;
  });
  const slotWrap = shim.document.createElement('flt-platform-view-slot');
  Object.keys(slotStyle || {}).forEach((k) => { slotWrap.style[k] = slotStyle[k]; });
  parent.appendChild(slotWrap);
  const slotTag = shim.document.createElement('slot');
  slotTag.setAttribute('name', name);
  slotWrap.appendChild(slotTag);

  // clipEls 顺序改成"最内层在前"(与探针文档习惯一致),但内部实现自己用
  // "最外层在前"处理——这里都提供,方便测试按需引用。
  return { pv, div, slotWrap, slotTag, clipsInner2Outer: clipEls.slice().reverse(), clipsOuter2Inner: clipEls };
}

/** 单视图场景的便捷写法:自己建一个独占的 glass-pane。 */
function buildFixture(shim, opts) {
  const gp = createGlassPane(shim);
  return Object.assign({ gp }, addPlatformView(shim, gp, opts));
}

function setupShim(opts) {
  const c = createMpContext(opts);
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({ canvas: c.canvas, width: 390, height: 844, dpr: 3 });
  return { c, shim };
}

function makeRaf() {
  const queue = [];
  return {
    raf: (cb) => { queue.push(cb); },
    // 手动推进一帧:取出当前排队的回调并执行(执行中会再排一个新的进去,
    // 模拟真实 requestAnimationFrame 链式调度)。
    tick() { const cb = queue.shift(); if (cb) cb(); },
  };
}

function loadNativeViews(c) {
  return c.requireModule(path.join(RT, 'native-views.js'));
}

test('单视图(1 层 flt-clip):算出的 left/top/width/height 与探针实测的逻辑坐标一致', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  // 样式值取自探针文档 §2 的实测字符串(item 3,plain view,仅 Viewport 自带的
  // 1 层 flt-clip,slot 自身 transform 是 "none"):slot 390x200,clip 的
  // clip-path 是 Viewport 的可见带 rect(0px 390px 788px 0px),transform 最终
  // 写成 matrix(3,0,0,3,0,168) —— 168/3==56 才是真实的逻辑偏移(探针文档
  // 已验证的不变量,只在"最外层"这一层需要除法)。
  buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(3,0,0,3,0,168)' }],
    slotStyle: { width: '390px', height: '200px', position: 'absolute', transform: 'none', opacity: '1' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'v1', 'data-mp-params': '{}' },
  });

  const calls = [];
  const { raf, tick } = makeRaf();
  createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });
  tick();

  assert.strictEqual(calls.length, 1, '首帧发现新视图,应该 setData 一次');
  const v1 = calls[0]['mpNative.v1'];
  assert.deepStrictEqual([v1.left, v1.top, v1.width, v1.height, v1.opacity, v1.hidden, v1.clip],
    [0, 56, 390, 200, 1, false, null]);
  assert.deepStrictEqual(calls[0].mpNativeList, ['v1']);
});

test('评审复现(C2):最外层与 slot 自身的平移都要累加,不能只读最外层', () => {
  // 外层 flt-clip 的 matrix(1,0,0,1,0,56)(a=d=1,不需要归一化也得 56)+
  // slot 自身的 matrix(1,0,0,1,0,300)(单层裁剪时,滚动偏移经常就落在 slot
  // 这一层——探针 §4 的结论)应该累加成 top=356,而不是只读最外层的 56。
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,56)' }],
    slotStyle: { width: '390px', height: '200px', opacity: '1', transform: 'matrix(1,0,0,1,0,300)' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'v0', 'data-mp-params': '{}' },
  });
  const calls = [];
  const { raf, tick } = makeRaf();
  createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });
  tick();
  assert.strictEqual(calls[0]['mpNative.v0'].top, 356);
});

test('滚动(改 slot 自身的 transform)后下一帧 setData 只含变化的几何 dot-path,且一帧一次', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const gp = createGlassPane(shim);
  const f1 = addPlatformView(shim, gp, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,56)' }],
    slotStyle: { width: '390px', height: '200px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'v1', 'data-mp-params': '{}' },
  });
  addPlatformView(shim, gp, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,300)' }],
    slotStyle: { width: '100px', height: '100px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'map', 'data-mp-id': 'v2', 'data-mp-params': '{}' },
  });

  const calls = [];
  const { raf, tick } = makeRaf();
  createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });
  tick();
  assert.deepStrictEqual(Object.keys(calls[0]).sort(), ['mpNative.v1', 'mpNative.v2', 'mpNativeList']);

  // 只改 v1 所在 slot 自身的 transform(单层裁剪时,滚动偏移落在这里——评审
  // 结论),v2 纹丝不动。外层 clip 的 56 保持不变,slot 自身从 0(none)变成
  // 300,累加后 top 应为 356。
  f1.slotWrap.style.transform = 'matrix(1,0,0,1,0,300)';
  tick();
  assert.strictEqual(calls.length, 2, '这一帧应该恰好触发一次 setData');
  const patch = calls[1];
  assert.deepStrictEqual(Object.keys(patch).sort(), [
    'mpNative.v1.clip', 'mpNative.v1.height', 'mpNative.v1.hidden', 'mpNative.v1.left',
    'mpNative.v1.opacity', 'mpNative.v1.top', 'mpNative.v1.type', 'mpNative.v1.width',
  ], 'I4:只发几何 dot-path,不含 v2、不含 v1.params、不含 mpNativeList(id 集合没变)');
  assert.strictEqual(patch['mpNative.v1.top'], 356);
});

test('静止:连续 10 帧零 setData', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(3,0,0,3,0,168)' }],
    slotStyle: { width: '390px', height: '200px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'v1', 'data-mp-params': '{}' },
  });
  const calls = [];
  const { raf, tick } = makeRaf();
  createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });
  tick();
  const before = calls.length;
  for (let i = 0; i < 10; i++) tick();
  assert.strictEqual(calls.length, before, '几何、params 都没变化,不应再有 setData');
});

test('ClipRRect(2 层 flt-clip,评审结论:滚动偏移落在内层裁剪上):clip.radius 取自 round R;部分滚出裁剪;完全滚出 hidden:true', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  // 外层(Viewport 可见带,固定不随内容滚动)复用单视图用例里验证过的实测
  // matrix(3,0,0,3,0,168)/rect(0px 390px 788px 0px);内层(widget 自己的
  // ClipRRect(24),局部坐标不随滚动变化)clip-path 取自探针文档 §2 的实测
  // 字符串 rect(0px 390px 200px 0px round 24px);内层 transform 的具体数值
  // 探针文档没有给出"稳定帧"的确切值(§4 只记录了滚动过程中连续变化的中间
  // 值),这里按评审结论(滚动偏移落在内层)构造一个整数平移量,不追求与
  // 探针某一帧字面吻合,只验证"内层平移被正确读取并累加"这件事本身。
  const gp = createGlassPane(shim);
  const f = addPlatformView(shim, gp, {
    clips: [
      { 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(3,0,0,3,0,168)' }, // 外层:Viewport
      { 'clip-path': 'rect(0px 390px 200px 0px round 24px)', transform: 'matrix(1,0,0,1,0,44)' }, // 内层:ClipRRect(24)
    ],
    slotStyle: { width: '390px', height: '200px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'v5', 'data-mp-params': '{}' },
  });
  const innerClip = f.clipsOuter2Inner[1];

  const calls = [];
  const { raf, tick } = makeRaf();
  createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });
  tick();
  let v5 = calls[calls.length - 1]['mpNative.v5'];
  // top = 168/3(外层归一化) + 44(内层原样) = 56 + 44 = 100
  assert.deepStrictEqual([v5.left, v5.top, v5.width, v5.height, v5.hidden], [0, 100, 390, 200, false]);
  assert.ok(v5.clip, '存在圆角时即使没被裁掉也要给出 clip(用于 border-radius)');
  assert.deepStrictEqual([v5.clip.left, v5.clip.top, v5.clip.width, v5.clip.height, v5.clip.radius],
    [0, 100, 390, 200, 24]);

  // 部分滚出:内层平移加大到 644,item top = 56+644=700,item 占 700..900,
  // 与外层可见带(56..844,即 rect(...) 平移 56 之后的 0..788)相交出 700..844。
  // v5 不是第一次出现了(I4:后续帧只发变化的几何 dot-path,不再是整个对象)。
  innerClip.style.transform = 'matrix(1,0,0,1,0,644)';
  tick();
  let patch = calls[calls.length - 1];
  assert.strictEqual(patch['mpNative.v5.hidden'], false);
  assert.deepStrictEqual([patch['mpNative.v5.clip'].top, patch['mpNative.v5.clip'].height], [700, 144]);

  // 完全滚出:内层平移加大到 900,item top=56+900=956,item 占 956..1156,
  // 与外层可见带 56..844 已经没有交集。
  innerClip.style.transform = 'matrix(1,0,0,1,0,900)';
  tick();
  patch = calls[calls.length - 1];
  assert.strictEqual(patch['mpNative.v5.hidden'], true);
});

test('占位元素移除(div 从 DOM 摘除):该 id 从 mpNative 删除,列表重建', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const f = buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '390px', height: '200px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'camera', 'data-mp-id': 'v9', 'data-mp-params': '{}' },
  });
  const calls = [];
  const { raf, tick } = makeRaf();
  createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });
  tick();
  assert.deepStrictEqual(calls[0].mpNativeList, ['v9']);

  f.div.remove();
  tick();
  const last = calls[calls.length - 1];
  assert.strictEqual(last['mpNative.v9'], null);
  assert.deepStrictEqual(last.mpNativeList, []);
});

test('data-mp-params 变化:下一帧只发 params 这条 dot-path,不带几何字段', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const f = buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '390px', height: '200px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'v3', 'data-mp-params': '{"src":"a.mp4"}' },
  });
  const calls = [];
  const { raf, tick } = makeRaf();
  createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });
  tick();
  assert.deepStrictEqual(calls[0]['mpNative.v3'].params, { src: 'a.mp4' });

  f.div.setAttribute('data-mp-params', '{"src":"b.mp4"}');
  tick();
  const patch = calls[calls.length - 1];
  assert.deepStrictEqual(Object.keys(patch), ['mpNative.v3.params']);
  assert.deepStrictEqual(patch['mpNative.v3.params'], { src: 'b.mp4' });
});

test('裁剪祖先超过 2 层:退化为只按最内层裁剪,忽略更深祖先的 clip-path,但平移量仍按全部层数累加,并只 warn 一次', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  buildFixture(shim, {
    clips: [
      // 外→内传入:outer/middle 都给一个"几乎不裁"的大范围,真正生效的应该
      // 只有最内层(高度 50,远小于 slot 的 200)——如果 outer/middle 被误用,
      // 断言的裁剪高度就不会是 50;outer/middle 的平移(100+50)仍必须计入
      // 最终位置(150),否则说明"退化"错误地连平移也一起跳过了。
      { 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,100)' }, // 外层
      { 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,50)' },  // 中层
      { 'clip-path': 'rect(0px 390px 50px 0px)', transform: 'none' },                   // 内层:真正生效的
    ],
    slotStyle: { width: '390px', height: '200px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'vd', 'data-mp-params': '{}' },
  });
  const calls = [];
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const { raf, tick } = makeRaf();
    createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });
    tick();
  } finally {
    console.warn = origWarn;
  }
  const vd = calls[0]['mpNative.vd'];
  assert.strictEqual(vd.top, 150, '外层 100 + 中层 50 的平移必须计入,即使它们的 clip-path 被忽略');
  assert.deepStrictEqual([vd.clip.top, vd.clip.height], [150, 50],
    '应只按最内层(高度 50)裁剪,middle/outer 的大范围裁剪矩形被忽略');
  assert.strictEqual(warnings.filter((w) => w.includes('裁剪层级超过 2 层')).length, 1);
});

test('clip-path 是 path(...)(非矩形/非等半径):按奇偶位分 x/y 退化为包围盒,不抛错,只 warn 一次', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  buildFixture(shim, {
    clips: [{ 'clip-path': 'path("M0,10 L100,10 L100,90 L0,90 Z")', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '50px', height: '50px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'vp', 'data-mp-params': '{}' },
  });
  const calls = [];
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const { raf, tick } = makeRaf();
    assert.doesNotThrow(() => {
      createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });
      tick();
    });
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(calls.length, 1);
  // 包围盒按偶数位取 x(0,100,100,0→0..100)、奇数位取 y(10,10,90,90→10..90),
  // 不应该把 x/y 混在一起求出一个正方形。
  const vp = calls[0]['mpNative.vp'];
  assert.deepStrictEqual([vp.clip.left, vp.clip.top, vp.clip.width], [0, 10, 50]);
  assert.strictEqual(warnings.filter((w) => w.includes('path(...)')).length, 1);
});

test('找不到 flt-platform-view-slot(合成未完成/影子树还没挂):按隐藏处理,带 id 只 warn 一次,不影响其它 id', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const gp = createGlassPane(shim);
  // 故意不给这个视图建影子树里的 flt-platform-view-slot/slot 分支——模拟
  // "引擎还没来得及把这个平台视图合成进 flt-scene"的过渡态。
  const pv = shim.document.createElement('flt-platform-view');
  pv.setAttribute('slot', 'flt-pv-slot-missing');
  gp.glassPane.append(pv);
  const div = shim.document.createElement('div');
  div.setAttribute('data-mp-native', 'video');
  div.setAttribute('data-mp-id', 'vm');
  div.setAttribute('data-mp-params', '{}');
  pv.append(div);
  addPlatformView(shim, gp, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '10px', height: '10px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'map', 'data-mp-id': 'vok', 'data-mp-params': '{}' },
  });

  const calls = [];
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const { raf, tick } = makeRaf();
    createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });
    tick();
    tick(); // 第二帧:同一个 id 还是找不到,不应再重复 warn
  } finally {
    console.warn = origWarn;
  }
  const vm = calls[0]['mpNative.vm'];
  assert.deepStrictEqual([vm.hidden, vm.left, vm.top, vm.width, vm.height], [true, 0, 0, 0, 0]);
  assert.ok(calls[0]['mpNative.vok'], '找不到 slot 只影响这一个 id,不应该连累别的视图');
  assert.strictEqual(warnings.filter((w) => w.includes('vm')).length, 1, '同一个 id 只警告一次');
});

test('I2:连续空转超过宽限期后,rAF 循环自己停下来;register() 唤醒并给一段新的宽限期', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const calls = [];
  const rafCalls = [];
  const raf = (cb) => { rafCalls.push(cb); };
  const nv = createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });

  // 引擎首帧合成可能晚于同步层自己的第一帧 tick(真机/E2E 实测过的时序
  // 竞争),所以"发现是空的"不能只看一帧就停——要熬过一段宽限期(见
  // native-views.js 的 IDLE_GRACE_TICKS 注释)才真正认为这页没有原生视图。
  let ran = 0;
  while (rafCalls.length && ran < 1000) { rafCalls.shift()(); ran++; }
  assert.ok(ran > 1, '宽限期内应该不止跑一帧');
  assert.strictEqual(rafCalls.length, 0, '宽限期耗尽、始终没有视图也没有排队命令,循环应该停下来');

  nv.register('whatever');
  assert.strictEqual(rafCalls.length, 1, 'register() 应该唤醒循环,重新排一帧');
});

// 修复轮 2(2026-09-27 复审 Important,复现自 grace.test.js 的两个场景,
// 并入这里作回归)。

test('评审复现场景 1:宽限期内调 register()、引擎再过几帧才注入占位元素——不应该因为跨过旧的宽限期边界而永远发现不了', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const calls = [];
  const { raf, tick } = makeRaf();
  const nv = createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });

  // 修复前的 bug:register() 在循环"已经在跑"(scheduled 为真)时调
  // wake() 会被短路,emptyStreak 根本没重置——工厂在第 28 帧 register,
  // 引擎第 30 帧(跨过旧的 IDLE_GRACE_TICKS=30 边界)才真正把
  // flt-platform-view 合成进树,那时循环已经按旧逻辑停了,永远发现不了。
  for (let i = 0; i < 27; i++) tick();
  nv.register('late');
  for (let i = 0; i < 5; i++) tick();

  buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '10px', height: '10px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'late', 'data-mp-params': '{}' },
  });
  tick();

  assert.ok(calls.some((p) => p['mpNative.late']), '不应该因为跨过宽限期边界而永远发现不了这个 id');
});

test('评审复现场景 2(IndexedStack/Offstage):创建与 register 都发生在启动时,首次合成却远晚于宽限期——不应该被放弃', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const calls = [];
  const { raf, tick } = makeRaf();
  const nv = createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });

  // 例如底部多 Tab、第二个 Tab 放视频:IndexedStack 会在启动时就把所有
  // Tab 的 widget(含 HtmlElementView 工厂)都建一遍,但对应的
  // flt-platform-view 只有真正切到那个 Tab 时才会被引擎合成进树——这中间
  // 可能隔着用户看了很久别的 Tab,远超任何合理的宽限期。
  nv.register('tabvideo');
  for (let i = 0; i < 200; i++) tick(); // 远超旧的 30 帧宽限期

  buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '10px', height: '10px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'tabvideo', 'data-mp-params': '{}' },
  });
  tick();

  assert.ok(calls.some((p) => p['mpNative.tabvideo']));
});

test('unregister:从"已登记未发现"集合移除后,重新进入宽限期倒计时,最终仍会停止', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const rafCalls = [];
  const raf = (cb) => { rafCalls.push(cb); };
  const nv = createNativeViews({ shim, wx: {}, setData: () => {}, raf });

  nv.register('x');
  // 一直不出现,但只要还"已登记未发现",循环就不应该停(哪怕远超宽限期)。
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(rafCalls.length, 1, `第 ${i} 帧不应该已经停了`);
    rafCalls.shift()();
  }
  assert.strictEqual(rafCalls.length, 1, 'x 仍未发现,循环还在跑');

  nv.unregister('x');
  // 撤回登记之后重新进入宽限期倒计时,跑够宽限期帧数应该会停。
  let ran = 0;
  while (rafCalls.length && ran < 1000) { rafCalls.shift()(); ran++; }
  assert.strictEqual(rafCalls.length, 0, 'unregister 之后应该允许最终停止');

  nv.stop(); // 清掉低频轮询留下的定时器,避免真实 setTimeout 让测试进程挂起
});

test('预注册队列 __mpNativePending:__mpNative 还没挂上去之前工厂就 push 了 id,创建时应该原样接过来并清空该全局', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  shim.self.__mpNativePending = ['pre1', 'pre2'];
  const calls = [];
  const { raf, tick } = makeRaf();
  createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });

  assert.strictEqual(shim.self.__mpNativePending, undefined, '读完应该把这个全局清掉');

  // 远超宽限期都不应该停,因为两个 id 都在 awaiting 里。
  for (let i = 0; i < 100; i++) tick();

  buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '10px', height: '10px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'pre1', 'data-mp-params': '{}' },
  });
  tick();
  assert.ok(calls.some((p) => p['mpNative.pre1']));
});

test('I1 门面:register/command 在门面阶段先排队,createNativeViews 接管后原样并入 awaiting 并重放命令', async () => {
  const { c, shim } = setupShim();
  const { createNativeViews, createNativeFacade } = loadNativeViews(c);

  // 模拟 boot.js 在 loadDart 之前装门面(这里手动造,不必真的跑一遍 boot()):
  // isAvailable(Dart 侧的 `_bridge != null`)从这一刻起就是 true 了。
  const facade = createNativeFacade();
  shim.window.__mpNative = facade.bridge;
  shim.self.__mpNative = facade.bridge;
  shim.nativeFacade = facade;

  // 门面阶段:工厂已经跑过、register 了一个 id;Dart 侧也已经发出一条命令
  // (对应的占位元素届时还没被引擎合成,真实场景里这条命令要等重放后才
  // 真正判定"就绪/超时")。
  facade.bridge.register('fac1');
  const wxCalls = [];
  const wx = { createVideoContext: (id) => { wxCalls.push(id); return { play: () => wxCalls.push('play') }; } };
  const cmdPromise = facade.bridge.command('fac1', 'play', '{}');

  const calls = [];
  const { raf, tick } = makeRaf();
  const nv = createNativeViews({ shim, wx, setData: (p, cb) => { calls.push(p); if (cb) cb(); }, raf });

  // 接管后门面应该被清空(不留痕),真正的 command/register 已经挂上 window/self。
  assert.strictEqual(shim.nativeFacade, undefined, '接管后应清掉 shim.nativeFacade');
  assert.strictEqual(shim.window.__mpNative.command, nv.command);
  assert.strictEqual(shim.self.__mpNative.command, nv.command);

  // fac1 视同 __mpNativePending 并入了 awaiting:远超宽限期都不该停。
  for (let i = 0; i < 100; i++) tick();

  buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '10px', height: '10px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'fac1', 'data-mp-params': '{}' },
  });
  tick(); // 发现 fac1,首帧 setData(带 cb)→ rendered → flush pending → 重放门面阶段排队的命令

  const r = await cmdPromise;
  assert.strictEqual(r, 'ok');
  assert.deepStrictEqual(wxCalls, ['mpv-fac1', 'play']);
  assert.ok(calls.some((p) => p['mpNative.fac1']));

  nv.stop();
});

test('I1 门面:command 在 createNativeViews 接管前调用也会排队,接管后正常重放(而不是立即 reject)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, shim } = setupShim();
  const { createNativeViews, createNativeFacade } = loadNativeViews(c);
  const facade = createNativeFacade();
  shim.window.__mpNative = facade.bridge;
  shim.self.__mpNative = facade.bridge;
  shim.nativeFacade = facade;

  // 门面阶段就有调用方发出命令(对应视图还完全没出现过)。
  const p = facade.bridge.command('999', 'play', '{}');

  const { raf } = makeRaf(); // 不 tick:视图永远不会被发现,应该走 command() 自己的 5s 超时
  createNativeViews({ shim, wx: {}, setData: () => {}, raf });

  t.mock.timers.tick(5000);
  await assert.rejects(() => p, /999/);
});

test('低频轮询:空闲时每 ~1000ms 扫一次 glass-pane 直接子节点,发现新元素就唤醒 rAF 循环', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const calls = [];
  const rafCalls = [];
  const raf = (cb) => { rafCalls.push(cb); };
  const nv = createNativeViews({ shim, wx: {}, setData: (p) => calls.push(p), raf });

  // 耗尽宽限期,循环应该已经停了(此时应该已经安排了低频轮询定时器)。
  let ran = 0;
  while (rafCalls.length && ran < 1000) { rafCalls.shift()(); ran++; }
  assert.strictEqual(rafCalls.length, 0);

  // 引擎这时候才把占位元素挂上树——既没有 register() 也没有
  // __mpNativePending,纯粹靠低频轮询兜底发现。
  buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '10px', height: '10px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'polled', 'data-mp-params': '{}' },
  });

  t.mock.timers.tick(1000); // 触发一次低频轮询(约 1000ms 一次)
  assert.strictEqual(rafCalls.length, 1, '低频轮询发现新元素后应该唤醒 rAF 循环');
  rafCalls.shift()(); // 唤醒之后真正的 tick() 补上完整几何/setData
  assert.ok(calls.some((p) => p['mpNative.polled']));

  nv.stop();
});

test('有已知视图时不启用低频轮询定时器', () => {
  const { c, shim } = setupShim();
  buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '10px', height: '10px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'busy', 'data-mp-params': '{}' },
  });
  const { createNativeViews } = loadNativeViews(c);
  const { raf, tick } = makeRaf();
  let setTimeoutCalls = 0;
  const origSetTimeout = c.sandbox.setTimeout;
  c.sandbox.setTimeout = (...args) => { setTimeoutCalls++; return origSetTimeout(...args); };
  const nv = createNativeViews({ shim, wx: {}, setData: () => {}, raf });
  // 视图一直存在,循环应该一直正常调度,不该进入空闲、也不该启用低频轮询。
  for (let i = 0; i < 40; i++) tick();
  c.sandbox.setTimeout = origSetTimeout;
  nv.stop();
  assert.strictEqual(setTimeoutCalls, 0, '有已知视图时不应该启用低频轮询 setTimeout');
});

test('command:未就绪时进入 pending 队列,等到该 id 首次 setData 回调(视图层已应用)后才真正下发;video play 调到 createVideoContext(\'mpv-7\').play', async () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const wxCalls = [];
  const wx = {
    createVideoContext: (id) => {
      wxCalls.push(['createVideoContext', id]);
      return { play: () => wxCalls.push('play') };
    },
  };
  // 承载页会把 setData 的第二个参数(cb)原样透传给 page.setData——这里模拟
  // "视图层已应用完这次更新"的回调,同步触发即可(真实微信是异步的,但对
  // 这里要验证的先后关系没有影响)。
  const setDataCalls = [];
  const setData = (patch, cb) => { setDataCalls.push(patch); if (cb) cb(); };
  const { raf, tick } = makeRaf();
  const nv = createNativeViews({ shim, wx, setData, raf });

  // 此时这个 id 还没有对应的 fixture,同步层压根没发现过它:不应该立即
  // reject,而是先挂起。
  const p = nv.command('7', 'play', '{}');
  assert.strictEqual(wxCalls.length, 0, '组件还没渲染出来,不能提前调 wx.createVideoContext');

  buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '390px', height: '200px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': '7', 'data-mp-params': '{}' },
  });
  tick(); // 发现 id=7,首帧 setData(带 cb)触发 → 标记 rendered、flush pending

  const r = await p;
  assert.strictEqual(r, 'ok');
  assert.deepStrictEqual(wxCalls, [['createVideoContext', 'mpv-7'], 'play']);

  assert.strictEqual(shim.window.__mpNative.command, nv.command, 'self/window 上要挂同一个 command');
  assert.strictEqual(shim.self.__mpNative.command, nv.command);
  assert.strictEqual(typeof shim.window.__mpNative.register, 'function');

  await assert.rejects(() => nv.command('7', 'explode', '{}'), /不支持 method/);
});

test('command:超过 5s 该 id 始终没有被发现/渲染,超时 reject 并给出诊断信息', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const { raf } = makeRaf(); // 故意不 tick:这个 id 永远不会被发现
  const nv = createNativeViews({ shim, wx: {}, setData: () => {}, raf });

  const p = nv.command('999', 'play', '{}');
  t.mock.timers.tick(5000);
  await assert.rejects(() => p, /5s 内未发现 data-mp-id=999/);
});

test('原生事件:onMpNativeEvent 转发后,占位元素收到 mpnative CustomEvent,detail 可解析', () => {
  const { c, shim } = setupShim();
  const { createNativeViews } = loadNativeViews(c);
  const f = buildFixture(shim, {
    clips: [{ 'clip-path': 'rect(0px 390px 788px 0px)', transform: 'matrix(1,0,0,1,0,0)' }],
    slotStyle: { width: '390px', height: '200px', opacity: '1', transform: 'none' },
    viewAttrs: { 'data-mp-native': 'video', 'data-mp-id': 'v4', 'data-mp-params': '{}' },
  });
  const { raf, tick } = makeRaf();
  const nv = createNativeViews({ shim, wx: {}, setData: () => {}, raf });
  tick();

  let received = null;
  f.div.addEventListener('mpnative', (e) => { received = e; });
  nv.dispatchEvent('v4', 'timeupdate', { currentTime: 1.2 });

  assert.ok(received, '占位元素应该收到 mpnative 事件');
  assert.strictEqual(received.type, 'mpnative');
  assert.deepStrictEqual(JSON.parse(received.detail), { type: 'timeupdate', detail: { currentTime: 1.2 } });
});
