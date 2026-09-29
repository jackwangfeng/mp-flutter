'use strict';
/**
 * 引擎的隐藏输入框 ↔ 小程序原生 <input>/<textarea>。
 *
 * 引擎(text_editing.dart)编辑文本时会建一个 <input>/<textarea>,通过样式
 * 把它摆到文本框的位置、设成透明,然后 focus;用户输入经 input 事件读回
 * value/selectionStart/selectionEnd。小程序里没有真实 DOM,这里观察垫片上
 * 被聚焦的那个元素,在同一位置叠一个透明的原生输入框接收键盘与输入法,
 * 再把结果写回引擎的元素。文字与光标仍由 Flutter 渲染。
 *
 * 已知限制:
 * - 几何只取 transform 的平移分量。TextField 位于缩放/旋转的父组件下时,原生框的
 *   尺寸与字号不准,影响触摸命中范围与输入法候选框的锚点位置。
 * - 透明原生框在聚焦期间覆盖 TextField 区域,框内的触摸由原生框消费、到不了画布,
 *   所以框内点击挪光标、长按选词不可用(光标位置以原生框为准)。
 *
 * ## I1 修复:密码框聚焦/失焦时通知 Dart 侧(见 entrypoint.dart
 * `_steadyCursorOnIOS` 的注释、本文件 `createPasswordFocusBridge`)
 *
 * iOS 目标平台下入口包装让 TextField 光标常亮不闪(避免聚焦期间持续 60fps
 * 出帧),副作用是密码框隐藏"刚输入的那个字符"依赖的光标 tick 也停了,最后
 * 一位会一直明文显示。这里在检测到聚焦/失焦元素是 `password:true` 时,经
 * `opts.passwordFocus`(`self.__mpPasswordFocus`,boot.js 在 loadDart 之前挂上)
 * 通知入口包装临时切回闪烁、失焦后恢复常亮。
 *
 * ## M6 修复:轮询退避后需要能被主动唤醒
 *
 * 空闲超过 `IDLE_AFTER_MS` 后轮询退到 `IDLE_POLL_MS`,引擎侧的变化最多要等
 * 这么久才同步到原生框(见下文 `IDLE_POLL_MS` 注释的窄窗口场景)。触摸画布
 * (`touchstart`)、键盘高度变化(两者都很可能紧接着有文本框几何/焦点变化)
 * 时调用返回对象上新增的 `wake()`,主动回到逐帧轮询,见 pipeline.dart 的
 * `onMpTouch`/`wx.onKeyboardHeightChange`。
 *
 * ## I3 修复(2026-09-27 终审):`--semantics-mirror` 打开、语义树被激活后
 *
 * 引擎的 `HybridTextEditing.strategy` 一旦 `EngineSemantics.instance.
 * semanticsEnabled`(`text_editing.dart`),就从 `createDefaultTextEditingStrategy`
 * 切换成 `SemanticsTextEditingStrategy`(`semantics/text_field.dart`)——真正的
 * `<input>`/`<textarea>` 从此不再是"直接挂在 `flt-text-editing-host` 下、自己
 * 的 `style.left/top/transform` 就是完整绝对位置"的独立浮层,而是被
 * `SemanticTextField._initializeEditableElement()` **append 进它自己所属的
 * `<flt-semantics>` 节点**,自身样式恒为 `top:0;left:0`、无 `transform`——
 * 真正的屏幕位置由这个 `<flt-semantics>` 祖先(以及它自己的祖先链)的
 * `transform` 决定(`SemanticsObject.recomputePositionAndSize`,与
 * `semantics-mirror.js` 的 `computeRect` 面对同一套约定:框架用**物理像素**
 * 描述语义节点几何,`<flt-semantics-host>` 用一个 `scale(1/dpr)` 在根上整体
 * 换算成 CSS 逻辑像素)。只读 `el` 自己的样式(旧实现)在这种情况下永远读到
 * `left:0;top:0`,原生框因此叠在屏幕左上角而不是真正的 TextField 位置——
 * E2E(`accept-interact.js --semantics-mirror` 构建)实测:输入法能弹出、
 * 但 `.mp-input` 找不到真正对应的位置,后续读值/清空验证全部落空。
 *
 * 修法:`compute()` 不再只读 `el` 自身,而是沿 `parentNode` 链一路向上累加
 * 每一层自己的 `left`(px)+`transform` 平移分量,直到碰到
 * `<flt-semantics-host>`(把已经累加的物理像素乘上它 `scale(...)` 解出的
 * 系数、换算成 CSS 逻辑像素,然后停止——host 自己没有位移,只有缩放)或者
 * 祖先链走到头都没碰到 host(普通场景:标准 `TextEditingStrategy` 把
 * `<input>` 直接挂在 `flt-text-editing-host` 下,沿途没有任何祖先带
 * `transform`/`left`/`top`,累加结果与只读 `el` 自身完全一致,不影响
 * `--semantics-mirror` 关闭时的既有行为)。宽/高同样要乘这个换算系数——
 * CSS `transform: scale(...)` 是对整棵子树生效的,后代自己写的像素尺寸在
 * 视觉上也会被这个缩放影响,`el.style.width/height` 与语义 rect 一样是
 * 物理像素。
 */
const POLL_MS = 16;
/**
 * 聚焦后几何/值一直没变时的轮询间隔。每次轮询都要读样式、算几何、序列化比较,
 * 16ms 一次在无 JIT 的 iOS 上是持续的主线程占用(模拟器实测聚焦期间约 6.5ms/s,
 * 真机按 25~30 倍估算 150~200ms/s);有变化(引擎挪了位置、原生输入、推了值)
 * 就立刻回到 POLL_MS,IDLE_AFTER_MS 内都没变化才退到这个间隔。滚动列表时原生框
 * 最多晚一个 IDLE_POLL_MS 跟上,之后恢复逐帧跟随。
 */
const IDLE_POLL_MS = 100;
const IDLE_AFTER_MS = 500;

function parseTranslate(transform) {
  const s = String(transform || '');
  const m = /matrix3d\(([^)]+)\)/.exec(s);
  if (m) {
    const v = m[1].split(',').map(Number);
    return { x: v[12] || 0, y: v[13] || 0 };
  }
  // 实测引擎(IOSTextEditingStrategy)几何就绪后写的是 2D matrix(a,b,c,d,e,f)
  const m2 = /matrix\(([^)]+)\)/.exec(s);
  if (m2) {
    const v = m2[1].split(',').map(Number);
    return { x: v[4] || 0, y: v[5] || 0 };
  }
  const t = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(s);
  return t ? { x: Number(t[1]), y: Number(t[2]) } : { x: 0, y: 0 };
}
const px = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };

function tagOf(n) { return n && n.tagName; }

/** `scale(...)` 的系数(与 `semantics-mirror.js` 的 `parseScale` 同一份契约:
 * `<flt-semantics-host>` 恒以这种形式表达物理像素→逻辑像素的换算)。解析
 * 失败返回 null,调用方按"不缩放"处理。 */
function parseHostScale(transform) {
  const m = /scale\(([^)]+)\)/.exec(String(transform || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return isFinite(n) && n > 0 ? n : null;
}

/**
 * 见文件头"I3 修复"一节:从 [el] 自身起沿 `parentNode` 链累加 `left`+
 * `transform` 平移,直到碰到 `<flt-semantics-host>`(语义树激活后,文本
 * 输入元素被 `SemanticTextField` 挂进语义树,真正的位置来自这条祖先链)或
 * 者链走到头(标准场景:`<input>` 直接挂在 `flt-text-editing-host` 下,
 * 沿途没有祖先带非零 transform/left/top,累加结果等同于只读 `el` 自身)。
 * 返回的 `scale` 是找到 host 时解出的物理→逻辑像素换算系数(未找到 host
 * 时为 1),`width`/`height` 与 `x`/`y` 一样需要乘这个系数才是 CSS 逻辑像素
 * (`scale(...)` 对整棵子树生效,影响后代的视觉尺寸,不止位置)。
 */
function accumulateGeometry(el) {
  let x = 0;
  let y = 0;
  let hostScale = 1;
  let n = el;
  while (n && n.style) {
    const t = parseTranslate(n.style.transform);
    x += t.x + px(n.style.left);
    y += t.y + px(n.style.top);
    if (tagOf(n) === 'FLT-SEMANTICS-HOST') {
      const s = parseHostScale(n.style.transform);
      if (s != null) hostScale = s;
      break;
    }
    n = n.parentNode;
  }
  return { x: x * hostScale, y: y * hostScale, scale: hostScale };
}

// 垫片元素上未定义的属性一读就会被记成"触达未实现 API"(每 16ms 轮询一次),
// 所以先用 in 判断(has 陷阱不记录)再读属性,否则退回特性。
function prop(el, name, attr) {
  if (name in el && el[name] != null && el[name] !== '') return String(el[name]);
  const a = el.getAttribute ? el.getAttribute(attr) : null;
  return a == null ? '' : String(a);
}

function inputKind(el) {
  const mode = prop(el, 'inputMode', 'inputmode');
  const type = prop(el, 'type', 'type') || 'text';
  if (type === 'password') return { type: 'text', password: true };
  if (mode === 'numeric') return { type: 'number', password: false };
  if (mode === 'decimal') return { type: 'digit', password: false };
  return { type: 'text', password: false };
}

function confirmTypeOf(el) {
  const hint = String(el.getAttribute && el.getAttribute('enterkeyhint') || '');
  return ['done', 'next', 'search', 'send', 'go'].indexOf(hint) >= 0 ? hint : 'done';
}

/**
 * 密码框聚焦状态 → Dart 入口包装(I1 修复,见 entrypoint.dart 里
 * `_steadyCursorOnIOS` 的注释)。
 *
 * iOS 目标平台下入口包装把 `EditableText.debugDeterministicCursor` 设成
 * `true`(光标常亮、消除聚焦期间的 60fps 淡入淡出动画),副作用是密码框隐藏
 * 刚输入那个字符所依赖的光标 tick 也停了——密码框最后一位会一直明文显示,
 * 直到下一次输入或失焦。这里把"当前是否有 password:true 的输入框聚焦"这个
 * 布尔状态报给 Dart 侧,入口包装监听后聚焦时临时把标志切回 false、失焦后
 * 恢复 true。
 *
 * 必须在 `manifest.loadDart()`(main.dart.js 执行、入口包装 `main()` 跑)之前
 * 就把 `bridge` 挂到 `self.__mpPasswordFocus`(见 boot.js),否则入口包装
 * `main()` 里注册监听时读不到全局——文本桥本身是 boot 成功之后、承载页
 * onLoad 里才创建的(见 pipeline.dart),创建时把这里返回的对象整个传给
 * `createTextBridge({ passwordFocus: ... })`,两边共享同一个 `bridge`。
 */
function createPasswordFocusBridge() {
  const listeners = [];
  const bridge = {
    obscure: false,
    /** 订阅变化;返回取消函数。回调异常不影响其它订阅者。 */
    listen(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
  };
  return {
    bridge,
    /** 供 text-bridge 在聚焦/失焦时调用;值未变不重复通知。 */
    set(v) {
      v = !!v;
      if (v === bridge.obscure) return;
      bridge.obscure = v;
      listeners.slice().forEach((fn) => { try { fn(); } catch (e) { /* 订阅者异常不影响其它订阅者 */ } });
    },
  };
}

function createTextBridge(opts) {
  const shim = opts.shim;
  const scale = shim.window.innerWidth / opts.cssWidth;
  let el = null;            // 当前被引擎聚焦的输入元素
  let lastNative = null;    // 上次从原生收到的值
  let pushed = null;        // 自上次原生输入以来推给原生的值(null = 没推过)
  let lastSent = '';        // 上次发给页面的序列化状态
  let timer = null;
  let lastActive = 0;       // 最近一次有变化(发出状态 / 原生输入 / 新聚焦)的时间
  let session = 0;          // 每检测到一次新的聚焦元素递增;原生框带着它,迟到的 blur 据此识别
  let paused = false;       // 承载页切后台时暂停轮询(onHide/onShow)

  function isEditable(n) {
    const tag = n && String(n.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea';
  }

  function compute() {
    if (!el || !el.isConnected || shim.document.activeElement !== el) return { visible: false, focus: false };
    const st = el.style;
    // I3 修复:不再只读 el 自己的 left/top/transform——语义树激活后真正的
    // 位置来自它所属的 <flt-semantics> 祖先链(见文件头"I3 修复"一节)。
    const geo = accumulateGeometry(el);
    // iOS 策略的离屏阶段:可能是 top/left:-9999px,实测更常见的是
    // transform: translate(-9999px, -9999px)(top/left 为 0),故按叠加后的位置判断
    if (geo.y < -1000 || geo.x < -1000) return { visible: false, focus: false };
    const font = /(\d+(?:\.\d+)?)px/.exec(String(st.font || st.fontSize || ''));
    const kind = inputKind(el);
    const state = {
      visible: true,
      focus: true,
      session: session,
      multiline: String(el.tagName).toLowerCase() === 'textarea',
      type: kind.type,
      password: kind.password,
      confirmType: confirmTypeOf(el),
      left: geo.x / scale,
      top: geo.y / scale,
      width: (px(st.width) * geo.scale) / scale,
      height: (px(st.height) * geo.scale) / scale,
      fontSize: font ? Number(font[1]) / scale : 16,
      cursor: el.selectionEnd,
    };
    // 只在引擎侧值与原生侧当前值不同时推 value,避免打断输入法组字。原生侧当前值
    // 是上次从原生收到的值,推过之后就是推过去的值(否则"清空后又改回原值"推不出去)。
    const nativeHas = pushed !== null ? pushed : lastNative;
    if (el.value !== nativeHas) { state.value = el.value; pushed = el.value; }
    return state;
  }

  // 去重按"除 value 外的字段"比较:value 只在推送的那一个状态里出现,下一个 tick
  // 它消失并不代表有变化,不应再发一次状态(页面侧 value 缺省即"不动原生值")。
  function tick() {
    if (opts.onStats) {
      const t0 = Date.now();
      tickInner();
      try { opts.onStats(Date.now() - t0); } catch (e) { /* 诊断失败不影响输入 */ }
      return;
    }
    tickInner();
  }
  function tickInner() {
    const s = compute();
    const rest = Object.assign({}, s);
    delete rest.value;
    const key = JSON.stringify(rest);
    if (key !== lastSent || 'value' in s) { lastSent = key; lastActive = Date.now(); opts.onState(s); }
  }

  // setTimeout 链(不是 setInterval):间隔随活跃程度变,见 IDLE_POLL_MS
  function loop() {
    timer = null;
    if (paused || !el) return;
    tick();
    if (paused || !el) return;
    timer = setTimeout(loop, Date.now() - lastActive > IDLE_AFTER_MS ? IDLE_POLL_MS : POLL_MS);
  }
  function start() {
    lastActive = Date.now();
    if (!timer && !paused) timer = setTimeout(loop, POLL_MS);
    tick();
  }
  function stop() { if (timer) { clearTimeout(timer); timer = null; } tick(); }
  // 有变化的迹象(原生输入等):回到逐帧轮询
  function wake() {
    lastActive = Date.now();
    if (timer && !paused && el) { clearTimeout(timer); timer = setTimeout(loop, POLL_MS); }
  }
  function attach(n) {
    el = n; session++; lastNative = null; pushed = null;
    // I1 修复:聚焦元素是否 password:true 的密码框,报给 Dart 侧(见
    // createPasswordFocusBridge 文档)
    if (opts.passwordFocus) opts.passwordFocus.set(inputKind(n).password);
    start();
  }

  const off = shim.onFocusChange((n) => {
    if (isEditable(n)) attach(n);
    else { el = null; stop(); if (opts.passwordFocus) opts.passwordFocus.set(false); }
  });
  // 桥可能晚于引擎聚焦创建(例如 autofocus 的输入框在引擎启动期间就已聚焦),
  // 此时不会再有焦点切换通知,创建时主动接管一次
  if (isEditable(shim.document.activeElement)) attach(shim.document.activeElement);

  return {
    nativeInput(ev) {
      if (!el) return;
      const value = String(ev.value == null ? '' : ev.value);
      const cursor = ev.cursor == null ? value.length : ev.cursor;
      lastNative = value;
      pushed = null;
      wake();
      el.value = value;
      el.setSelectionRange(cursor, cursor);
      el.dispatchEvent(new shim.window.Event('input', { bubbles: true }));
    },
    nativeConfirm() {
      if (!el) return;
      el.dispatchEvent(new shim.window.KeyboardEvent('keydown', { keyCode: 13, which: 13, key: 'Enter', code: 'Enter', bubbles: true }));
    },
    /**
     * [fromSession] 是发出 blur 的原生框所属会话(WXML data-session)。焦点 A→B 时
     * 被 wx:if 销毁的 A 框的 blur 可能在 B 聚焦之后才到,若照转会让 B 立刻失焦
     * (引擎收到 relatedTarget=null 的 blur 即关闭输入连接)——过期会话一律丢弃。
     * 不带会话(undefined)时按当前会话处理。
     */
    nativeBlur(fromSession) {
      if (fromSession !== undefined && fromSession !== null && Number(fromSession) !== session) return;
      if (el && shim.document.activeElement === el) el.blur();
    },
    /** 切后台:停掉轮询定时器(不改焦点与状态)。 */
    pause() {
      paused = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    /** 回前台:仍有聚焦元素则恢复轮询并立即同步一次。 */
    resume() {
      if (!paused) return;
      paused = false;
      if (el) start();
    },
    /**
     * M6 修复:轮询退避后,引擎侧变化最多要等 IDLE_POLL_MS 才追上(见文件头
     * `IDLE_POLL_MS` 注释)。触摸画布开始交互、或键盘高度变化(两者都很可能
     * 紧接着有文本框几何/焦点变化)时调这个,主动回到逐帧轮询,不等窄窗口里
     * 的旧值被下一次操作用旧数据覆盖。
     */
    wake() { wake(); },
    dispose() {
      off();
      if (timer) clearTimeout(timer);
      timer = null;
      if (opts.passwordFocus) opts.passwordFocus.set(false);
    },
  };
}

/**
 * 桥状态 → 承载页 setData。
 *
 * 用户输入时页面数据里的 mpInput.value 不跟着变(每次按键都 setData 回写会打断
 * 输入法),所以页面数据可能停在上次推送的旧值上。此时若引擎要推的值恰好等于这个
 * 旧值(典型:首次聚焦推 '',用户输入后引擎 controller.clear() 又推 ''),视图层
 * diff 可能认为没变化、不更新组件,原生框仍显示旧文本。办法:这种情况下先写一次
 * 原生侧当前值(对原生框是空操作,但让页面数据变了),在回调里再写目标值。
 * @param setData (patch, cb?) => void,即 page.setData
 */
function createViewSync(rawSetData, onSetData) {
  // onSetData(patch, ms):仅 --perf-hud 传入,量每次 setData 同步部分的耗时
  const setData = typeof onSetData !== 'function' ? rawSetData : function (patch, cb) {
    const t0 = Date.now();
    rawSetData(patch, cb);
    try { onSetData(patch, Date.now() - t0); } catch (e) { /* 忽略 */ }
  };
  let viewValue;     // 页面数据里实际的 mpInput.value
  let nativeValue;   // 原生框当前实际显示的值(用户输入上报 / 真正落地的写入)
  let cursor;        // 最近一次状态里的 cursor(第二步写沿用最新值,不回滚光标)
  // 只有可能与待写目标冲突的事件才递增:带 value 的 apply、真实的原生输入。
  // 不带 value 的心跳态(光标/几何变化)不冲突,不得使待写的第二步失效。
  let seq = 0;
  return {
    nativeInput(v) { seq++; nativeValue = String(v == null ? '' : v); },
    apply(s) {
      if ('cursor' in s) cursor = s.cursor;
      const patch = { 'mpInput.visible': s.visible };
      Object.keys(s).forEach((k) => { if (k !== 'visible' && k !== 'value') patch['mpInput.' + k] = s[k]; });
      if (!s.visible) {
        // wx:if 销毁原生框;下次显示时按页面数据重建,原生值即页面数据
        nativeValue = viewValue;
        setData(patch);
        return;
      }
      // value 缺省表示"原生侧已是最新",不覆盖(避免打断输入法)
      if (!('value' in s)) { setData(patch); return; }
      const mine = ++seq;
      const target = s.value;
      if (target === viewValue && nativeValue !== undefined && nativeValue !== target) {
        patch['mpInput.value'] = nativeValue;
        viewValue = nativeValue;
        setData(patch, () => {
          // 期间有新的带 value 的 apply 或原生输入:目标已过期,放弃(否则会回滚新输入)。
          // 放弃时 nativeValue 保持由那次事件给出的真实值,不留下"以为已推送"的状态
          if (mine !== seq) return;
          const p2 = { 'mpInput.value': target };
          if (cursor !== undefined) p2['mpInput.cursor'] = cursor;
          viewValue = target;
          // nativeValue 只在第二步真正写出时才更新;若此刻原生框已被 wx:if 销毁,
          // 重建时取页面数据,同样等于 target
          nativeValue = target;
          setData(p2);
        });
      } else {
        patch['mpInput.value'] = target;
        setData(patch);
        viewValue = target;
        nativeValue = target;
      }
    },
  };
}

module.exports = { createTextBridge, createViewSync, createPasswordFocusBridge };
