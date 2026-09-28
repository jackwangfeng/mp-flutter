'use strict';
/**
 * 原生视图同步层(Phase 5 Task 2)。
 *
 * Flutter 侧(Task 3)用 `HtmlElementView` 占位:Dart 工厂造一个
 * `<div data-mp-native="video|map|camera" data-mp-params="{...}"
 * data-mp-id="7">`(★ id 只能是数字字符串——同步层拿它拼 `mpv-`/`mpm-`
 * 前缀当 wx 原生组件的 id,也是 `mpNative`/`mpNativeList` 的 key),真正
 * 挂进引擎的合成树。
 *
 * 修复轮 1(2026-09-27 评审)之前,这里按错误的 DOM 结构假设实现:以为
 * `flt-platform-view-slot`/`flt-clip`/`flt-scene` 与占位 div 在同一棵树里
 * 直接嵌套。真实结构(`dom_manager.dart`,探针文档 §2)是**两棵树**:
 *
 *   轻量 DOM(div 实际所在的地方):
 *     flutter-view > flt-glass-pane > flt-platform-view[slot="flt-pv-slot-N"]
 *       > div[data-mp-native]
 *   flt-glass-pane 的 **shadow root** 内(承载几何的地方):
 *     flt-scene > flt-clip* > flt-platform-view-slot > slot[name="flt-pv-slot-N"]
 *
 * `<slot>` 只是把轻量 DOM 里的 `flt-platform-view` 投影到影子树里那个位置
 * 显示——`flt-platform-view` 的 `parentNode` 仍然是 `flt-glass-pane`,不是
 * `flt-platform-view-slot`。要拿几何,必须先从 div 找到它的
 * `flt-platform-view`(带 `slot` 属性),再去 `flt-glass-pane.shadowRoot`
 * 里按同名 `<slot>` 反查对应的 `flt-platform-view-slot`。
 *
 * 引擎的 `_applyMutators`(`platform_views/embedder.dart`)是从"离 slot 最近
 * 的一层"到"最外层"依次处理、每遇到裁剪就换新的 `flt-clip` 当 head 并把
 * transform 清零重新累计的——结果是 slot 本身与每一层 `flt-clip` **各自**
 * 带着自己那一段平移量,只有最外层那一段因为混入了 dpr 换算而需要
 * `e/a, f/d` 归一化,其余每一层(含 slot 自己)都是直接可用的逻辑像素平移
 * (探针 §2/§4)。修复轮 1 之前只读了"最外层"一层的 transform,滚动时如果
 * 平移量落在内层(单层裁剪时落在 slot 上,有 widget 自身裁剪——如
 * ClipRRect——时落在那层内层裁剪上,探针 §4 实测),算出来的位置就纹丝
 * 不动。现在的算法从最外层到 slot 逐层累加(最外层 `e/a,f/d`,其余原样
 * `e,f`),每层裁剪矩形都换算成"累加到该层为止"的共享坐标系再求交。
 *
 * 不能挨条监听 CSS 写入再转发(探针 §4 实测:一次滚动手势里每帧都会重写整套
 * clip/slot 样式,折算下来一次 20 秒的 E2E 会话就有 3792 条样式写入)——那样
 * setData 频率会远超预算。这里改用 rAF 节流:每帧只读一次"最终"几何,和上次
 * 上报值做浅比较(几何量按 0.5 逻辑像素取整去抖动),只有真正变化的 id 才进
 * 这一帧的 setData patch,且整帧只发一次 setData;几何字段与 `params` 走
 * 各自独立的 `mpNative.<id>.xxx` dot-path(而不是整个对象重发),避免
 * `params` 没变时也被重新序列化一遍占掉 setData 预算,也避免"只发部分字段"
 * 时不小心用 `mpNative.<id>` 这个整对象路径把兄弟字段覆盖掉。
 *
 * 没有任何原生视图、也没有排队中的原生组件命令、也没有"已登记但还没找到"
 * 的 id 时,rAF 循环会自己停下来(不再每帧扫描)。
 *
 * ★ Task 3 工厂的调用约定(修复轮 2,2026-09-27 复审 Important):创建占位
 * 元素那一刻,`self.__mpNative` 可能还不存在——`boot()` 的 promise 要等
 * `app.runApp()` 的 Future 完成才 resolve,而这层是 boot 成功之后才创建的;
 * `runApp()` 对首帧的调度是异步的,真机/E2E 实测过:工厂函数完全可能跑在
 * `createNativeViews()` 之前。约定是:
 *   - 有 `self.__mpNative` 就调 `self.__mpNative.register(id)`;
 *   - 没有就把 id push 进 `self.__mpNativePending`(数组,自己按需创建),
 *     `createNativeViews()` 创建时会读一次、处理完就把这个全局删掉。
 * 对应视图 dispose(在还没被引擎发现之前就没了,例如用户飞快切走某个从没
 * 渲染过的 Tab)时调 `self.__mpNative.unregister(id)`,允许同步层在真的没有
 * 事情可做时停下来——不调也不会错(最多是"已登记但永远发现不了"的 id 让
 * 循环多跑一阵子,不会内存泄漏到不可控的地步,`known`/`pending` 该释放的
 * 还是会释放),但会让循环无谓地跑得更久。
 *
 * 修复轮 2 之前,"没有视图就停"这条本身有两个洞(复审 Important,复现见
 * `tools/mp-context/native-views.test.js` 里"宽限期"相关的用例):
 *   ① `register(id)` 调 `wake()`,而 `wake()` 在循环已经在跑(`scheduled`
 *      为真,宽限期倒计时进行中)时直接短路返回——`emptyStreak` 根本没被
 *      重置,`register()` 等于白调,宽限期该到还是到。
 *   ② 哪怕 ① 修好了,"注册过一次就万事大吉"也不成立:`IndexedStack`/
 *      `Offstage` 一类场景下,所有 Tab 的工厂在启动时就会全部跑一遍(哪怕
 *      当前不可见),但对应的 `flt-platform-view` 只有在真正切到那个 Tab
 *      才会被引擎合成进树——这中间可能隔着用户看了很久别的 Tab 才切过去,
 *      远超任何合理的宽限期,而 Task 3 的工厂不会因为"用户还没切过去"就
 *      反复重新调用 `register()`。
 * 现在的修复(三管齐下):
 *   - `register(id)` 把 id 记进"已登记未发现"集合(`awaiting`),只要这个
 *     集合非空,循环的空闲判断直接跳过(不看宽限期倒计时),在该 id 被
 *     发现(进了 `known`)或被 `unregister()` 之前一直跑下去。
 *   - 循环真正判定空闲、停下来之后,改为保留一条低频兜底轮询(约每 1000ms
 *     一次,只扫 `flt-glass-pane` 的直接子节点,便宜),扫到任何新的
 *     `data-mp-native` 元素就唤醒 rAF 循环——即使 Task 3 那边完全没调
 *     `register()`/`unregister()`,这条兜底也保证最终能发现。
 *   - `self.__mpNativePending`(见上面的调用约定)接住"工厂跑在
 *     `__mpNative` 挂上去之前"这个时序缝隙。
 */

// ---------------------------------------------------------------------
// 纯函数部分:matrix()/clip-path 解析、区间求交、像素取整、树遍历——不依赖
// 可变状态,单独测好。
// ---------------------------------------------------------------------

/** 允许负数、小数、指数记法的数字。 */
const NUM = '-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?';
const NUM_RE = new RegExp(NUM, 'g');

/** `matrix(a,0,0,d,e,f)` → {a,d,e,f};'none'/空/解析失败按单位矩阵处理。 */
function parseMatrix(str) {
  const m = /matrix\(([^)]+)\)/.exec(String(str || ''));
  if (!m) return { a: 1, d: 1, e: 0, f: 0 };
  const v = m[1].split(',').map(Number);
  return { a: v[0] || 0, d: v[3] || 0, e: v[4] || 0, f: v[5] || 0 };
}

function parsePx(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

/**
 * `clip-path: rect(top right bottom left [round R])`(引擎对 clipRect/
 * 等半径 clipRRect 发出的语法,见探针文档 §2)。无法识别的 `path(...)`
 * (非矩形/非等半径裁剪)退化为其数值上的包围盒——按"偶数位是 x、奇数位是 y"
 * 分别取值再求 min/max(而不是把所有数字混在一起求一个包围盒,那样会把
 * x/y 的量纲搅在一起,矩形/长宽比完全失真),由调用方负责只警告一次。
 */
function parseClipRect(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const rx = new RegExp('^rect\\(\\s*(' + NUM + ')px\\s+(' + NUM + ')px\\s+(' +
    NUM + ')px\\s+(' + NUM + ')px(?:\\s+round\\s+(' + NUM + ')px)?\\s*\\)$');
  const m = rx.exec(s);
  if (m) {
    return {
      top: Number(m[1]), right: Number(m[2]), bottom: Number(m[3]), left: Number(m[4]),
      radius: m[5] != null ? Number(m[5]) : null,
    };
  }
  if (/^path\(/.test(s)) {
    const nums = (s.match(NUM_RE) || []).map(Number);
    if (nums.length < 4) return null;
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    if (!xs.length || !ys.length) return null;
    return {
      left: Math.min.apply(null, xs), right: Math.max.apply(null, xs),
      top: Math.min.apply(null, ys), bottom: Math.max.apply(null, ys),
      radius: null, degenerate: true,
    };
  }
  return null;
}

function intersectRect(a, b) {
  return {
    left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
  };
}

/** 0.5 逻辑像素取整——吸收探针 §4 记录的、滚动动画里逐帧的次像素抖动。 */
function roundPx(v) { return Math.round(v * 2) / 2; }
function roundOpacity(v) { return Math.round(v * 1000) / 1000; }

function tagOf(n) { return n && n.tagName; }

/** 从 [el] 起向上找最近的、tagName 为 [tag] 的祖先(不含 el 自身)。 */
function findAncestorTag(el, tag) {
  let n = el && el.parentNode;
  while (n) {
    if (tagOf(n) === tag) return n;
    n = n.parentNode;
  }
  return null;
}

/** 从 [root] 起(含 root 自身的子树,不含 root 本身)先序找第一个满足
 * [predicate] 的后代;找到就早退,不是每帧都要把整棵树走完。 */
function findDescendant(root, predicate) {
  const kids = (root && root.children) || [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (predicate(c)) return c;
    const found = findDescendant(c, predicate);
    if (found) return found;
  }
  return null;
}

/**
 * 从占位 div 找到它在 `flt-glass-pane` 影子树里对应的
 * `flt-platform-view-slot`(见文件头注释的两棵树关系)。任何一步找不到都
 * 返回 null——调用方按"这个 id 暂时/不再可用"处理,不抛错。
 */
function findSlotFor(div) {
  const pv = div.parentNode;
  if (!pv || tagOf(pv) !== 'FLT-PLATFORM-VIEW') return null;
  const slotName = pv.getAttribute && pv.getAttribute('slot');
  if (!slotName) return null;
  const glassPane = findAncestorTag(pv, 'FLT-GLASS-PANE');
  const shadowRoot = glassPane && glassPane.shadowRoot;
  if (!shadowRoot) return null;
  const slotEl = findDescendant(shadowRoot,
    (n) => tagOf(n) === 'SLOT' && n.getAttribute && n.getAttribute('name') === slotName);
  if (!slotEl) return null;
  const slot = slotEl.parentNode;
  if (!slot || tagOf(slot) !== 'FLT-PLATFORM-VIEW-SLOT') return null;
  return slot;
}

/**
 * 按探针文档 §2/§4/§6(经 2026-09-27 评审修复轮 1 订正)计算一个占位元素
 * (div[data-mp-native])的屏幕几何。
 *
 * 位置:从 `slot` 起沿 `flt-clip` 祖先链向上走到 `flt-scene`(中途断链——
 * 走到 null 都没碰到 flt-scene——说明这块视图暂时/已经不在合成树里,
 * 返回 null),从**最外层**到 **slot 自身**依次累加每一层自己的平移:
 * 最外层 `matrix(a,0,0,d,e,f)` 取 `e/a, f/d`(除法抵消探针实测到的、
 * 这一层混入的 dpr 换算,如 `168/3==56`),其余每一层(含 slot)原样加
 * `e, f`(它们是已经归一化过的逻辑像素平移,不需要再除)。
 *
 * 裁剪:每层 `flt-clip` 自己的 `clip-path` 矩形定义在"该层自身、变换生效前"
 * 的局部坐标系里,换算成共享坐标系时要加上"从最外层累加到该层为止"的平移
 * (而不是只加最外层那一段,或者干脆不加)——这正是当前累加器 `accX/accY`
 * 在处理到该层那一刻的值,天然就是对的,不需要另外再算一遍。层数 >2 时
 * 退化为只按最内层裁剪(忽略更深祖先的 clip-path,但平移量仍然要照常逐层
 * 累加,不能跳过)并只警告一次——超过两层在真实布局里少见(list/grid/page
 * 视口裁剪 + 至多一层 widget 自身裁剪)。
 */
function computeGeometry(div, viewport, warn) {
  const slot = findSlotFor(div);
  if (!slot) return null;
  const width = parsePx(slot.style.width);
  const height = parsePx(slot.style.height);
  const opacityRaw = parseFloat(slot.style.opacity);
  const opacity = isFinite(opacityRaw) ? opacityRaw : 1;

  const clipsInner2Outer = [];
  let n = slot.parentNode;
  let reachedScene = false;
  while (n) {
    if (tagOf(n) === 'FLT-SCENE') { reachedScene = true; break; }
    if (tagOf(n) === 'FLT-CLIP') clipsInner2Outer.push(n);
    n = n.parentNode;
  }
  if (!reachedScene) return null;

  const layers = clipsInner2Outer.slice().reverse(); // 最外层在前,slot 不含在内
  let fallback = false;
  let keepIdx = -1;
  if (layers.length > 2) {
    fallback = true;
    keepIdx = layers.length - 1; // 只保留最内层的 clip-path
  }

  let accX = 0;
  let accY = 0;
  let clipRect = null;
  let radius = null;
  layers.forEach((clipEl, idx) => {
    const M = parseMatrix(clipEl.style.transform);
    if (idx === 0) { accX += M.a ? M.e / M.a : M.e; accY += M.d ? M.f / M.d : M.f; }
    else { accX += M.e; accY += M.f; }

    if (fallback && idx !== keepIdx) return; // 平移已经累加,只是不参与求交
    const raw = clipEl.style['clip-path'];
    const r = parseClipRect(raw);
    if (!r) return;
    if (r.degenerate) {
      warn('pathClip', '[native-views] clip-path 是非矩形/非等半径的 path(...),' +
        '已退化为其数值包围盒: ' + raw);
    }
    if (radius === null && r.radius != null) radius = r.radius;
    const shared = { left: r.left + accX, right: r.right + accX, top: r.top + accY, bottom: r.bottom + accY };
    clipRect = clipRect ? intersectRect(clipRect, shared) : shared;
  });
  if (fallback) {
    warn('clipDepth', '[native-views] 裁剪层级超过 2 层(' + layers.length +
      '),已退化为只按最内层裁剪,更深的祖先被忽略(平移量仍按全部层数累加)');
  }

  // slot 自身也带一段平移(单层裁剪时,探针实测滚动偏移经常就落在这里)。
  // 只有在完全没有 flt-clip 祖先时(理论上不该发生,Viewport 至少有 1 层
  // 裁剪),slot 才被当成"最外层"套用 e/a,f/d 的归一化公式。
  const slotM = parseMatrix(slot.style.transform);
  if (layers.length === 0) {
    accX += slotM.a ? slotM.e / slotM.a : slotM.e;
    accY += slotM.d ? slotM.f / slotM.d : slotM.f;
  } else {
    accX += slotM.e;
    accY += slotM.f;
  }

  const x = accX;
  const y = accY;
  const itemBox = { left: x, right: x + width, top: y, bottom: y + height };
  const boundedByClip = clipRect ? intersectRect(clipRect, itemBox) : itemBox;
  const viewportBox = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const finalVisible = intersectRect(boundedByClip, viewportBox);
  const hidden = (finalVisible.right - finalVisible.left) <= 0 ||
                 (finalVisible.bottom - finalVisible.top) <= 0;

  // clip 字段只在"确实发生了裁剪"(可见区域比 item 自己的框小)或者存在圆角
  // (需要靠外层 view 的 border-radius 表现出来,即便当前没被滚动裁掉)时才
  // 非空——两者都不成立时,WXML 没必要多包一层裁剪容器。
  const actuallyClipped = boundedByClip.left > itemBox.left || boundedByClip.top > itemBox.top ||
    boundedByClip.right < itemBox.right || boundedByClip.bottom < itemBox.bottom;
  let clip = null;
  if (radius != null || actuallyClipped) {
    clip = {
      left: roundPx(boundedByClip.left), top: roundPx(boundedByClip.top),
      width: roundPx(Math.max(0, boundedByClip.right - boundedByClip.left)),
      height: roundPx(Math.max(0, boundedByClip.bottom - boundedByClip.top)),
      radius: radius || 0,
    };
  }

  return {
    x: roundPx(x), y: roundPx(y), width: roundPx(width), height: roundPx(height),
    opacity: roundOpacity(opacity), hidden, clip,
  };
}

/**
 * I1 修复(2026-09-27 终审):门面桥。`createNativeViews()` 本身仍然要等
 * 承载页 boot 成功之后才创建(需要真实 DOM/rAF/setData),但 Dart 侧
 * (`registry_web.dart`)的 `isAvailable => _bridge != null` 只看
 * `self.__mpNative` 是否存在——`MpNativeView.build()`(`mp_native_view.dart`)
 * 在它为 false 时直接返回 `fallback`,以后不会再自己重新读一次(没有任何
 * 东西触发 rebuild)。如果桥只在 boot 成功、`createNativeViews()` 跑过之后
 * 才出现,Dart 侧一旦在这之前 build 过一次,就永久停在 fallback 上。
 *
 * 修法(boot.js 对应注释):在 `manifest.loadDart()` 之前,把这里造的门面
 * 挂到 `self.__mpNative`/`window.__mpNative`——与 `__mpWechat` 同样的时机
 * 要求。门面只负责"排队",不做任何真正的发现/几何/派发:
 *   - `register(id)`/`unregister(id)`:等价于 `__mpNativePending` 的语义,
 *     记一笔"已登记未发现"、或者撤回。
 *   - `command(id, method, argsJson)`:返回的 Promise 先放进队列,不在门面
 *     阶段 settle。
 * `createNativeViews()` 接管时用 `drain()` 一次性取走这批积压——`ids` 直接
 * 并入 `awaiting`,`commands` 逐条重放到真正的 `command()` 实现上、并把
 * 结果接回门面阶段已经返回给调用方的那个 Promise。调用方(Dart 侧的
 * `sendCommand`)全程感知不到中间发生过一次"门面→真身"的切换。
 *
 * 只有 boot.js 会创建并安装这个门面——普通 web(未经 mp-flutter boot 流程)
 * 里没有它,`_bridge == null`,`isAvailable` 仍然是 false、走 fallback,
 * 这条判断不受影响。
 */
function createNativeFacade() {
  const registered = []; // 有序,保留插入序(drain 时原样并入 awaiting)
  const commandQueue = []; // { id, method, argsJson, resolve, reject }

  function register(id) {
    const s = String(id);
    if (registered.indexOf(s) < 0) registered.push(s);
  }

  function unregister(id) {
    const s = String(id);
    const i = registered.indexOf(s);
    if (i >= 0) registered.splice(i, 1);
  }

  function command(id, method, argsJson) {
    return new Promise(function (resolve, reject) {
      commandQueue.push({ id: String(id), method: method, argsJson: argsJson, resolve: resolve, reject: reject });
    });
  }

  return {
    bridge: { register: register, unregister: unregister, command: command },
    /** 接管时调用一次:取走目前积压的登记/命令,并清空门面自身的状态。 */
    drain: function () {
      const ids = registered.slice();
      const commands = commandQueue.slice();
      registered.length = 0;
      commandQueue.length = 0;
      return { ids: ids, commands: commands };
    },
  };
}

// ---------------------------------------------------------------------
// createNativeViews:挂到 shim/boot 之上的可变状态部分。
// ---------------------------------------------------------------------

const VIDEO_METHODS = ['play', 'pause', 'seek', 'stop', 'requestFullScreen', 'exitFullScreen'];
const MAP_METHODS = ['moveToLocation', 'getCenterLocation', 'includePoints'];
const CAMERA_METHODS = ['takePhoto'];

/** 未就绪(占位元素还没被首次 setData"落地"到视图层)时,command 等多久
 * 才放弃——而不是无限期挂起。 */
const PENDING_TIMEOUT_MS = 5000;

/**
 * I2 的"没有视图就停下来"不能是"一帧发现没有就立刻停"——真机/E2E 实测:
 * `boot()` 的 promise 要等 `app.runApp()` 的 Future 完成才 resolve,而
 * `runApp()` 对首帧的调度是异步的,platform view 工厂在首帧真正合成完成
 * (把 div 挂到 `flt-glass-pane` 之下)之前就可能已经跑过、也可能还没跑;
 * 同步层是在 boot 成功之后才创建的,它自己的第一帧 rAF 回调因此有可能比
 * "工厂创建的占位元素被引擎实际挂上树"还早——第一次 tick() 扫到空的时候,
 * 不代表真的没有原生视图,只是引擎还没来得及合成。给一段宽限期(约半秒,
 * 60fps 下 30 帧),这期间照常每帧扫描,超过宽限期仍然一无所获才真正认为
 * "这个页面没有原生视图"并停下来——`register()` 仍然是"之后才出现"的视图
 * (导航/滚动到新页面等)的正常唤醒路径,两者不冲突。
 */
const IDLE_GRACE_TICKS = 30;

/**
 * 循环真正判定"空闲"、停止 rAF 调度之后的兜底:每隔这么久(毫秒)用
 * `setTimeout` 廉价扫一次 `flt-glass-pane` 的直接子节点(不是完整 tick,
 * 只看有没有新的 `data-mp-native` 元素出现),扫到就唤醒 rAF 循环走正常的
 * `tick()` 路径。这条兜底不依赖 Task 3 有没有正确调用
 * `register()`/`unregister()`/`__mpNativePending`——哪怕契约完全没被遵守,
 * 最终也能在至多约 1s 的延迟内发现新出现的原生视图,不会永久失联。
 */
const IDLE_POLL_MS = 1000;

function createNativeViews(opts) {
  const shim = opts.shim;
  const wx = opts.wx;
  const setData = opts.setData;
  const raf = opts.raf;

  const known = new Map();     // id(string) → { id, el, type, rendered, lastGeoKey, lastParamsKey }
  const pending = new Map();   // id(string) → [{ method, argsJson, resolve, reject, timer }]
  // "已登记(register()/__mpNativePending)但还没在 known 里发现"的 id 集合——
  // 只要非空,循环就不认为自己空闲(见文件头"调用约定"注释),不依赖宽限期
  // 倒计时,也不依赖 register() 恰好没撞上"循环已经在跑"这个时机。
  const awaiting = new Set();
  const warned = {};           // 每类/每 id 的一次性警告去重
  let stopped = false;
  let scheduled = false;
  let glassPaneRef = null;
  let emptyStreak = 0;
  let idlePollTimer = null;    // 空闲时的低频兜底轮询(见 startIdlePoll)

  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    console.warn(msg);
  }

  function getGlassPane() {
    if (glassPaneRef && glassPaneRef.isConnected) return glassPaneRef;
    glassPaneRef = findDescendant(shim.document.body, (n) => tagOf(n) === 'FLT-GLASS-PANE');
    return glassPaneRef;
  }

  /**
   * I2 修复:不再每帧遍历整个 `document.body`——占位 div 必然是
   * `flt-glass-pane` 的"孙子"(glass-pane 直接子节点是 flt-platform-view,
   * 它的直接子节点才是 div),找到 glass-pane 一次、缓存住之后,往后每帧
   * 只需要扫它数量有限的直接子节点,不随全页面 DOM 规模增长。
   */
  function findNativeEls() {
    const gp = getGlassPane();
    if (!gp) return [];
    const out = [];
    const pvs = gp.children || [];
    for (let i = 0; i < pvs.length; i++) {
      const kids = pvs[i].children || [];
      for (let j = 0; j < kids.length; j++) {
        const c = kids[j];
        if (c && c.getAttribute && c.getAttribute('data-mp-native') != null) out.push(c);
      }
    }
    return out;
  }

  function failPendingFor(id, reason) {
    const q = pending.get(id);
    if (!q) return;
    pending.delete(id);
    q.forEach((entry) => { clearTimeout(entry.timer); entry.reject(new Error(reason)); });
  }

  function flushPendingFor(id) {
    const q = pending.get(id);
    if (!q || !q.length) return;
    pending.delete(id);
    const rec = known.get(id);
    q.forEach((entry) => {
      clearTimeout(entry.timer);
      if (!rec) { entry.reject(new Error('mp-native: id=' + id + ' 未找到')); return; }
      dispatchCommand(rec, entry.method, entry.argsJson).then(entry.resolve, entry.reject);
    });
  }

  function tick() {
    const viewport = { width: shim.window.innerWidth, height: shim.window.innerHeight };
    const els = findNativeEls();
    const seen = new Set();
    const patch = {};
    const newlyRendered = [];
    let listChanged = false;

    els.forEach((el) => {
      const id = el.getAttribute('data-mp-id');
      if (id == null) return;
      seen.add(id);
      const type = el.getAttribute('data-mp-native');
      let params = {};
      try { params = JSON.parse(el.getAttribute('data-mp-params') || '{}'); }
      catch (e) { params = {}; }

      let rec = known.get(id);
      if (!rec) {
        rec = { id, el, type, rendered: false, lastGeoKey: null, lastParamsKey: null };
        known.set(id, rec);
        listChanged = true;
        awaiting.delete(id); // 找到了,不再需要"已登记未发现"这个身份继续占着循环
      } else {
        rec.el = el;
        rec.type = type;
      }

      const geo = computeGeometry(el, viewport, warnOnce);
      let geoState;
      if (geo) {
        geoState = { type: type, left: geo.x, top: geo.y, width: geo.width, height: geo.height,
                     clip: geo.clip, opacity: geo.opacity, hidden: geo.hidden };
      } else {
        warnOnce('noSlot:' + id, '[native-views] 找不到 id=' + id +
          ' 对应的 flt-platform-view-slot(合成可能还没完成),本帧按隐藏处理');
        geoState = { type: type, left: 0, top: 0, width: 0, height: 0, clip: null, opacity: 1, hidden: true };
      }

      if (rec.lastGeoKey === null) {
        // 首次发现:没有旧状态可比较,也没有别的字段要保留,整份对象一次发出。
        patch['mpNative.' + id] = Object.assign({}, geoState, { params });
        rec.lastGeoKey = JSON.stringify(geoState);
        rec.lastParamsKey = JSON.stringify(params);
        newlyRendered.push(id);
      } else {
        // I4 修复:几何字段与 params 分别走各自的 dot-path,只在真正变化时
        // 才发——尤其是 params 没变时,不要把它跟着几何一起重新序列化一遍
        // 发出去(浪费 setData 预算),也不能用 `mpNative.<id>` 整对象路径
        // 覆盖(会把没变的兄弟字段一起冲掉)。
        const geoKey = JSON.stringify(geoState);
        if (geoKey !== rec.lastGeoKey) {
          rec.lastGeoKey = geoKey;
          Object.keys(geoState).forEach((k) => { patch['mpNative.' + id + '.' + k] = geoState[k]; });
        }
        const paramsKey = JSON.stringify(params);
        if (paramsKey !== rec.lastParamsKey) {
          rec.lastParamsKey = paramsKey;
          patch['mpNative.' + id + '.params'] = params;
        }
      }
    });

    known.forEach((rec, id) => {
      if (!seen.has(id) || !rec.el.isConnected) {
        known.delete(id);
        patch['mpNative.' + id] = null;
        listChanged = true;
        failPendingFor(id, 'mp-native: id=' + id + ' 对应的占位元素已被移除');
      }
    });

    if (listChanged) patch.mpNativeList = Array.from(known.keys());

    if (Object.keys(patch).length) {
      if (newlyRendered.length) {
        setData(patch, () => {
          newlyRendered.forEach((id) => {
            const rec = known.get(id);
            if (rec) rec.rendered = true;
            flushPendingFor(id);
          });
        });
      } else {
        setData(patch);
      }
    }
  }

  /**
   * I3 修复:tick() 里任何一步意外抛错,以前会让整个 rAF 循环从此死掉、
   * 又没有任何日志——用户表现为"原生组件突然全部僵住",且无从排查。这里
   * 兜底捕获、报一次警告(同一条错误只报一次,避免刷屏),循环照常继续。
   */
  function loop() {
    scheduled = false;
    if (stopped) return;
    try {
      tick();
    } catch (e) {
      warnOnce('tickError:' + ((e && e.message) || e),
        '[native-views] 同步循环内部异常(已捕获,不影响下一帧继续调度): ' + ((e && e.stack) || e));
    }
    if (stopped) return;
    // I2 修复(+ 修复轮 2):没有任何已知视图、也没有排队中的命令、也没有
    // "已登记未发现"的 id 时,不必每帧空转——但要先熬过 IDLE_GRACE_TICKS
    // 帧的宽限期,避免在引擎首帧合成完成之前就误判"这个页面没有原生视图"
    // 而永久停摆。只要 awaiting 非空,直接跳过宽限期倒计时(不设上限地
    // 继续跑下去,直到发现或 unregister),这是修复轮 2 解决"注册过一次不
    // 代表马上就能找到"这个问题的关键。
    if (known.size === 0 && pending.size === 0 && awaiting.size === 0) {
      emptyStreak++;
      if (emptyStreak >= IDLE_GRACE_TICKS) {
        startIdlePoll();
        return;
      }
    } else {
      emptyStreak = 0;
    }
    scheduled = true;
    raf(loop);
  }

  function wake() {
    if (idlePollTimer) { clearTimeout(idlePollTimer); idlePollTimer = null; }
    if (stopped || scheduled) return;
    emptyStreak = 0; // 重新给一段宽限期,不要唤醒一次就因为紧接着一帧空扫又立刻停掉
    scheduled = true;
    raf(loop);
  }

  /**
   * 循环判定空闲之后的低频兜底轮询(见 IDLE_POLL_MS 注释)。只扫
   * `flt-glass-pane` 的直接子节点——跟 `findNativeEls()` 同样便宜,发现任何
   * 新元素就唤醒主循环(交给 `tick()` 做完整的发现与几何计算),否则继续
   * 排下一次低频轮询。`wake()`/`stop()` 都会清掉这个定时器,不会跟主循环
   * 的 rAF 调度并存。
   */
  function startIdlePoll() {
    if (idlePollTimer || stopped) return;
    idlePollTimer = setTimeout(() => {
      idlePollTimer = null;
      if (stopped) return;
      if (findNativeEls().length > 0) {
        wake();
      } else {
        startIdlePoll();
      }
    }, IDLE_POLL_MS);
  }

  // ★ 修复轮 2(I2 的 Important 修复①/③):在第一次调度 rAF 之前,先把
  // Task 3 可能已经写进 `__mpNativePending` 的 id(工厂跑在 `__mpNative`
  // 挂上去之前——真机/E2E 实测过的真实时序)读出来登记进 awaiting,并清掉
  // 这个全局(不留痕迹、也不会被重复处理)。分别看 shim.self/shim.window/
  // 真正的 globalThis 三处——具体挂在哪个,取决于 dart2js 的 JS 互操作走的
  // 是哪条路径(bom-shim.js 里对 self/window 两处都挂的理由同样适用在这)。
  (function drainPendingRegistrations() {
    const candidates = [shim.self, shim.window];
    try { if (typeof globalThis !== 'undefined') candidates.push(globalThis); } catch (e) { /* 忽略 */ }
    candidates.forEach((obj) => {
      if (!obj) return;
      const arr = obj.__mpNativePending;
      if (Array.isArray(arr)) arr.forEach((id) => { if (!known.has(String(id))) awaiting.add(String(id)); });
      try { delete obj.__mpNativePending; } catch (e) { /* 只读全局则放弃 */ }
    });
  })();

  // I1 修复:接过 boot.js 装的门面(见本文件 `createNativeFacade` 与 boot.js
  // 对应注释)积压的登记与命令。`ids` 视同上面的 `__mpNativePending`,直接
  // 并入 awaiting;`commands` 逐条调真正的 `command()`(下面定义,函数声明
  // 已提升)重放,并把结果接回门面阶段已经返回给调用方的 Promise。
  (function drainFacade() {
    const facade = shim.nativeFacade;
    if (!facade) return;
    const drained = facade.drain();
    drained.ids.forEach((id) => { if (!known.has(String(id))) awaiting.add(String(id)); });
    drained.commands.forEach((entry) => {
      command(entry.id, entry.method, entry.argsJson).then(entry.resolve, entry.reject);
    });
    try { delete shim.nativeFacade; } catch (e) { /* 忽略 */ }
  })();

  scheduled = true;
  raf(loop);

  function parseArgs(argsJson) {
    if (!argsJson) return {};
    try { return JSON.parse(argsJson) || {}; }
    catch (e) { throw new Error('mp-native: argsJson 不是合法 JSON: ' + argsJson); }
  }

  /** 真正执行一次命令(id 对应的占位元素已确认渲染完成)。 */
  function dispatchCommand(rec, method, argsJson) {
    let args;
    try { args = parseArgs(argsJson); }
    catch (e) { return Promise.reject(e); }

    if (rec.type === 'video') {
      if (VIDEO_METHODS.indexOf(method) < 0) {
        return Promise.reject(new Error('mp-native: video 不支持 method: ' + method));
      }
      // 首次播放建议走 WXML `<video autoplay="{{...params.autoplay}}">` 声明式
      // 驱动,而不是创建后立刻 command('play')——那一刻组件很可能还没渲染
      // 完成,会先进 pending 队列等首次 setData 回调,不如直接用 autoplay。
      return new Promise((resolve, reject) => {
        try {
          const ctx = wx.createVideoContext('mpv-' + rec.id);
          if (method === 'seek') ctx.seek(args.position);
          else if (method === 'requestFullScreen') ctx.requestFullScreen(args || {});
          else ctx[method]();
          resolve('ok');
        } catch (e) { reject(e); }
      });
    }
    if (rec.type === 'map') {
      if (MAP_METHODS.indexOf(method) < 0) {
        return Promise.reject(new Error('mp-native: map 不支持 method: ' + method));
      }
      return new Promise((resolve, reject) => {
        try {
          const ctx = wx.createMapContext('mpm-' + rec.id);
          ctx[method](Object.assign({}, args, {
            success: (res) => resolve(JSON.stringify(res || {})),
            fail: (err) => reject(new Error((err && (err.errMsg || err.message)) || String(err))),
          }));
        } catch (e) { reject(e); }
      });
    }
    if (rec.type === 'camera') {
      if (CAMERA_METHODS.indexOf(method) < 0) {
        return Promise.reject(new Error('mp-native: camera 不支持 method: ' + method));
      }
      return new Promise((resolve, reject) => {
        try {
          const ctx = wx.createCameraContext();
          ctx[method](Object.assign({}, args, {
            success: (res) => resolve(JSON.stringify(res || {})),
            fail: (err) => reject(new Error((err && (err.errMsg || err.message)) || String(err))),
          }));
        } catch (e) { reject(e); }
      });
    }
    return Promise.reject(new Error('mp-native: 未知类型: ' + rec.type));
  }

  /**
   * self.__mpNative.command:Dart 侧调原生组件方法,统一走 Promise<string>。
   *
   * I1 修复:以前对"还没被同步层发现"的 id 立即 reject,而且就算 id 已经
   * 登记,WXML 里对应的 `<video id="mpv-N">` 也未必已经渲染出来(setData
   * 只是把数据交给视图层,不保证同步生效)——`wx.createVideoContext` 对
   * 不存在的组件 id 不会报错,只会静默无效,command() 因此会"假成功"。
   * 现在:未就绪的调用进 pending 队列,真正等到该 id 首帧 `setData` 的
   * 回调(视图层已应用完这次更新)才执行;超过 5s 还没等到就 reject 并
   * 说明可能原因,不无限期挂起。
   */
  function command(id, method, argsJson) {
    const key = String(id);
    const rec = known.get(key);
    if (rec && rec.rendered) return dispatchCommand(rec, method, argsJson);

    return new Promise((resolve, reject) => {
      const entry = {
        method: method, argsJson: argsJson, resolve: resolve, reject: reject,
        timer: setTimeout(() => {
          const q = pending.get(key);
          if (q) {
            const i = q.indexOf(entry);
            if (i >= 0) q.splice(i, 1);
            if (!q.length) pending.delete(key);
          }
          reject(new Error('mp-native: ' + (PENDING_TIMEOUT_MS / 1000) + 's 内未发现 data-mp-id=' +
            id + ' 的原生组件渲染完成,请检查工厂属性是否写对,以及该平台视图是否已被引擎合成'));
        }, PENDING_TIMEOUT_MS),
      };
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push(entry);
      wake(); // 循环可能已经因为"无事可做"停了,确保它继续扫描以发现这个 id
    });
  }

  shim.window.__mpNative = { command: command, register: register, unregister: unregister };
  shim.self.__mpNative = { command: command, register: register, unregister: unregister };

  /**
   * Task 3 的工厂在创建占位元素后调用(见文件头"调用约定")。把 id 记进
   * `awaiting`——只要它非空,循环就不会因为宽限期耗尽而停(修复轮 2),
   * 直到这个 id 真的在 `known` 里出现(tick() 里 `awaiting.delete`)或者
   * 被 `unregister()` 撤回。同时唤醒一次循环(如果它已经空闲下来了)。
   */
  function register(id) {
    if (id != null && !known.has(String(id))) awaiting.add(String(id));
    wake();
  }

  /**
   * 对应视图 dispose、但从来没有被同步层发现过(比如从没渲染完成就被用户
   * 划走的 Tab)时调用,把它从 `awaiting` 里撤回——不调也不会错,只是会让
   * 循环多跑一段时间(不会内存泄漏:`awaiting` 只存字符串 id,`known`/
   * `pending` 该释放的仍然正常释放),但调了能让"真的没事可做"时更快地
   * 真正停下来。
   */
  function unregister(id) {
    if (id != null) awaiting.delete(String(id));
  }

  /**
   * 承载页 onMpNativeEvent(e) 转发:e.currentTarget.dataset.mpid 认出是哪个
   * 占位元素,e.type/e.detail 原样打包成 detail(JSON 字符串——Flutter 侧
   * 监听的是垫片 DOM 事件,detail 走对象引用在这里没有意义,统一序列化)。
   */
  function dispatchEvent(id, type, detail) {
    const rec = id == null ? null : known.get(String(id));
    if (!rec) return;
    const CustomEvent = shim.window.CustomEvent;
    rec.el.dispatchEvent(new CustomEvent('mpnative', {
      detail: JSON.stringify({ type: type, detail: detail === undefined ? null : detail }),
    }));
  }

  function stop() {
    stopped = true;
    if (idlePollTimer) { clearTimeout(idlePollTimer); idlePollTimer = null; }
    pending.forEach((q) => {
      q.forEach((entry) => {
        clearTimeout(entry.timer);
        entry.reject(new Error('mp-native: 同步层已停止(页面卸载)'));
      });
    });
    pending.clear();
  }

  return {
    command: command, register: register, unregister: unregister,
    dispatchEvent: dispatchEvent, stop: stop,
  };
}

module.exports = {
  createNativeViews,
  // I1 修复:boot.js 用它在 loadDart 之前装门面;单测也直接打桩它。
  createNativeFacade,
  // 供单测直接打桩纯函数部分(几何算法),不必每次都搭一整棵 DOM 树。
  parseMatrix, parseClipRect, intersectRect, computeGeometry, findSlotFor,
};
