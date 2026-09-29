// mp-flutter BOM/DOM 垫片
//
// 纪律:严格模式。未知属性一律返回真 undefined 并记录。
// 绝不返回可调用/可索引的 Proxy stub —— dart2js 会在每个互操作对象上探测
// ___dart_dispatch_record_* 标签,拿到 truthy stub 就以为有派发记录并读出垃圾;
// 引擎还大量用 `X != null` 做能力降级,stub 会骗过所有降级分支。
// 详见 docs/architecture.md。
'use strict';

const { AbortController, AbortSignal, Headers } = require('./net.js');
const storageMod = require('./storage.js');
const imageMod = require('./image.js');

// ---------------------------------------------------------------------
// 访问记录:仅用于诊断"被触达但未实现"的 API,供构建期/联调期排错。
// ---------------------------------------------------------------------
const touched = new Map();
function hit(key) {
  touched.set(key, (touched.get(key) || 0) + 1);
}
function report() {
  return [...touched.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => n + '× ' + k);
}

// 严格代理:已定义的属性走真值;未定义的属性记录后返回真 undefined。
// 这是本文件唯一允许存在的"未知属性"处理分支 —— 绝不返回可调用/可索引的 stub。
function withRecord(obj, name) {
  return new Proxy(obj, {
    // ★ get 陷阱必须把 receiver(代理自身)转发给 Reflect.get:对象字面量里的
    // getter(parentNode/isConnected/value/selectionStart...)若不传 receiver,
    // `t[k]` 会以裸 target 为 this 执行 —— 对纯字段读取(parentNode/value)无影响,
    // 但 isConnected 内部用 `n === shared.root` 做恒等比较,首轮 `this` 若是裸
    // target 而 shared.root 存的是代理,会导致"根节点自身"这一条链路的
    // isConnected 恒为 false(其余节点因为第一轮比较本就该是 false,不受影响,
    // 已用测试用例逐步验算过)。data property 读取不受 receiver 影响,故此改动
    // 对现有行为零风险,只修复这一处根节点自检的边界 bug。set 陷阱不做同等改动:
    // Reflect.set(target, key, value, receiver) 在 receiver !== target 且属性是
    // 普通数据属性时,会转而对 receiver(代理自身)走 [[DefineOwnProperty]],
    // 引入不必要的复杂度且现有 setter(value/selectionStart 等)都只做字段赋值、
    // 不做恒等比较,没有该问题,故维持原样。
    get(t, k, receiver) {
      if (typeof k === 'symbol') return Reflect.get(t, k, receiver);
      if (k in t) return Reflect.get(t, k, receiver);
      hit(name + '.' + String(k) + ' →undefined');
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
    has(t, k) { return k in t; },
  });
}

// ---------------------------------------------------------------------
// 自带 polyfill:真机 iOS 缺 performance / TextEncoder / TextDecoder,
// 而垫片与 canvaskit.js 的 wasm import 都裸引用它们(裸引用未声明的
// 标识符 = ReferenceError)。这里完全自实现,不依赖宿主是否提供,
// 并在 install() 内、构造其余全局对象之前装到 globalThis 上。
// ---------------------------------------------------------------------

function makePerformance() {
  // 宿主有原生 performance(开发者工具、安卓)就直接用:亚毫秒精度,Dart 的
  // Stopwatch / --perf-hud 帧分项都靠它;真机 iOS 没有,退回 Date.now
  if (typeof performance === 'object' && performance && typeof performance.now === 'function') {
    const P = performance;
    return { now() { return P.now(); }, timeOrigin: typeof P.timeOrigin === 'number' ? P.timeOrigin : Date.now() - P.now() };
  }
  const start = Date.now();
  return {
    now() { return Date.now() - start; },
    timeOrigin: start,
  };
}

// UTF-8 编码器。含代理对(surrogate pair)拼接。
function makeTextEncoderClass() {
  return class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(input) {
      const str = input == null ? '' : String(input);
      const bytes = [];
      // 注意:落单代理对(缺配对的高/低代理)这里按其原始码位直接编码,
      // 与 WHATWG 规范(应替换为 U+FFFD)不同。真实 Dart 字符串不会产生
      // 落单代理对,风险低,故未处理。
      for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
          const low = str.charCodeAt(i + 1);
          if (low >= 0xDC00 && low <= 0xDFFF) {
            code = (code - 0xD800) * 0x400 + (low - 0xDC00) + 0x10000;
            i++;
          }
        }
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
          bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
        } else {
          bytes.push(
            0xF0 | (code >> 18),
            0x80 | ((code >> 12) & 0x3F),
            0x80 | ((code >> 6) & 0x3F),
            0x80 | (code & 0x3F));
        }
      }
      return Uint8Array.from(bytes);
    }
  };
}

// UTF-8 解码器。含代理对还原。
function makeTextDecoderClass() {
  return class TextDecoder {
    constructor(label) { this.encoding = label || 'utf-8'; }
    decode(input) {
      if (input == null) return '';
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      let out = '';
      let i = 0;
      while (i < bytes.length) {
        const b0 = bytes[i++];
        let codepoint, extra;
        if (b0 < 0x80) { codepoint = b0; extra = 0; }
        else if ((b0 & 0xE0) === 0xC0) { codepoint = b0 & 0x1F; extra = 1; }
        else if ((b0 & 0xF0) === 0xE0) { codepoint = b0 & 0x0F; extra = 2; }
        else if ((b0 & 0xF8) === 0xF0) { codepoint = b0 & 0x07; extra = 3; }
        else { codepoint = 0xFFFD; extra = 0; }
        for (let j = 0; j < extra && i < bytes.length; j++) {
          codepoint = (codepoint << 6) | (bytes[i++] & 0x3F);
        }
        if (codepoint > 0xFFFF) {
          codepoint -= 0x10000;
          out += String.fromCharCode(0xD800 + (codepoint >> 10), 0xDC00 + (codepoint & 0x3FF));
        } else {
          out += String.fromCharCode(codepoint);
        }
      }
      return out;
    }
  };
}

// 把三个 polyfill 装到全局对象上,让任何后续加载的模块(canvaskit.js 等)
// 裸引用 performance / TextEncoder / TextDecoder 时不会 ReferenceError。
// 宿主若已提供真实实现则不覆盖。
function installPolyfills(g, perf, EncoderClass, DecoderClass) {
  const table = { performance: perf, TextEncoder: EncoderClass, TextDecoder: DecoderClass };
  for (const k of Object.keys(table)) {
    try {
      if (g[k] == null) g[k] = table[k];
    } catch (e) { /* 只读全局则放弃,不影响其余流程 */ }
  }
}

// CSSStyleDeclaration 垫片:引擎会调 style.setProperty(name, value, '')。
// ★ 注意:未知属性这里有意返回 ''(不是走 withRecord 那套"记录后返回
// undefined"的纪律)—— 真实 CSSOM 对未设置的样式属性就是返回空字符串,
// 且 '' 是 falsy,不会被误当成 truthy 的可调用/可索引 stub。这是刻意的
// 例外,不要"修正"成和 withRecord 一致。
function makeStyle() {
  const t = {};
  return new Proxy(t, {
    get(o, k) {
      if (typeof k === 'symbol') return Reflect.get(o, k);
      if (k === 'setProperty') return (n, v) => { o[n] = v == null ? '' : String(v); };
      if (k === 'getPropertyValue') return (n) => (n in o ? o[n] : '');
      if (k === 'removeProperty') return (n) => { const v = o[n]; delete o[n]; return v || ''; };
      if (k === 'getPropertyPriority') return () => '';
      if (k === 'item') return (i) => Object.keys(o)[i] || '';
      if (k === 'length') return Object.keys(o).length;
      if (k === 'cssText') return Object.keys(o).map((n) => n + ':' + o[n]).join(';');
      return k in o ? o[k] : '';
    },
    set(o, k, v) { o[k] = v; return true; },
    has() { return true; },
  });
}

// 小程序 iOS 的 WebGL 对 VERSION/RENDERER/VENDOR 返回同一个非标准字符串;
// Skia 建 GrDirectContext 时会解析这些字符串判断驱动能力,拿到这种值可能直接放弃。
// 这里只改写这几个只读字符串参数,其余一律透传。
//
// 出处/用途说明(非孤立代码,勿当无主逻辑删除):从 spike/mp-probe/lib/bom-shim.js
// 移植,已在真机验证中证明必需 —— Task 12 的 canvaskit 装载器依赖本垫片提供
// 可用的 GL 上下文,驱动字符串规范化正是 Skia 建 GrDirectContext 的前提。
// 不在 Task 11 brief Step 3 的 5 点清单里,也没有单测覆盖,但控制器已裁定保留。
function normalizeGl(gl) {
  if (!gl || gl.__mpNormalized) return gl;
  const VERSION = 0x1F02, VENDOR = 0x1F00, RENDERER = 0x1F01, SL_VERSION = 0x8B8C;
  const STD = {};
  STD[VERSION] = 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
  STD[VENDOR] = 'WeChat';
  STD[RENDERER] = 'WeChat MiniProgram WebGL';
  STD[SL_VERSION] = 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
  const origGetParameter = gl.getParameter.bind(gl);
  try {
    gl.getParameter = function (pname) {
      if (Object.prototype.hasOwnProperty.call(STD, pname)) return STD[pname];
      return origGetParameter(pname);
    };
    gl.__mpNormalized = true;
  } catch (e) { /* 只读属性则放弃改写,不影响其余流程 */ }
  return gl;
}

// 引擎用 `isA<DomHTMLInputElement>()` 判断元素类型,dart2js 编译成
// `instanceof window.HTMLInputElement`。没有这些构造器时引擎报
// `Unsupported DOM element type: <INPUT>` 并导致渲染崩溃(模拟器实测)。
function HTMLElement() {}
function HTMLInputElement() {}
function HTMLTextAreaElement() {}
function HTMLFormElement() {}
HTMLInputElement.prototype = Object.create(HTMLElement.prototype, { constructor: { value: HTMLInputElement } });
HTMLTextAreaElement.prototype = Object.create(HTMLElement.prototype, { constructor: { value: HTMLTextAreaElement } });
HTMLFormElement.prototype = Object.create(HTMLElement.prototype, { constructor: { value: HTMLFormElement } });
const TAG_PROTO = { input: HTMLInputElement.prototype, textarea: HTMLTextAreaElement.prototype, form: HTMLFormElement.prototype };

// 焦点与监听登记是整个垫片实例共享的状态;install() 时重置
const shared = { active: null, focusCbs: [], listenerTargets: {}, root: null, body: null, EV: null };

function clampSel(v, s) {
  const n = Number(v) | 0;
  return n < 0 ? 0 : n > s.length ? s.length : n;
}

// 切换焦点:旧元素 blur/focusout(relatedTarget=新元素或 null),新元素 focus/focusin。
// focus/blur 不冒泡,focusin/focusout 冒泡 —— 与浏览器一致,引擎在 flutter-view 上听 focusin/focusout。
function setActive(next, origin) {
  const prev = shared.active;
  if (prev === next) return;
  shared.active = next;
  const EV = shared.EV;
  if (prev) {
    prev.dispatchEvent(new EV.FocusEvent('blur', { relatedTarget: next || null, bubbles: false }));
    prev.dispatchEvent(new EV.FocusEvent('focusout', { relatedTarget: next || null, bubbles: true }));
  }
  if (next) {
    next.dispatchEvent(new EV.FocusEvent('focus', { relatedTarget: prev || null, bubbles: false }));
    next.dispatchEvent(new EV.FocusEvent('focusin', { relatedTarget: prev || null, bubbles: true }));
  }
  shared.focusCbs.slice().forEach((cb) => { try { cb(next || null); } catch (e) { /* 回调异常不影响焦点 */ } });
}

function makeElement(tag, ctx) {
  const el = {
    tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(), nodeType: 1,
    style: makeStyle(), children: [], childNodes: [],
    classList: {
      add() {}, remove() {}, contains() { return false; }, toggle() {},
    },
    attributes: {}, dataset: {},
    clientWidth: ctx.width, clientHeight: ctx.height,
    offsetWidth: ctx.width, offsetHeight: ctx.height,
    scrollWidth: ctx.width, scrollHeight: ctx.height,
    scrollTop: 0, scrollLeft: 0,
    clientTop: 0, clientLeft: 0, offsetTop: 0, offsetLeft: 0, offsetParent: null,
    textContent: '', checked: false, disabled: false, id: '', className: '',
    _parent: null,
    get parentNode() { return this._parent; },
    get parentElement() { return this._parent; },
    get isConnected() {
      let n = this;
      while (n) { if (n === shared.root) return true; n = n._parent; }
      return false;
    },
    // 修复轮 1:仅从 children/childNodes 数组摘除 + 断开 _parent,不 touch 焦点 ——
    // 供 _adopt() 在"挪到新父节点"时使用。_adopt 挪走旧父节点后紧接着就把节点
    // 挂到新父节点下,节点全程仍连接到文档,不应触发 blur/focusout(纯 reparent
    // 场景,例如把仍聚焦的 input 从 a 挪到 b)。真正的"离开文档"由 removeChild
    // 判断并处理。
    _detach(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); }
      if (c && c._parent === this) c._parent = null;
      return c;
    },
    _adopt(c) {
      if (c && c._parent && c._parent !== this) c._parent._detach(c);
      if (c && typeof c === 'object') c._parent = this;
      return c;
    },
    appendChild(c) { this._adopt(c); this.children.push(c); this.childNodes.push(c); return c; },
    append(...nodes) { for (const n of nodes) this.appendChild(n); },
    prepend(...nodes) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        this._adopt(nodes[i]); this.children.unshift(nodes[i]); this.childNodes.unshift(nodes[i]);
      }
    },
    insertBefore(c, ref) {
      this._adopt(c);
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) { this.children.push(c); this.childNodes.push(c); }
      else { this.children.splice(i, 0, c); this.childNodes.splice(i, 0, c); }
      return c;
    },
    removeChild(c) {
      // 修复轮 1:焦点是否要交出,看的是"被摘节点的子树里是否含当前焦点"
      // (c.contains(active) 已经把 active===c 的直接摘除也覆盖了),不是
      // 摘除动作本身。且必须在断开 _parent 之前派发 blur/focusout —— 冒泡沿
      // parentNode 走,断开之后 _parent 已是 null,祖先(引擎在 flutter-view
      // 上监听 focusout)就收不到了。reparent 走 _detach,不经过这里,不受影响。
      if (shared.active && c && typeof c.contains === 'function' && c.contains(shared.active)) {
        setActive(null, null);
      }
      return this._detach(c);
    },
    replaceChildren(...nodes) {
      this.children.slice().forEach((c) => this.removeChild(c));
      this.append(...nodes);
    },
    remove() { if (this._parent) this._parent.removeChild(this); },
    contains(n) {
      while (n) { if (n === this) return true; n = n._parent; }
      return false;
    },
    focus() { setActive(this, this); },
    blur() { if (shared.active === this) setActive(null, this); },
    _value: '', _selStart: 0, _selEnd: 0,
    get value() { return this._value; },
    set value(v) { this._value = v == null ? '' : String(v); this._selStart = this._selEnd = this._value.length; },
    get selectionStart() { return this._selStart; },
    set selectionStart(v) { this._selStart = clampSel(v, this._value); },
    get selectionEnd() { return this._selEnd; },
    set selectionEnd(v) { this._selEnd = clampSel(v, this._value); },
    setSelectionRange(s, e) { this._selStart = clampSel(s, this._value); this._selEnd = clampSel(e, this._value); },
    after() {}, before() {}, replaceWith() {},
    closest() { return null; }, matches() { return false; },
    cloneNode() { return makeElement(tag, ctx); },
    getRootNode() { return null; },
    scrollIntoView() {},
    insertAdjacentElement() { return null; }, insertAdjacentHTML() {}, insertAdjacentText() {},
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
    // Phase 5 Task 2 修复轮 1:真实引擎把 flt-platform-view-slot/flt-scene 等
    // 挂在 flt-glass-pane 的 shadow root 里(dom_manager.dart)。之前这里返回
    // 一个游离元素,既没记到 host.shadowRoot(调用方拿不到它),也没有任何
    // 连通性——shadow root 子树里的元素 isConnected 恒为 false(因为它们的
    // `_parent` 链条走到 shadow root 自身就断了,shadow root 从不是任何
    // "正常"父节点的子节点)。这里把 shadow root 记到 host.shadowRoot、
    // sr.host 记回宿主,并把 sr._parent 设成宿主本身——不是真实 DOM 语义
    // (真实 shadowRoot.parentNode 该是 null),但用它换来"沿 _parent 链条
    // 一路走到 shared.root"的 isConnected 判断对 shadow 内节点也能直接生效,
    // 不用另外维护一套"host 是否连通"的复合规则。原生视图同步层判断"是否
    // 还在合成树里"用的是另一套更直接的标准(链条能否走到 flt-scene),不
    // 依赖这里的 isConnected,但保留这个修复是为了让垫片本身对 shadow DOM
    // 的建模基本自洽,其余消费者(未来可能有)也能用上。
    //
    // ★ Minor:`sr._parent = this` 是"用现成的 _parent 链条换连通性"的权宜
    // 之计,与真实 DOM 语义有三处已知偏差,专门记在这里免得以后被当成
    // bug 修:
    //   1. `host.contains(影子树里的节点)` 在这里会返回 `true`——真实 DOM
    //      的 `contains()` 不穿透 shadow 边界(需要走 composed path 才行)。
    //   2. `shadowRoot.parentNode` 在这里是 `host`——真实 DOM 里是 `null`
    //      (只有 `shadowRoot.host` 指回宿主,没有反向的 parentNode)。
    //   3. 影子树内派发的冒泡事件会一路冒泡到 host 的祖先——真实 DOM 对
    //      `mode:'open'` 的 shadow root 确实会跨界冒泡,但会把
    //      `event.target` 重定向成宿主本身(composed + retargeting);这里
    //      没实现重定向,外部监听器拿到的 `target` 仍是影子树内的原始节点。
    // 三处目前都没有消费方依赖这些精确语义(原生视图同步层判断"是否还在
    // 合成树里"走的是另一套更直接的标准,见 native-views.js),不影响
    // Phase 5 Task 2 的正确性。
    attachShadow() {
      const sr = makeElement('shadow-root', ctx);
      sr.host = this;
      sr._parent = this;
      this.shadowRoot = sr;
      return sr;
    },
    animate() { return { cancel() {}, finish() {}, play() {}, pause() {}, addEventListener() {} }; },
    normalize() {}, click() {}, select() {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return k in this.attributes; },
    // 真实事件系统:必须保存监听器并让 dispatchEvent 真正派发,否则引擎在
    // flt-semantics-placeholder 上注册的 click 会全部丢失 —— 这条通道同时是
    // Phase 2 触摸输入与 semantics 激活的前置。写成自包含形式(只用 this 和参数),
    // 不依赖只在某一作用域才存在的变量。
    // ★ 同一套实现在 element / document / window 三处逐字重复(未抽公共
    //   工厂,避免大改动风险)——三处状态各自独立、互不共享,修 bug 时
    //   三处要同步改。
    _listeners: null,
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return;
      this._listeners = this._listeners || {};
      (this._listeners[type] = this._listeners[type] || []).push(fn);
      // 登记"曾经注册过该类型监听器的元素"(供 shim.listenerTargets(type) 查询)——
      // Task 4 触摸桥接靠它反查该往哪些元素派发合成的 pointer 事件。
      const reg = (shared.listenerTargets[type] = shared.listenerTargets[type] || []);
      if (reg.indexOf(this) < 0) reg.push(this);
    },
    removeEventListener(type, fn) {
      const l = this._listeners && this._listeners[type];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatchEvent(ev) {
      try { ev.target = ev.target || this; ev.currentTarget = this; } catch (e) { /* 忽略只读字段 */ }
      const l = this._listeners && this._listeners[ev && ev.type];
      if (l && l.length) {
        l.slice().forEach((fn) => {
          try { fn.call(this, ev); } catch (e) { /* 监听器异常不应打断派发 */ }
        });
      }
      // 冒泡:bubbles:true 的事件沿 parentNode 继续派发,直到 stopPropagation()
      // 置位 _mpStop 或走到没有 parentNode 的节点为止。本元素没有监听器也要
      // 继续冒泡(例如 focusin 常常只在 flutter-view 这层祖先上监听)。
      if (ev && ev.bubbles && !ev._mpStop && this._parent) this._parent.dispatchEvent(ev);
      return true;
    },
    getBoundingClientRect() {
      return { x: 0, y: 0, left: 0, top: 0, right: ctx.width, bottom: ctx.height, width: ctx.width, height: ctx.height };
    },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getContext() { return null; },
    get firstChild() { return this.childNodes[0] || null; },
    set innerHTML(_v) {}, get innerHTML() { return ''; },
  };

  if (String(tag).toLowerCase() === 'canvas') {
    const node = ctx.canvas;
    // ctx.glContext 缓存 + normalizeGl:真机 canvas.getContext 非幂等
    // (第二次调用返回 null),必须缓存首次拿到的上下文并复用,否则引擎
    // 创建第二块 canvas 时就拿不到 GL 了。同 normalizeGl 一样,从 spike
    // 移植、真机验证过、Task 12 装载器依赖,非孤立代码。
    // 所有 WebGL 用途的 canvas 元素共用这一个真实节点。引擎要 2d 画布只有两处:
    // 图片 toByteData(createDomCanvasElement(w,h) 后立即 getContext('2d'))与
    // web_paragraph(CanvasKit 渲染器不走)。小程序节点给不出 2d,于是 2d 画布
    // 走 image.js 的 SoftCanvas(CanvasKit CPU 光栅),完全不碰真实节点。
    // 元素在第一次 getContext 之前不知道自己将是哪种画布:这期间改的尺寸先记在
    // 元素上(pend),绑定 WebGL 时再写到节点,绑定 2d 时交给 SoftCanvas ——
    // 否则 toByteData 会先把主画布改成图片尺寸(随后还会被置 0×0),而且即便
    // 事后还原,改一次节点尺寸就会清掉当前一帧。
    let mode = null;         // null(未绑定)| 'gl' | '2d'
    const pend = {};         // 未绑定前设置的 width/height
    let soft = null;         // 2d 模式下的 SoftCanvas
    el.getContext = function (type, attrs) {
      if (type === '2d') {
        if (mode === 'gl') return null;   // 同浏览器:已有别种上下文则返回 null
        if (!soft) {
          if (!ctx.images) throw new Error("mp-flutter: 暂不支持 canvas.getContext('2d')(图片模块未安装)");
          soft = new ctx.images.SoftCanvas('width' in pend ? pend.width : 300, 'height' in pend ? pend.height : 150);
          mode = '2d';
        }
        return soft.getContext('2d');
      }
      if (mode === '2d') return null;
      // 小程序画布没有 webgl2(实测)。引擎启动时会先探测 webgl2 再回退 webgl;
      // 把这次探测转发给真实节点,基础库会打一条
      // `[error] Invalid context type [webgl2] for Canvas#getContext`,
      // 看起来像故障、还逼得每条 E2E 都要豁免它。结果本来就是 null,
      // 这里直接静默返回 null,不碰真实节点(K3)。
      if (type === 'webgl2' && !ctx.glContext) return null;
      if ((type === 'webgl' || type === 'webgl2') && mode !== 'gl') {
        mode = 'gl';
        try {
          if ('width' in pend) node.width = pend.width;
          if ('height' in pend) node.height = pend.height;
        } catch (e) { /* 只读节点则放弃 */ }
      }
      if (ctx.glContext && (type === 'webgl' || type === 'webgl2')) return ctx.glContext;
      const a = Object.assign({
        alpha: true, depth: true, stencil: true, antialias: false,
        premultipliedAlpha: true, preserveDrawingBuffer: false,
      }, attrs || {});
      try {
        let got = node.getContext(type, a);
        if (got && type === 'webgl') {
          got = normalizeGl(got);
          ctx.glContext = got;
        }
        return got;
      } catch (e) { return null; }
    };
    // 引擎按设备像素设 canvas.width/height,必须是 accessor 并转发到真实节点
    // (真机实测 1119x471);未绑定时先记下,2d 模式交给 SoftCanvas。
    const sizeProp = (name, setSoft, getSoft) => ({
      get() {
        if (mode === '2d') return getSoft();
        if (mode === null && name in pend) return pend[name];
        return node[name];
      },
      set(v) {
        if (mode === '2d') { setSoft(v); return; }
        if (mode === null) { pend[name] = Math.max(0, Math.floor(Number(v)) || 0); return; }
        try { node[name] = v; } catch (e) { /* 只读节点则放弃 */ }
      },
      configurable: true, enumerable: true,
    });
    Object.defineProperty(el, 'width', sizeProp('width', (v) => soft.setWidth(v), () => soft.getWidth()));
    Object.defineProperty(el, 'height', sizeProp('height', (v) => soft.setHeight(v), () => soft.getHeight()));
    el.transferToImageBitmap = function () { return null; };
    el.toDataURL = function () { return mode === '2d' ? soft.toDataURL() : ''; };
    el.__mpNode = node;
  }

  // <img>:引擎静态图解码路径(Blob → createObjectURL → img.decode()),见 image.js
  if (String(tag).toLowerCase() === 'img' && ctx.images) ctx.images.initImageElement(el);

  // 按标签设置原型,必须在 withRecord 包装之前 —— el 是普通对象字面量,
  // setPrototypeOf 后自身属性全部保留;withRecord 的 Proxy 未定义
  // getPrototypeOf 陷阱(默认转发到 target),所以 instanceof 对代理后的
  // 元素同样成立。
  const proto = TAG_PROTO[String(tag).toLowerCase()];
  if (proto) Object.setPrototypeOf(el, proto);

  return withRecord(el, tag + '<el>');
}

// 引擎硬依赖 ResizeObserver(无降级分支)。小程序画布尺寸基本不变,
// 但引擎要靠首次回调学到视口尺寸,所以必须异步回调一次。
function makeResizeObserver(W, H, dpr) {
  return function ResizeObserver(cb) {
    this.observe = function (target) {
      const box = [{ inlineSize: W, blockSize: H }];
      const entry = {
        target,
        contentRect: { x: 0, y: 0, left: 0, top: 0, right: W, bottom: H, width: W, height: H },
        borderBoxSize: box, contentBoxSize: box,
        devicePixelContentBoxSize: [{ inlineSize: W * dpr, blockSize: H * dpr }],
      };
      setTimeout(() => { try { cb([entry], this); } catch (e) { /* 回调异常不应影响垫片 */ } }, 0);
    };
    this.unobserve = function () {};
    this.disconnect = function () {};
  };
}

// 引擎硬要求 PointerEvent(没有就抛 UnsupportedError 拒绝启动)。
// 真正的触摸事件后续从 WXML 的 bind:touch* 桥接进来。
function makeEventCtors() {
  function Event(type, init) { Object.assign(this, { type, bubbles: false, cancelable: false }, init || {}); }
  Event.prototype.preventDefault = function () {};
  // stopPropagation 置位 _mpStop,element.dispatchEvent 冒泡循环据此中止 ——
  // 与浏览器一致(见 makeElement 内 dispatchEvent 的冒泡实现)。
  Event.prototype.stopPropagation = function () { this._mpStop = true; };
  Event.prototype.stopImmediatePropagation = function () { this._mpStop = true; };
  // 引擎的 pointer_binding.dart 在每次 pointerdown/move/up 都调用
  // event.getModifierState(...) 同步键盘修饰键状态(_checkModifiersState)——
  // 真机浏览器的 PointerEvent/MouseEvent/KeyboardEvent 都继承自带这个方法,
  // 我们的合成事件如果没有,调用直接抛 TypeError。因为 element.dispatchEvent
  // 内部把监听器异常吞掉了("监听器异常不应打断派发"),这个 TypeError 在
  // Task 4 真机 E2E 之前一直被静默吞掉,单测(touch.test.js 的 rec()) 从不
  // 调用 getModifierState 所以也测不出来——所有触摸事件因此被引擎悄悄丢弃。
  // ★ 修复轮 1 Important 1:字段名不是简单的 key.toLowerCase()+'Key' ——
  // 'Control' 对应的浏览器字段是 ctrlKey,不是 controlKey(其余三个凑巧能
  // 用小写规则算对,唯独 Control 不行),必须用显式映射表。
  const MODIFIER_KEY_FIELD = { Alt: 'altKey', Control: 'ctrlKey', Meta: 'metaKey', Shift: 'shiftKey' };
  Event.prototype.getModifierState = function (key) {
    const field = MODIFIER_KEY_FIELD[key];
    return field ? !!this[field] : false;
  };
  function mk(base) {
    const C = function (type, init) { base.call(this, type, init); };
    C.prototype = Object.create(base.prototype);
    C.prototype.constructor = C;
    return C;
  }
  const UIEvent = mk(Event), MouseEvent = mk(UIEvent);
  const PointerEvent = mk(MouseEvent), WheelEvent = mk(MouseEvent);
  const TouchEvent = mk(UIEvent), KeyboardEvent = mk(UIEvent);
  PointerEvent.prototype.getCoalescedEvents = function () { return [this]; };
  PointerEvent.prototype.getPredictedEvents = function () { return []; };
  const FocusEvent = mk(UIEvent), InputEvent = mk(UIEvent), CompositionEvent = mk(UIEvent);
  // ProgressEvent:XMLHttpRequest(Task 2)的 loadstart/progress/load/loadend
  // 等事件用它携带 lengthComputable/loaded/total。
  const ProgressEvent = mk(Event);
  // CustomEvent(Phase 5 Task 2):原生视图同步层用它把微信原生组件
  // (video/map/camera)的事件转发到 Flutter 侧的占位元素上,detail 走
  // Event 基类现成的 `Object.assign(this, ..., init)` 逻辑即可承载,不需要
  // 额外处理——真实 CustomEvent 也是"跟 Event 一样,多一个 detail 字段"。
  const CustomEvent = mk(Event);
  return { Event, UIEvent, MouseEvent, PointerEvent, WheelEvent, TouchEvent, KeyboardEvent,
           FocusEvent, InputEvent, CompositionEvent, ProgressEvent, CustomEvent };
}

/**
 * 内存版 History:引擎的路由(flutter/navigation)会 replaceState 写入
 * `{serialCount, state}`,随后读回 `history.state` 并做非空断言——
 * 桩实现恒返回 null 时,引擎在 `Null check operator used on a null value` 上崩掉
 * (模拟器实测)。push/replace 同步更新 location;back/go 异步派发 popstate,
 * 与浏览器一致。
 */
function makeHistory(loc, dispatch) {
  const entries = [{ state: null, url: '/' }];
  let index = 0;
  function applyUrl(url) {
    if (url == null) return;
    const m = /^(?:https?:\/\/[^/]*)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(String(url)) || [];
    loc.pathname = m[1] || loc.pathname || '/';
    if (loc.pathname[0] !== '/') loc.pathname = '/' + loc.pathname;
    loc.search = m[2] || '';
    loc.hash = m[3] || '';
    loc.href = loc.origin + loc.pathname + loc.search + loc.hash;
  }
  function current() { return loc.pathname + loc.search + loc.hash; }
  const h = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    scrollRestoration: 'auto',
    pushState(state, _title, url) {
      applyUrl(url);
      entries.splice(index + 1);
      entries.push({ state, url: current() });
      index = entries.length - 1;
    },
    replaceState(state, _title, url) {
      applyUrl(url);
      entries[index] = { state, url: current() };
    },
    go(delta) {
      const next = index + (delta | 0);
      if (!delta || next < 0 || next >= entries.length) return;
      index = next;
      applyUrl(entries[index].url);
      const state = entries[index].state;
      setTimeout(() => dispatch({ type: 'popstate', state }), 0);
    },
    back() { h.go(-1); },
    forward() { h.go(1); },
  };
  return h;
}

/**
 * 没有 Intl 时的最小替身,只有 `Locale`。
 *
 * 引擎启动时对 navigator.languages 逐个 `new Intl.Locale(tag)`,取
 * language/script/region 组成 ui.Locale(engine/.../platform_dispatcher.dart
 * parseBrowserLanguages),没有 Intl 就在启动阶段崩溃。引擎对 Intl 的其它用法
 * (Segmenter / v8BreakIterator)只在 chromium 版 CanvasKit 下才会走到,
 * 我们打包的是完整版(断行在 wasm 里用自带 ICU 完成),不需要。
 *
 * 只解析 BCP 47 的 `language[-script][-region]` 前缀,足够覆盖
 * navigator.languages 里的 zh-CN / zh-Hans-CN / en-US 这类取值。
 */
function makeMinimalIntl() {
  function Locale(tag) {
    if (!(this instanceof Locale)) throw new TypeError("Constructor Intl.Locale requires 'new'");
    const parts = String(tag).replace(/_/g, '-').split('-');
    this.language = (parts[0] || 'und').toLowerCase();
    this.script = undefined;
    this.region = undefined;
    let i = 1;
    if (parts[i] && /^[A-Za-z]{4}$/.test(parts[i])) {
      this.script = parts[i].charAt(0).toUpperCase() + parts[i].slice(1).toLowerCase();
      i++;
    }
    if (parts[i] && /^([A-Za-z]{2}|[0-9]{3})$/.test(parts[i])) this.region = parts[i].toUpperCase();
    this.baseName = [this.language, this.script, this.region].filter(Boolean).join('-');
  }
  Locale.prototype.toString = function () { return this.baseName; };
  return { Locale };
}

/**
 * 引擎看到的 Intl:挂到垫片的 window.Intl / self.Intl(dart2js 经 v.G=self 取全局,
 * 例如 `new v.G.Intl.Locale(tag)`)。
 *
 * 真机上 Intl 未必齐全:iOS(JavaScriptCore)没有 V8 独有的 v8BreakIterator;
 * 部分安卓微信的 JS 引擎整个没有 Intl(裸引用 `Intl` 直接 ReferenceError,
 * 只能 typeof 探测)。没有 Intl 时给 [makeMinimalIntl] 的最小替身。
 *
 * [simulate] 仅由 --verify --force-platform 传入,在开发者工具(V8)里模拟真机:
 *   · 'ios'            —— JavaScriptCore:没有 v8BreakIterator;Segmenter 一并遮蔽;
 *   · 'android-noIntl' —— 整个没有 Intl。
 */
function engineIntl(simulate) {
  const native = typeof Intl !== 'undefined' ? Intl : undefined;
  if (simulate === 'android-noIntl' || !native) return makeMinimalIntl();
  if (simulate === 'ios') {
    const o = Object.create(native);
    Object.defineProperty(o, 'v8BreakIterator', { value: undefined });
    Object.defineProperty(o, 'Segmenter', { value: undefined });
    return o;
  }
  return native;
}

// 可能缺失的全局只能 typeof 探测(安卓真机的 JS 引擎连 Intl 都可能没有,其余
// 宿主提供的全局同理不能假设)。ECMAScript 语言本身的内建(Object/Promise/
// Proxy/BigInt 等)真机都有,不在此列。
const maybeGlobal = {
  BigInt64Array: typeof BigInt64Array !== 'undefined' ? BigInt64Array : undefined,
  BigUint64Array: typeof BigUint64Array !== 'undefined' ? BigUint64Array : undefined,
  // queueMicrotask 是宿主(HTML/Node)提供的,不是 JS 引擎内建;缺失时用原生 Promise 排微任务
  queueMicrotask: typeof queueMicrotask === 'function'
    ? queueMicrotask : (cb) => { Promise.resolve().then(cb); },
};

function install(opts) {
  const canvas = opts.canvas, width = opts.width, height = opts.height, dpr = opts.dpr || 1;
  const ctx = { canvas, width, height, images: null };
  const g = globalThis;
  const IntlForEngine = engineIntl(opts.simulate);

  // 自带 polyfill 必须在构造其余全局对象之前装好。
  const perf = makePerformance();
  const EncoderClass = makeTextEncoderClass();
  const DecoderClass = makeTextDecoderClass();
  installPolyfills(g, perf, EncoderClass, DecoderClass);

  // 图片解码(Blob / URL.createObjectURL / <img>.decode()),CanvasKit 由 boot 经 opts.CK 传入
  // opts.nativeImage(boot 默认传入):静态 JPEG/PNG 由微信原生解码,见 image.js 文件头
  const nativeImage = opts.nativeImage && typeof wx !== 'undefined'
    ? {
        node: canvas, wx, mode: opts.nativeImage.mode,
        // timeoutMs/maxTotalBytes:仅供单测注入更短的超时/更小的总字节上限
        // (I2),不传时 image.js 用各自默认值。
        timeoutMs: opts.nativeImage.timeoutMs, maxTotalBytes: opts.nativeImage.maxTotalBytes,
      }
    : null;
  const images = imageMod.createImageSupport({
    getCK: () => opts.CK || null, TextEncoder: EncoderClass, TextDecoder: DecoderClass,
    native: nativeImage,
  });
  ctx.images = images;
  // self.OffscreenCanvas:引擎只有图片 cacheWidth/cacheHeight 缩放这一处会在
  // 多画布光栅器下构造它(new self.OffscreenCanvas),由 image.js 用 CanvasKit
  // CPU 光栅实现。能力探测读的是 window.OffscreenCanvas
  // (browserSupportsOffscreenCanvas),那里保持 undefined,光栅器选择不变。

  const RO = makeResizeObserver(width, height, dpr);
  const EV = makeEventCtors();
  // localStorage 由小程序同步存储承载,sessionStorage 用纯内存实现;
  // window 与 self 共用同一份实例,保证两处读写一致(dart2js 两处都可能取)。
  const localStorage = storageMod.createWxStorage({ wx });
  const sessionStorage = storageMod.createMemoryStorage();
  // shared 是模块级单例(跨 install() 调用),必须在每次 install() 开头重置,
  // 否则同一 Node 进程内先后 install() 两次(理论上可能,例如测试复用同一
  // vm context)会残留上一份焦点/监听登记状态。
  shared.active = null; shared.focusCbs = []; shared.listenerTargets = {}; shared.EV = EV;

  // 引擎按 UA 决定 defaultTargetPlatform 与文本编辑策略:Android 真机上继续
  // 伪装 iPhone 会得到 iOS 风格交互与 iOS 文本策略,与用户预期不符。模拟器
  // (devtools)与未知平台沿用 iPhone,保证 Phase 1/2 的 E2E 基线不变。
  const android = opts.platform === 'android';
  const navigator = withRecord({
    userAgent: android
      ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0'
      : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0',
    platform: android ? 'Linux armv8l' : 'iPhone',
    vendor: android ? 'Google Inc.' : 'Apple Computer, Inc.',
    language: 'zh-CN', languages: ['zh-CN', 'zh'],
    maxTouchPoints: 5, hardwareConcurrency: 4, onLine: true,
    mediaDevices: undefined, clipboard: undefined,
  }, 'navigator');

  const documentElement = makeElement('html', ctx);
  const body = makeElement('body', ctx);
  const head = makeElement('head', ctx);
  documentElement.append(head, body);
  shared.root = documentElement;
  shared.body = body;

  const document = withRecord({
    nodeType: 9, visibilityState: 'visible', hidden: false, baseURI: 'https://mp.local/',
    documentElement, body, head, currentScript: null, defaultView: null,
    createElement: (tag) => makeElement(tag, ctx),
    createElementNS: (ns, tag) => makeElement(tag, ctx),
    createTextNode: (t) => ({ nodeType: 3, textContent: t, remove() {} }),
    createDocumentFragment: () => makeElement('fragment', ctx),
    createEvent: () => ({ initEvent() {} }),
    querySelector: (sel) => {
      const q = String(sel);
      if (/meta/i.test(q)) { const m = makeElement('meta', ctx); m.content = ''; return m; }
      if (/base/i.test(q)) { const b = makeElement('base', ctx); b.href = 'https://mp.local/'; return b; }
      return null;
    },
    querySelectorAll: () => [],
    getElementById: () => null, getElementsByTagName: () => [],
    // 真实事件系统,理由同 makeElement —— 不依赖只在 element 作用域才有的变量。
    _listeners: null,
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return;
      this._listeners = this._listeners || {};
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const l = this._listeners && this._listeners[type];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatchEvent(ev) {
      const l = this._listeners && this._listeners[ev && ev.type];
      if (!l || !l.length) return true;
      try { ev.target = ev.target || this; ev.currentTarget = this; } catch (e) { /* 忽略只读字段 */ }
      l.slice().forEach((fn) => {
        try { fn.call(this, ev); } catch (e) { /* 监听器异常不应打断派发 */ }
      });
      return true;
    },
    fonts: { add() {}, delete() {}, clear() {}, ready: Promise.resolve(), forEach() {}, addEventListener() {}, status: 'loaded' },
    get activeElement() { return shared.active || body; }, hasFocus: () => true,
  }, 'document');

  const loc = {
    href: 'https://mp.local/', origin: 'https://mp.local', protocol: 'https:',
    host: 'mp.local', hostname: 'mp.local', pathname: '/', search: '', hash: '',
  };
  // win 在下面才建好;history 派发 popstate 时再取
  let win = null;
  const history = makeHistory(loc, (ev) => win && win.dispatchEvent(ev));

  win = withRecord({
    document, navigator, console, performance: perf,
    // dart2js 从 window 上取这些来建 interceptor 派发表,必须是真构造函数。
    Object, Array, Function, String, Number, Boolean, Symbol, BigInt,
    Math, JSON, Date, RegExp, Promise, Proxy, Reflect, Intl: IntlForEngine,
    Error, TypeError, RangeError, SyntaxError,
    Map, Set, WeakMap, WeakSet,
    ArrayBuffer, DataView,
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array,
    BigInt64Array: maybeGlobal.BigInt64Array, BigUint64Array: maybeGlobal.BigUint64Array,
    WeakRef: typeof WeakRef !== 'undefined' ? WeakRef : undefined,
    FinalizationRegistry: typeof FinalizationRegistry !== 'undefined' ? FinalizationRegistry : undefined,
    Event: EV.Event, UIEvent: EV.UIEvent, MouseEvent: EV.MouseEvent,
    PointerEvent: EV.PointerEvent, WheelEvent: EV.WheelEvent,
    TouchEvent: EV.TouchEvent, KeyboardEvent: EV.KeyboardEvent,
    FocusEvent: EV.FocusEvent, InputEvent: EV.InputEvent, CompositionEvent: EV.CompositionEvent,
    ProgressEvent: EV.ProgressEvent, CustomEvent: EV.CustomEvent,
    HTMLElement, HTMLInputElement, HTMLTextAreaElement, HTMLFormElement,
    onpointerdown: null, onpointermove: null, onpointerup: null,
    TextEncoder: EncoderClass, TextDecoder: DecoderClass,
    AbortController, AbortSignal, Headers,
    localStorage, sessionStorage,
    Blob: images.Blob, URL: images.URL,
    // 这些必须显式 undefined,引擎靠 `X != null` 走降级分支。
    SharedArrayBuffer: undefined, ArrayBufferView: undefined, CanvasPixelArray: undefined,
    OffscreenCanvas: undefined, createImageBitmap: undefined, FontFace: undefined,
    WebGLRenderingContext: undefined,
    MutationObserver: undefined, ResizeObserver: RO, IntersectionObserver: undefined,
    ImageDecoder: undefined, WebAssembly: undefined, Worker: undefined,
    devicePixelRatio: dpr, innerWidth: width, innerHeight: height,
    outerWidth: width, outerHeight: height,
    screen: { width, height, availWidth: width, availHeight: height, orientation: { type: 'portrait-primary', addEventListener() {} } },
    location: loc,
    history,
    // 真实事件系统,理由同 makeElement —— 不依赖只在 element 作用域才有的变量。
    _listeners: null,
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return;
      this._listeners = this._listeners || {};
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const l = this._listeners && this._listeners[type];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatchEvent(ev) {
      const l = this._listeners && this._listeners[ev && ev.type];
      if (!l || !l.length) return true;
      try { ev.target = ev.target || this; ev.currentTarget = this; } catch (e) { /* 忽略只读字段 */ }
      l.slice().forEach((fn) => {
        try { fn.call(this, ev); } catch (e) { /* 监听器异常不应打断派发 */ }
      });
      return true;
    },
    getComputedStyle: (el) => (el && el.style) ? el.style : makeStyle(),
    getSelection: () => null,
    scrollTo() {}, scrollBy() {}, focus() {}, blur() {},
    matchMedia: (q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (cb) => canvas.requestAnimationFrame(cb),
    cancelAnimationFrame: (id) => canvas.cancelAnimationFrame(id),
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask: maybeGlobal.queueMicrotask,
    fetch: () => Promise.reject(new Error('mp: no fetch')),
    flutterConfiguration: undefined, // 引擎会读,留位
    visualViewport: undefined,        // 显式 undefined,让引擎走 fallback
    // crypto.getRandomValues(K4):留位,显式 undefined。真正的赋值在 boot.js——
    // 那里 await 完 wx.getRandomValues 播种 ChaCha20 DRBG 之后才装(必须在
    // manifest.loadDart() 之前);wx.getRandomValues 不存在或播种失败时这里
    // 保持 undefined,dart:math 的 Random.secure() 按浏览器无该 API 时的语义
    // 抛 Unsupported,不伪造安全性。
    crypto: undefined,
  }, 'window');

  // K5:dart2js 的 scheduleMicrotask(Future 续体、await 恢复都走它)依次探测
  // self.scheduleImmediate → MutationObserver+document → self.setImmediate,
  // 全没有就退化成 Timer.run(setTimeout 0)。小程序里后两者都没有(MutationObserver
  // 必须显式 undefined),于是 Dart 微任务全变成宏任务,rAF 驱动的下一帧能插进任意
  // await 之间——引擎 ViewRasterizer.draw() 在 `await prepareToDraw()` 之后才
  // preroll 当前场景(engine/.../compositing/rasterizer.dart:83-87),中间插进来的
  // 下一帧 drawFrame 里框架 OffsetLayer.engineLayer 换新、dispose 旧 engine layer
  // 连带其 picture,preroll(layer/layer_visitor.dart:176)读已 dispose 的
  // picture.cullRect → "Null check operator used on a null value"。浏览器里
  // 微任务总在下一个 rAF 之前跑完,不会有这个窗口。这里补上真微任务语义。
  // 用原生 Promise 的 then 排微任务,不用宿主的 queueMicrotask:后者在个别基础库
  // 版本里可能是 setTimeout 垫的,会悄悄把窗口带回来。
  const resolved = Promise.resolve();
  const scheduleImmediate = (cb) => { resolved.then(cb); };

  // dart2js 把 self 当全局持有者用(v.G.window.flutterCanvasKit / self._flutter / self.scheduleImmediate)
  const selfObj = withRecord({
    window: win, document, navigator, console, performance: perf,
    location: win.location, self: null, globalThis: null,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask: maybeGlobal.queueMicrotask,
    scheduleImmediate,
    // dart2js 把 self 当全局持有者(v.G),ES 全局函数都得在。
    parseInt, parseFloat, isNaN, isFinite, NaN, Infinity,
    encodeURI, encodeURIComponent, decodeURI, decodeURIComponent,
    String, Number, Boolean, TypeError, RangeError, SyntaxError, ReferenceError,
    WeakRef: typeof WeakRef !== 'undefined' ? WeakRef : undefined,
    FinalizationRegistry: typeof FinalizationRegistry !== 'undefined' ? FinalizationRegistry : undefined,
    BigInt64Array: maybeGlobal.BigInt64Array, BigUint64Array: maybeGlobal.BigUint64Array,
    SharedArrayBuffer: undefined,
    Promise, Object, Array, Function, Math, JSON, Date, RegExp, Error, Symbol,
    Map, Set, WeakMap, WeakSet, Proxy, Reflect, BigInt, Intl: IntlForEngine,
    ArrayBuffer, DataView, Uint8Array, Int8Array, Uint8ClampedArray, Int16Array,
    Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
    TextEncoder: EncoderClass, TextDecoder: DecoderClass,
    AbortController, AbortSignal, Headers,
    localStorage, sessionStorage,
    Blob: images.Blob, URL: images.URL,
    // 以下显式 undefined,让引擎走无 DOM 降级路径(这是关键)。
    MutationObserver: undefined, ResizeObserver: RO, IntersectionObserver: undefined,
    // OffscreenCanvas 例外:见上面 self.OffscreenCanvas 的注释
    OffscreenCanvas: images.OffscreenCanvas, createImageBitmap: undefined, FontFace: undefined,
    WebGLRenderingContext: undefined,
    requestAnimationFrame: (cb) => canvas.requestAnimationFrame(cb),
    cancelAnimationFrame: (id) => canvas.cancelAnimationFrame(id),
    Event: EV.Event, UIEvent: EV.UIEvent, MouseEvent: EV.MouseEvent,
    PointerEvent: EV.PointerEvent, WheelEvent: EV.WheelEvent,
    TouchEvent: EV.TouchEvent, KeyboardEvent: EV.KeyboardEvent,
    FocusEvent: EV.FocusEvent, InputEvent: EV.InputEvent, CompositionEvent: EV.CompositionEvent,
    ProgressEvent: EV.ProgressEvent, CustomEvent: EV.CustomEvent,
    // ★ dart2js 的 A.ec(a,'HTMLInputElement') 类型判断是从 v.G(=全局 self,
    // 即本对象)上按名取构造器再 instanceof,不是从 window 上取 —— 只把这些
    // 挂在 win 上(如本文件早先版本/brief 字面描述)时,真机 rememberd
    // `Unsupported DOM element type: <INPUT>` 复现(E2E 实测抓到)。两处都挂,
    // 覆盖引擎两种取法。
    HTMLElement, HTMLInputElement, HTMLTextAreaElement, HTMLFormElement,
    _flutter: undefined, flutterCanvasKit: undefined, flutterConfiguration: undefined,
    // crypto.getRandomValues(K4):同 window.crypto 留位,dart2js 从 self(v.G)
    // 取全局,两处都要有(理由同 HTMLInputElement 一族)。boot.js 负责实际赋值。
    crypto: undefined,
  }, 'self');
  selfObj.self = selfObj;
  selfObj.globalThis = selfObj;
  win.self = selfObj;

  // 尝试注入真全局(模拟器里 globalThis.window 只有 getter,会失败 ——
  // 所以引擎不能只依赖这条路,但仍要如实记录成败供构建期诊断)。
  // ★ 每一项都必须映射到垫片化的对象,不能是裸 globalThis/g —— 真机上这里
  //   可写(模拟器不可写,两者行为相反),一旦写成功,编译产物里任何裸
  //   self 引用都会解析到未经垫片处理的真实全局,丢掉显式 undefined 标记、
  //   self 上的 ES 全局函数补丁,以及 self.self/self.window 的自洽性。
  const globalsOk = {};
  for (const [k, v] of [['window', win], ['document', document], ['navigator', navigator],
                        ['self', selfObj], ['top', win], ['parent', win]]) {
    try {
      Object.defineProperty(g, k, { value: v, writable: true, configurable: true });
      globalsOk[k] = 'ok';
    } catch (e) {
      try { g[k] = v; globalsOk[k] = 'assign'; }
      catch (e2) { globalsOk[k] = 'FAIL'; }
    }
  }
  try {
    if (typeof g.HTMLCanvasElement === 'undefined') {
      g.HTMLCanvasElement = function HTMLCanvasElement() {};
    }
  } catch (e) { /* 只读全局则放弃 */ }

  // 可靠通道:挂到本模块导出,main.dart.js 的构建期 preamble 用模块级 var 读取。
  M.window = win; M.document = document; M.navigator = navigator; M.self = selfObj;
  M.location = win.location; M.globalsOk = globalsOk;

  return {
    window: win, document, navigator, self: selfObj, location: win.location,
    globalsOk, report, touched, images,
    get glContext() { return ctx.glContext || null; },
    // Task 4(触摸桥接)/Task 5(文本输入)依赖:反查曾注册过某类型监听器的元素,
    // 以及焦点切换的外部回调通道(WXML 侧无法直接监听 DOM 事件,需要这条桥)。
    // ★ 用 Array.from(...) 而非 .slice():shim 代码运行在独立的 vm Context
    // 里,数组字面量/.slice() 产生的数组绑定的是该 Context 自己的 Array.prototype
    // (与调用方所在的宿主 realm 不是同一个 intrinsic,即便 sandbox.Array 就是宿主
    // Array 引用也一样 —— 字面量语法不查标识符,只认执行所在 realm 的内建);
    // assert.deepStrictEqual 对跨 realm 数组会报 "same structure but not
    // reference-equal"。这里显式引用全局 Array(经 sandbox 绑定到宿主 Array)
    // 调用其 from() 静态方法构造结果数组,使其落在宿主 realm,便于测试/调用方
    // 用 deepStrictEqual 比较(mp-context 单测踩过这个坑;真机小程序引擎不经过
    // vm.Context,不受影响)。
    listenerTargets: (type) => Array.from(shared.listenerTargets[type] || []),
    onFocusChange(cb) {
      shared.focusCbs.push(cb);
      return () => { const i = shared.focusCbs.indexOf(cb); if (i >= 0) shared.focusCbs.splice(i, 1); };
    },
  };
}

const M = module.exports = { install, report };
