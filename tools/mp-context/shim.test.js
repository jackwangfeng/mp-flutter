const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');

const SHIM = path.resolve(__dirname, '../../packages/mp_flutter/runtime/bom-shim.js');

function installShim() {
  const c = createMpContext();
  const bom = c.requireModule(SHIM);
  const shim = bom.install({ canvas: c.canvas, width: 366, height: 249, dpr: 3 });
  return { c, bom, shim };
}

test('未知属性返回真 undefined,不返回 stub', () => {
  const { shim } = installShim();
  // 这是整个垫片最重要的一条:宽容 stub 会毒死 dart2js 的 dispatch record 探测
  assert.strictEqual(shim.window.__nope_not_a_real_api, undefined);
  assert.strictEqual(shim.document.__nope, undefined);
  assert.strictEqual(shim.self.__nope, undefined);
  const el = shim.document.createElement('div');
  assert.strictEqual(el.___dart_dispatch_record_ZxYxX_0_, undefined,
    'dart2js 的 dispatch record 标签必须是 undefined');
});

test('window 暴露真实内置构造函数(dart2js 用它建 interceptor 派发表)', () => {
  const { c, shim } = installShim();
  for (const name of ['ArrayBuffer', 'Uint8Array', 'Int32Array', 'Float64Array',
                      'DataView', 'Promise', 'Map', 'Set']) {
    assert.strictEqual(typeof shim.window[name], 'function', `window.${name} 必须是真构造函数`);
  }
});

test('显式 undefined 的能力保持 undefined(引擎靠它走降级)', () => {
  const { shim } = installShim();
  for (const name of ['MutationObserver', 'OffscreenCanvas', 'createImageBitmap',
                      'SharedArrayBuffer', 'IntersectionObserver']) {
    assert.strictEqual(shim.window[name], undefined, `window.${name} 必须是 undefined`);
    // self.OffscreenCanvas 例外:引擎的能力探测读 window.OffscreenCanvas,self 上的
    // 只被构造(图片 cacheWidth 缩放),给的是 CanvasKit CPU 光栅实现(见 image.test.js)
    if (name === 'OffscreenCanvas') continue;
    assert.strictEqual(shim.self[name], undefined, `self.${name} 必须是 undefined`);
  }
});

test('ResizeObserver 可 new,且异步回调一次带上视口尺寸', async () => {
  const { shim } = installShim();
  assert.strictEqual(typeof shim.window.ResizeObserver, 'function');
  const entry = await new Promise((resolve) => {
    const ro = new shim.window.ResizeObserver((entries) => resolve(entries[0]));
    ro.observe(shim.document.createElement('div'));
  });
  assert.strictEqual(entry.contentRect.width, 366);
  assert.strictEqual(entry.contentRect.height, 249);
  assert.strictEqual(entry.devicePixelContentBoxSize[0].inlineSize, 366 * 3);
});

test('PointerEvent 存在且可构造(缺了引擎直接拒绝启动)', () => {
  const { shim } = installShim();
  assert.strictEqual(typeof shim.window.PointerEvent, 'function');
  const e = new shim.window.PointerEvent('pointerdown', { clientX: 10, clientY: 20 });
  assert.strictEqual(e.type, 'pointerdown');
  assert.strictEqual(e.clientX, 10);
  assert.strictEqual(typeof e.preventDefault, 'function');
});

test('style 是 CSSStyleDeclaration 垫片,支持 setProperty', () => {
  const { shim } = installShim();
  const el = shim.document.createElement('div');
  el.style.setProperty('width', '10px');
  assert.strictEqual(el.style.getPropertyValue('width'), '10px');
  assert.strictEqual(el.style.width, '10px');
  el.style.removeProperty('width');
  assert.strictEqual(el.style.getPropertyValue('width'), '');
});

test('canvas 元素的 width/height:绑定 WebGL 时写到真实节点,之后直接透传', () => {
  const { c, shim } = installShim();
  const el = shim.document.createElement('canvas');
  const w0 = c.canvas.width;
  el.width = 1098;
  el.height = 747;
  assert.strictEqual(c.canvas.width, w0, '未绑定前不碰真实节点(可能是 2d 画布)');
  assert.strictEqual(el.width, 1098, '未绑定前 getter 读回设置值');
  el.getContext('webgl');
  assert.strictEqual(c.canvas.width, 1098, 'width 未透传到真实画布节点');
  assert.strictEqual(c.canvas.height, 747, 'height 未透传到真实画布节点');
  el.width = 1119;
  assert.strictEqual(c.canvas.width, 1119, '绑定后直接透传');
  assert.strictEqual(el.width, 1119, 'getter 应读真实节点');
});

test('self 提供 dart2js 需要的 ES 全局函数', () => {
  const { shim } = installShim();
  for (const name of ['parseFloat', 'parseInt', 'isNaN', 'encodeURIComponent']) {
    assert.strictEqual(typeof shim.self[name], 'function', `self.${name} 缺失`);
  }
  assert.strictEqual(shim.self.window, shim.window);
  assert.strictEqual(shim.self.self, shim.self);
});

test('window.getComputedStyle 返回带 getPropertyValue 的对象', () => {
  const { shim } = installShim();
  const el = shim.document.createElement('div');
  el.style.setProperty('color', 'red');
  assert.strictEqual(shim.window.getComputedStyle(el).getPropertyValue('color'), 'red');
});

test('document.querySelector 对 meta 返回带 content 的元素,其余返回 null', () => {
  const { shim } = installShim();
  assert.strictEqual(shim.document.querySelector('meta[name=generator]').content, '');
  assert.strictEqual(shim.document.querySelector('#nonexistent'), null);
});

test('元素支持现代 DOM 方法', () => {
  const { shim } = installShim();
  const body = shim.document.body;
  const child = shim.document.createElement('div');
  assert.strictEqual(typeof body.append, 'function');
  body.append(child);
  assert.ok(body.childNodes.includes(child));
});

test('report() 列出被触达的未实现 API', () => {
  const { bom, shim } = installShim();
  void shim.window.__some_missing_api;
  const lines = bom.report();
  assert.ok(lines.some((l) => l.includes('__some_missing_api')),
    'report() 应记录未实现的访问');
});

test('全局注入结果被如实记录(模拟器写不进、真机可写,两种都要记)', () => {
  const { shim } = installShim();
  assert.strictEqual(typeof shim.globalsOk, 'object');
  // 不论成功失败都必须有记录,供构建期诊断
  assert.ok('window' in shim.globalsOk);
});

// 修复轮 1:评审指出 globalsOk.self === 'ok' 不足以证明注入的是垫片对象 ——
// 之前的 bug 是把全局 self 指向了裸 globalThis 而不是 selfObj。真机上这条路
// 会成功(模拟器不可写,真机可写,两者行为相反),一旦成功,编译产物里任何
// 裸 self 引用都会绕过垫片。这里直接断言注入后的全局 self 就是 shim.self。
test('全局注入的 self 确实是垫片的 self,而不是裸 globalThis', () => {
  const { c, shim } = installShim();
  assert.strictEqual(shim.globalsOk.self, 'ok', '本次注入应当成功');
  assert.strictEqual(c.sandbox.self, shim.self,
    '全局 self 必须指向垫片化的 selfObj,而不是原始 globalThis —— 否则会丢失显式 undefined 标记和 ES 全局函数补丁');
  // 顺带验证:这份全局 self 自洽,且带着垫片设的那些标记
  assert.strictEqual(c.sandbox.self.self, shim.self);
  assert.strictEqual(typeof c.sandbox.self.parseFloat, 'function');
  assert.strictEqual(c.sandbox.self.MutationObserver, undefined);
});

// 修复轮 1:评审指出没有任何测试真正注册监听器并断言它被触发 ——
// 这恰恰是 brief 强调最多、真机验证过最脆弱的子系统(spike 期踩过
// ReferenceError: tag is not defined)。补齐 element/document/window 三处的
// 派发往返测试,不满足于"检视看起来对"。
test('element 上注册的监听器能被 dispatchEvent 真正触发', () => {
  const { shim } = installShim();
  const el = shim.document.createElement('div');
  let received = null;
  el.addEventListener('click', (e) => { received = e; });
  const ev = new shim.window.Event('click');
  const handled = el.dispatchEvent(ev);
  assert.strictEqual(handled, true);
  assert.strictEqual(received, ev, '监听器必须收到派发的同一个事件对象');
  assert.strictEqual(received.type, 'click');
  assert.strictEqual(received.target, el);
});

test('document 上注册的监听器能被 dispatchEvent 真正触发', () => {
  const { shim } = installShim();
  let received = null;
  shim.document.addEventListener('click', (e) => { received = e; });
  const ev = new shim.window.Event('click');
  shim.document.dispatchEvent(ev);
  assert.strictEqual(received, ev, '监听器必须收到派发的同一个事件对象');
  assert.strictEqual(received.type, 'click');
  assert.strictEqual(received.currentTarget, shim.document);
});

test('window 上注册的监听器能被 dispatchEvent 真正触发', () => {
  const { shim } = installShim();
  let received = null;
  shim.window.addEventListener('resize', (e) => { received = e; });
  const ev = new shim.window.Event('resize');
  shim.window.dispatchEvent(ev);
  assert.strictEqual(received, ev, '监听器必须收到派发的同一个事件对象');
  assert.strictEqual(received.type, 'resize');
  assert.strictEqual(received.currentTarget, shim.window);
});

// 真机缺 TextEncoder/TextDecoder,必须自实现 UTF-8 编解码(含代理对)。
// 与 Node 原生 Buffer.from(s, 'utf8') 逐字节比对,确保没有编码 bug。
test('TextEncoder/TextDecoder 自实现的 UTF-8 编解码与 Buffer.from(s,\'utf8\') 逐字节一致(含代理对)', () => {
  const { shim } = installShim();
  const Encoder = shim.window.TextEncoder;
  const Decoder = shim.window.TextDecoder;
  const samples = [
    '',
    'hello',
    '你好,世界',
    '☃★♛',
    '\ud83d\ude00\ud83d\udc3a\ud83d\udc4d\ud83c\udffd', // 代理对 + 变体选择符(显式 \u 转义,避免源文件编码歧义)
    'a\u0000b',                                      // 含 NUL 字节
  ];
  for (const s of samples) {
    const expected = Buffer.from(s, 'utf8');
    const got = Buffer.from(Encoder ? new Encoder().encode(s) : []);
    assert.strictEqual(got.length, expected.length, `encode(${JSON.stringify(s)}) 字节长度不一致`);
    assert.strictEqual(got.compare(expected), 0, `encode(${JSON.stringify(s)}) 与 Buffer.from 不逐字节一致`);
    const decoded = new Decoder().decode(new Uint8Array(expected));
    assert.strictEqual(decoded, s, `decode 未还原原字符串:${JSON.stringify(s)}`);
  }
});

test('history.replaceState 写入的 state 能读回(引擎路由会对它做非空断言)', () => {
  const { shim } = installShim();
  const h = shim.window.history;
  assert.strictEqual(h.state, null);
  h.replaceState({ serialCount: 0, state: null }, 'flutter', '/');
  assert.deepStrictEqual(h.state, { serialCount: 0, state: null });
  assert.strictEqual(h.length, 1);
});

test('history.pushState 更新 location,back 异步派发带 state 的 popstate', async () => {
  const { shim } = installShim();
  const w = shim.window;
  w.history.replaceState({ n: 0 }, '', '/');
  w.history.pushState({ n: 1 }, '', '/detail?id=3#top');
  assert.strictEqual(w.location.pathname, '/detail');
  assert.strictEqual(w.location.search, '?id=3');
  assert.strictEqual(w.location.hash, '#top');
  assert.strictEqual(w.history.length, 2);

  const got = new Promise((resolve) => w.addEventListener('popstate', (e) => resolve(e.state)));
  w.history.back();
  assert.deepStrictEqual(w.history.state, { n: 0 }, 'back 后 state 立即指向上一条');
  assert.deepStrictEqual(await got, { n: 0 });
  assert.strictEqual(w.location.pathname, '/');
});

test('history.go 越界是空操作,pushState 截断前进栈', () => {
  const { shim } = installShim();
  const h = shim.window.history;
  h.pushState('a', '', '/a');
  h.pushState('b', '', '/b');
  h.go(-5);
  assert.strictEqual(h.state, 'b');
  h.go(-2);
  assert.strictEqual(h.state, null);
  h.pushState('c', '', '/c');
  assert.strictEqual(h.length, 2, '从中间 push 必须截断后面的条目');
});

// ---------------------------------------------------------------------
// Task 3:垫片 DOM 树、焦点与 HTML 元素类(文本输入前置)
// ---------------------------------------------------------------------

test('DOM 树:append 建立父子关系,contains/isConnected/remove 正确', () => {
  const { shim } = installShim();
  const doc = shim.document;
  const host = doc.createElement('flt-text-editing-host');
  const input = doc.createElement('input');
  assert.strictEqual(input.isConnected, false);
  doc.body.append(host);
  host.appendChild(input);
  assert.strictEqual(input.parentNode, host);
  assert.strictEqual(host.contains(input), true);
  assert.strictEqual(host.contains(host), true, 'contains 包含自身');
  assert.strictEqual(input.contains(host), false);
  assert.strictEqual(input.isConnected, true);
  input.remove();
  assert.strictEqual(input.parentNode, null);
  assert.strictEqual(host.contains(input), false);
  assert.strictEqual(input.isConnected, false);
});

test('HTML 元素类:input/textarea 的 instanceof 与引擎的 isA 检查一致', () => {
  const { shim } = installShim();
  const w = shim.window;
  const input = shim.document.createElement('input');
  const ta = shim.document.createElement('textarea');
  assert.ok(input instanceof w.HTMLInputElement);
  assert.ok(input instanceof w.HTMLElement);
  assert.ok(!(input instanceof w.HTMLTextAreaElement));
  assert.ok(ta instanceof w.HTMLTextAreaElement);
  assert.ok(shim.document.createElement('form') instanceof w.HTMLFormElement);
  assert.ok(!(shim.document.createElement('div') instanceof w.HTMLInputElement));
});

test('焦点:focus 派发 focus/focusin(冒泡),切换时旧元素收到带 relatedTarget 的 blur', () => {
  const { shim } = installShim();
  const doc = shim.document;
  const view = doc.createElement('flutter-view');
  const a = doc.createElement('input'), b = doc.createElement('input');
  doc.body.append(view); view.append(a, b);
  const seen = [];
  view.addEventListener('focusin', (e) => seen.push('focusin:' + (e.target === a ? 'a' : 'b')));
  a.addEventListener('blur', (e) => seen.push('a.blur→' + (e.relatedTarget === b ? 'b' : String(e.relatedTarget))));
  const changes = [];
  shim.onFocusChange((el) => changes.push(el));
  a.focus();
  assert.strictEqual(doc.activeElement, a);
  b.focus();
  assert.deepStrictEqual(seen, ['focusin:a', 'a.blur→b', 'focusin:b']);
  b.blur();
  assert.strictEqual(doc.activeElement, doc.body);
  assert.deepStrictEqual(changes, [a, b, null]);
});

test('blur 到无处时 relatedTarget 为 null(引擎据此关闭输入连接)', () => {
  const { shim } = installShim();
  const a = shim.document.createElement('input');
  shim.document.body.append(a);
  let rt = 'unset';
  a.addEventListener('blur', (e) => { rt = e.relatedTarget; });
  a.focus(); a.blur();
  assert.strictEqual(rt, null);
});

// 修复轮 1(评审 Important):removeChild/_adopt 把"从某父节点摘下"和
// "离开文档、必须交出焦点"混为一谈。三个场景各补一条回归测试。

test('移除持有焦点元素的祖先容器:activeElement 回到 body,input 收到 blur,祖先链收到 focusout,onFocusChange 回调 null', () => {
  const { shim } = installShim();
  const doc = shim.document;
  const view = doc.createElement('flutter-view');
  const host = doc.createElement('flt-text-editing-host');
  const input = doc.createElement('input');
  doc.body.append(view); view.append(host); host.appendChild(input);

  let gotBlur = false, gotFocusout = false;
  input.addEventListener('blur', () => { gotBlur = true; });
  view.addEventListener('focusout', () => { gotFocusout = true; });
  const changes = [];
  shim.onFocusChange((el) => changes.push(el));

  input.focus();
  host.remove(); // 摘除的是祖先 host,不是 input 本身

  assert.strictEqual(input.isConnected, false);
  assert.strictEqual(doc.activeElement, doc.body, '不能悬空在已摘除的 input 上');
  assert.strictEqual(gotBlur, true);
  assert.strictEqual(gotFocusout, true, 'focusout 必须冒泡到摘除前的祖先 view');
  assert.deepStrictEqual(changes, [input, null]);
});

test('直接移除焦点元素本身:focusout 必须在断开 parentNode 之前冒泡到原祖先', () => {
  const { shim } = installShim();
  const doc = shim.document;
  const view = doc.createElement('flutter-view');
  const input = doc.createElement('input');
  doc.body.append(view); view.append(input);

  let gotFocusoutOnView = false;
  view.addEventListener('focusout', () => { gotFocusoutOnView = true; });

  input.focus();
  input.remove();

  assert.strictEqual(doc.activeElement, doc.body);
  assert.strictEqual(gotFocusoutOnView, true,
    'removeChild 必须先派发 focusout(此时 _parent 还在)再断开,否则冒泡读到 null');
});

test('reparent 仍连接的焦点节点(同一次 appendChild 里立刻重新挂上):不得清焦点、不得派发 blur', () => {
  const { shim } = installShim();
  const doc = shim.document;
  const a = doc.createElement('div'), b = doc.createElement('div');
  const input = doc.createElement('input');
  doc.body.append(a, b);
  a.appendChild(input);

  let blurred = false;
  input.addEventListener('blur', () => { blurred = true; });

  input.focus();
  b.appendChild(input); // 从 a 挪到 b,全程连接,不应视为"离开文档"

  assert.strictEqual(input.parentNode, b);
  assert.strictEqual(blurred, false, 'reparent 不应派发 blur');
  assert.strictEqual(doc.activeElement, input, 'reparent 不应清焦点');
});

test('input 的 value/selection 语义:setSelectionRange 写入,超长截断到 value 长度', () => {
  const { shim } = installShim();
  const a = shim.document.createElement('input');
  a.value = '世界😀';
  a.setSelectionRange(1, 99);
  assert.strictEqual(a.selectionStart, 1);
  assert.strictEqual(a.selectionEnd, 4, '😀 占 2 个 UTF-16 码元,总长 4');
});

test('listenerTargets 登记注册过某类监听器的元素', () => {
  const { shim } = installShim();
  const view = shim.document.createElement('flutter-view');
  const f = () => {};
  view.addEventListener('pointerdown', f);
  view.addEventListener('pointerdown', () => {});
  assert.deepStrictEqual(shim.listenerTargets('pointerdown'), [view]);
  assert.deepStrictEqual(shim.listenerTargets('nothing'), []);
});

// dart2js 的 A.ec(a,'HTMLInputElement') 走 v.G(=全局 self)按名取构造器再
// instanceof,不是从 window 取 —— E2E 实测(/tmp/mpf_input)踩过"只挂在 window
// 上,self 上没有"导致引擎报 Unsupported DOM element type: <INPUT> 的坑。
test('self(v.G)上也暴露 HTML 元素类,不能只挂在 window 上', () => {
  const { shim } = installShim();
  const input = shim.document.createElement('input');
  assert.strictEqual(shim.self.HTMLInputElement, shim.window.HTMLInputElement);
  assert.ok(input instanceof shim.self.HTMLInputElement);
});

test('FocusEvent/InputEvent/CompositionEvent 可构造且继承 Event', () => {
  const { shim } = installShim();
  const w = shim.window;
  const e = new w.FocusEvent('blur', { relatedTarget: null });
  assert.strictEqual(e.type, 'blur');
  assert.ok(new w.InputEvent('input') instanceof w.Event);
  assert.ok(new w.CompositionEvent('compositionend', { data: '世' }) instanceof w.UIEvent);
});

// 修复轮 1 Important 1:'Control' 对应的浏览器字段是 ctrlKey,不是
// controlKey——之前 `key.toLowerCase() + 'Key'` 的算法对 Alt/Meta/Shift 凑巧
// 算对,唯独 Control 恒为 false。引擎 pointer_binding.dart 的
// _checkModifiersState 每次 pointer 事件都调这四个,判错会让 Task 5 的键盘
// 修饰键同步失真。
test('getModifierState:四个修饰键按正确字段换算,Control 不是 controlKey', () => {
  const { shim } = installShim();
  const e = new shim.window.KeyboardEvent('keydown', {
    altKey: true, ctrlKey: true, metaKey: false, shiftKey: true,
  });
  assert.strictEqual(e.getModifierState('Alt'), true);
  assert.strictEqual(e.getModifierState('Control'), true);
  assert.strictEqual(e.getModifierState('Meta'), false);
  assert.strictEqual(e.getModifierState('Shift'), true);
  assert.strictEqual(e.getModifierState('CapsLock'), false, '未知/不支持的修饰键一律返回 false');
});

test('platform=android 时 UA 为 Android,其余情况为 iPhone', () => {
  const c = createMpContext();
  const bom = c.requireModule(SHIM);
  const a = bom.install({ canvas: c.canvas, width: 390, height: 844, dpr: 3, platform: 'android' });
  assert.match(a.window.navigator.userAgent, /Android/);
  const c2 = createMpContext();
  const i = c2.requireModule(SHIM).install({ canvas: c2.canvas, width: 390, height: 844, dpr: 3, platform: 'devtools' });
  assert.match(i.window.navigator.userAgent, /iPhone/);
});

test('K3:canvas.getContext(webgl2) 静默返回 null,不转发给真实节点(否则基础库打 [error])', () => {
  const { c, shim } = installShim();
  const calls = [];
  const orig = c.canvas.getContext.bind(c.canvas);
  c.canvas.getContext = (type, a) => { calls.push(type); return orig(type, a); };
  const el = shim.document.createElement('canvas');
  assert.strictEqual(el.getContext('webgl2'), null);
  assert.deepStrictEqual(calls, [], 'webgl2 探测不应触达真实节点');
  const gl = el.getContext('webgl');
  assert.ok(gl, 'webgl 回退仍然可用');
  assert.deepStrictEqual(calls, ['webgl']);
});

test('K5:self.scheduleImmediate 是真微任务——先于已排队的 setTimeout(0) 与 rAF 执行', async () => {
  // dart2js 的 scheduleMicrotask 依次探测 self.scheduleImmediate / MutationObserver /
  // self.setImmediate,都没有就退化成 Timer(setTimeout 0)。退化后 Dart 的 await
  // 续体变成宏任务,rAF 驱动的下一帧能插进引擎 draw() 的 `await prepareToDraw()`
  // 与 preroll 之间,把在途场景的 picture dispose 掉 → cullRect 空指针(K5)。
  const { shim } = installShim();
  assert.strictEqual(typeof shim.self.scheduleImmediate, 'function');
  const order = [];
  await new Promise((resolve) => {
    setTimeout(() => { order.push('timeout'); resolve(); }, 0);
    shim.window.requestAnimationFrame(() => order.push('raf'));
    shim.self.scheduleImmediate(() => order.push('micro'));
  });
  assert.strictEqual(order[0], 'micro');
  assert.ok(order.indexOf('timeout') > 0);
});

// ---- 真机 JS 引擎的 Intl 差异(iOS JavaScriptCore / 无 Intl 的安卓)----------------

test('默认:window.Intl / self.Intl 就是运行时自己的 Intl', () => {
  const { c, shim } = installShim();
  const realIntl = c.run('Intl');
  assert.strictEqual(shim.window.Intl, realIntl);
  assert.strictEqual(shim.self.Intl, realIntl);
});

test('simulate=ios:遮蔽 v8BreakIterator 与 Segmenter,其余 Intl 成员照常可用', () => {
  const c = createMpContext();
  const shim = c.requireModule(SHIM).install({ canvas: c.canvas, width: 366, height: 249, dpr: 3, simulate: 'ios' });
  for (const I of [shim.window.Intl, shim.self.Intl]) {
    assert.strictEqual(I.v8BreakIterator, undefined);
    assert.strictEqual(I.Segmenter, undefined);
    assert.strictEqual(new I.Locale('zh-Hans-CN').region, 'CN');
    assert.strictEqual(typeof I.NumberFormat, 'function');
  }
});

test('simulate=android-noIntl:引擎看到的是只有 Locale 的最小 Intl 替身', () => {
  const c = createMpContext();
  const shim = c.requireModule(SHIM).install({ canvas: c.canvas, width: 366, height: 249, dpr: 3, simulate: 'android-noIntl' });
  for (const I of [shim.window.Intl, shim.self.Intl]) {
    assert.notStrictEqual(I, c.run('Intl'));
    assert.strictEqual(I.Segmenter, undefined);
    assert.strictEqual(I.v8BreakIterator, undefined);
    assert.strictEqual(I.NumberFormat, undefined);
  }
});

test('运行时整个没有 Intl(安卓真机):install 不抛 ReferenceError,引擎拿到最小 Intl.Locale', () => {
  const c = createMpContext({ noIntl: true });
  assert.throws(() => c.run('Intl'), /Intl is not defined/, '前提:裸引用 Intl 抛 ReferenceError(与真机一致)');
  let shim;
  assert.doesNotThrow(() => { shim = c.requireModule(SHIM).install({ canvas: c.canvas, width: 366, height: 249, dpr: 3 }); });
  // 引擎 parseBrowserLanguages:对 navigator.languages 逐个 new Intl.Locale(tag)
  const L = shim.self.Intl.Locale;
  const parsed = Array.from(shim.navigator.languages).map((t) => { const l = new L(t); return [l.language, l.script, l.region]; });
  assert.deepStrictEqual(parsed, [['zh', undefined, 'CN'], ['zh', undefined, undefined]]);
  const full = new L('zh-hans-cn');
  assert.deepStrictEqual([full.language, full.script, full.region, String(full)], ['zh', 'Hans', 'CN', 'zh-Hans-CN']);
  const us = new L('en_US');
  assert.deepStrictEqual([us.language, us.region], ['en', 'US']);
  assert.throws(() => L('en'), TypeError);
});

test('宿主没有 queueMicrotask / BigInt64Array:install 不抛,queueMicrotask 退化为 Promise 微任务', async () => {
  const c = createMpContext();
  c.run('delete globalThis.queueMicrotask; delete globalThis.BigInt64Array; delete globalThis.BigUint64Array;');
  c.sandbox.queueMicrotask = undefined;
  let shim;
  assert.doesNotThrow(() => { shim = c.requireModule(SHIM).install({ canvas: c.canvas, width: 366, height: 249, dpr: 3 }); });
  assert.strictEqual(typeof shim.self.queueMicrotask, 'function');
  const order = [];
  await new Promise((resolve) => {
    setTimeout(() => { order.push('timeout'); resolve(); }, 0);
    shim.self.queueMicrotask(() => order.push('micro'));
  });
  assert.deepStrictEqual(order, ['micro', 'timeout']);
});

test('simulate=android / android-noIntl:RegExp 包装对 u 标志下的 \\p{…} 抛与真机同样的 SyntaxError', () => {
  for (const simulate of ['android', 'android-noIntl']) {
    const c = createMpContext();
    const mod = c.requireModule(SHIM);
    mod.install({ canvas: c.canvas, width: 366, height: 249, dpr: 3, simulate });
    const R = mod.RegExp;
    assert.notStrictEqual(R, c.run('RegExp'));
    assert.throws(() => new R('\\p{Space_Separator}', 'u'),
      (e) => e.name === 'SyntaxError' &&
        e.message === 'Invalid regular expression: /\\p{Space_Separator}/u: Invalid property name');
    assert.throws(() => R('[\\P{L}]', 'gu'), /Invalid property name/);
    // 不带 u、字面反斜杠、改写后的码点区间:照常可用,instanceof 不受影响
    assert.ok(new R('\\p{L}').test('p{L}'));
    assert.ok(new R('\\\\p{L}', '').test('\\p{L}'));
    const re = new R('[\\u{20}\\u{3000}]', 'u');
    assert.ok(re.test('　'));
    assert.ok(re instanceof R);
  }
});

test('不模拟(stable / ios):导出的 RegExp 就是原生构造函数', () => {
  for (const simulate of [undefined, 'ios']) {
    const c = createMpContext();
    const mod = c.requireModule(SHIM);
    mod.install({ canvas: c.canvas, width: 366, height: 249, dpr: 3, simulate });
    assert.strictEqual(mod.RegExp, c.run('RegExp'));
    assert.ok(new mod.RegExp('\\p{L}', 'u').test('a'));
  }
});
