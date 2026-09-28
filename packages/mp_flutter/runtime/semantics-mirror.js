'use strict';
/**
 * WXML 伴生层(可选,Phase 5 Task 4)。
 *
 * 默认关(`--semantics-mirror`,CLI flag,默认 false)。理由(裁定,写在这里):
 * 语义树本身有运行时开销(引擎侧一旦激活就会持续维护一整棵 `flt-semantics`
 * 影子树,这里再加一层 500ms 轮询 + setData),只有业务明确需要微信"小程序
 * 页面内容索引"或无障碍能力时才值得付出——不是每个 App 都需要,不能替所有
 * App 默认打开。
 *
 * ## 激活
 *
 * 探针(见 `docs/architecture.md`)确认:
 * 引擎(`semantics_helper.dart` `tryEnableSemantics`)只在收到一次目标为
 * `flt-semantics-placeholder` 本身的真实 DOM `click` 事件时才会把
 * `semanticsEnabled` 置为 true,此前 DOM 里除了这个占位元素与空的
 * `flt-semantics-host` 容器之外没有任何 `flt-semantics-*` 节点。
 * 触摸桥(`touch-bridge.js`)只派发 pointerdown/move/up/cancel,从不派发
 * `click`——所以本文件在 `start()` 里(承载页 boot 成功、且
 * `--semantics-mirror` 打开时才会调用,见 `pipeline.dart`
 * `buildHostPageJs`)自己找到占位元素、直接合成并派发一次 `click`
 * (`MouseEvent`,`bubbles:true`)。只派发这一次——不是每次 `scan()` 都发,
 * 用 `_activated` 标记闩死;找不到占位元素(理论上不该发生,引擎在 boot
 * 时就无条件创建它)时警告一次并放弃,不影响后续扫描(扫描发现"语义树还没
 * 开"时本来就是空列表,行为等价于关闭)。
 *
 * ## 几何:flt-semantics 节点的屏幕矩形
 *
 * 与原生视图同步层(`native-views.js`)面对的"两棵树 + shadow DOM slot"结构
 * 完全不同——语义树是一棵普通的、直接嵌套的轻量 DOM 子树,不经过 shadow
 * root。取自 Flutter Web 引擎源码(`lib/_engine/engine/semantics/semantics.dart`
 * `SemanticRole._initElement`/`recomputePositionAndSize`,
 * `lib/_engine/engine/view_embedder/style_manager.dart`
 * `styleSemanticsHost`):
 *
 *   - 每个 `<flt-semantics>` 节点自己 `position:absolute`,尺寸直接写
 *     `style.width`/`style.height`(像素数值,下同),位置**不**写
 *     `left`/`top`,而是写一个平移 `style.transform`
 *     (`matrix(1,0,0,1,e,f)` 2D 形式,或极少数含旋转/复合变换时的
 *     `matrix3d(...)` 3D 形式——本实现只取平移分量 e/f,忽略旋转/斜切,
 *     与 `text-bridge.js` 对文本框几何的简化处理一致,真实语义节点的变换
 *     由引擎生成,旋转/斜切极罕见);这个平移已经内含了"相对父节点的偏移
 *     + 滚动调整量"(引擎侧 `recomputePositionAndSize` 的
 *     `horizontalAdjustmentFromParent`/`verticalAdjustmentFromParent`),
 *     调用方不需要再单独处理滚动。
 *   - 因此一个节点相对屏幕的绝对偏移 = 从它自己起,沿 `parentNode` 链一路
 *     向上、把每一层**自己的** `transform` 平移分量原样相加,直到走到
 *     `<flt-semantics-host>`(不含 host 自己的这一段,见下)。
 *   - 引擎注释原文:"The framework specifies semantics in physical pixels,
 *     but CSS uses logical pixels. To compensate, an inverse scale is
 *     injected at the root level"——`flt-semantics-host` 的 `transform`
 *     恒为 `scale(1/dpr)` 这一种形式(不是 matrix),把上面累加出来的"物理
 *     像素"整体换算成 WXML 需要的逻辑像素,宽高同样要乘这个系数。
 *   - 走到 host 之前就断链(说明该节点已经不在语义树里,比如所属分支被
 *     引擎整段移除)按"跳过,不计入本帧结果"处理,不抛错。
 *
 * ## 文案:aria-label / 文本
 *
 * 引擎有三种 `LabelRepresentation`(`label_and_value.dart`):`ariaLabel`
 * (只写 `aria-label` 属性)、`domText`(`appendChild` 一个文本节点,
 * `nodeType===3`)、`sizedSpan`(`appendChild` 一个 `<span>` 元素,靠
 * `_domText.text = label` 赋值——垫片的 `DomElement` 没有专门的 `text`
 * getter/setter,这只是把 `text` 当成一个普通字段直接读写)。三种都要认:
 * 优先 `aria-label`;没有就找直接子节点里第一个"文本节点"
 * (`nodeType===3` 的 `textContent`)或者第一个带非空字符串 `text` 字段的
 * 子元素。
 *
 * ## 镜像:500ms 扫描、diff、上限
 *
 * 每 500ms(语义树变化频率低,不需要跟渲染帧同步——这也是不用 `raf` 而用
 * `setInterval` 的原因,和 `text-bridge.js` 的输入框轮询一致,真机 wx 环境
 * 提供 `setInterval`)重新走一遍 `<flt-semantics-host>` 子树,收集所有带
 * 非空文案的 `<flt-semantics>` 节点(纯容器节点——没有 aria-label 也没有
 * 文本子节点——跳过,不生成伴生条目,WXML 没有必要为它们渲染空
 * `<text>`),按整份数组做一次 JSON 深比较,不同才 `setData({ mpSemantics:
 * [...] })`(与 `native-views.js` 的"只在真正变化时才发"同一个预算考量,
 * 语义条目数量通常远小于原生视图,这里不再做逐条 dot-path 拆分,一次性
 * 整个数组重发足够便宜)。条目数超过 500 时截断到前 500 条并警告一次(用
 * `warnedCap` 闩死,不刷屏)。
 *
 * WXML 侧(见 `pipeline.dart` `emit_project.dart` 的承载页模板)把这份数组
 * 渲染成一组视觉隐藏(`opacity:0`、`pointer-events:none`)、定位到对应矩形
 * 的 `<text>`——只服务微信的"页面内容索引"/无障碍,不影响任何可见渲染。
 */
const SCAN_INTERVAL_MS = 500;
const MAX_ENTRIES = 500;

function tagOf(n) { return n && n.tagName; }

/** 先序遍历 [root] 的所有后代(不含 root 自身),收集满足 [predicate] 的节点。 */
function collectDescendants(root, predicate, out) {
  const kids = (root && root.children) || [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (predicate(c)) out.push(c);
    collectDescendants(c, predicate, out);
  }
  return out;
}

/** 从 [root] 起(含子树,不含 root 本身)先序找第一个满足 [predicate] 的后代。 */
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

/** 只取平移分量:2D `matrix(a,b,c,d,e,f)` 取 e,f;3D `matrix3d(...)`(16 项)
 * 取第 12/13 项(与 `text-bridge.js` `parseTranslate` 的处理一致)。忽略
 * 旋转/缩放/斜切分量——语义节点的变换绝大多数情况下是纯平移。 */
function parseTranslate(transform) {
  const s = String(transform || '');
  const m3 = /matrix3d\(([^)]+)\)/.exec(s);
  if (m3) {
    const v = m3[1].split(',').map(Number);
    return { x: v[12] || 0, y: v[13] || 0 };
  }
  const m2 = /matrix\(([^)]+)\)/.exec(s);
  if (m2) {
    const v = m2[1].split(',').map(Number);
    return { x: v[4] || 0, y: v[5] || 0 };
  }
  return { x: 0, y: 0 };
}

/** `flt-semantics-host` 自带的 `scale(1/dpr)`——物理像素→逻辑像素的换算
 * 系数;解析失败(理论不该发生)按 1(不换算)处理。 */
function parseScale(transform) {
  const m = /scale\(([^)]+)\)/.exec(String(transform || ''));
  if (!m) return 1;
  const n = Number(m[1]);
  return isFinite(n) && n > 0 ? n : 1;
}

function parsePx(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

/**
 * 见文件头"文案"一节:优先 `aria-label`,否则找第一个文本子节点/带 `text`
 * 字段的子元素。找不到任何文案返回空字符串(调用方按"纯容器,跳过"处理)。
 */
function extractLabel(el) {
  const aria = el && el.getAttribute && el.getAttribute('aria-label');
  if (aria) return aria;
  const kids = (el && (el.childNodes || el.children)) || [];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!k) continue;
    // domText(文本子节点)与 sizedSpan(子 <span> 元素)都靠这一个字段取到:
    // 引擎的 `DomNode.text` 是 `@JS('textContent')` 映射(dom.dart),dart2js
    // 编译出的 JS 实际写的是 `.textContent`,不是字面的 `.text` 属性——
    // `createTextNode` 造出的文本节点本身也是显式设的 `textContent`(见
    // `bom-shim.js`)。两种表示殊途同归,统一读 `textContent`;`.text` 只是
    // 兜底(万一某处调用方真的直接设了这个属性名)。
    const text = k.textContent || k.text;
    if (text) return String(text);
  }
  return '';
}

/**
 * 见文件头"几何"一节:[el] 必须是 [host] 的(严格)后代,否则返回 null。
 * 从 [el] 起沿 `parentNode` 链向上累加各层自身的平移分量,直到 [host]
 * (不含 host 自己的这一段——host 的 `transform` 是缩放,不是平移),再乘
 * host 解出的 dpr 换算系数。
 */
function computeRect(el, host) {
  let x = 0;
  let y = 0;
  let n = el;
  while (n && n !== host) {
    const t = parseTranslate(n.style && n.style.transform);
    x += t.x;
    y += t.y;
    n = n.parentNode;
  }
  if (n !== host) return null;
  const s = parseScale(host.style && host.style.transform);
  const width = parsePx(el.style && el.style.width);
  const height = parsePx(el.style && el.style.height);
  return { left: x * s, top: y * s, width: width * s, height: height * s };
}

/**
 * @param opts.shim 见 `bom-shim.js` 的 `install()` 返回值。
 * @param opts.setData 承载页 `this.setData` 的转发(与 `native-views.js`
 *   同约定)。
 * @param opts.setIntervalFn / opts.clearIntervalFn 仅供测试注入,默认取
 *   全局 `setInterval`/`clearInterval`(真机 wx 环境提供,`text-bridge.js`
 *   已经这样用)。
 */
function createSemanticsMirror(opts) {
  const shim = opts.shim;
  const setData = opts.setData;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;

  let timer = null;
  let lastKey = null;
  let warnedCap = false;
  let activated = false;

  function findHost() {
    return findDescendant(shim.document.body, (n) => tagOf(n) === 'FLT-SEMANTICS-HOST');
  }
  function findPlaceholder() {
    return findDescendant(shim.document.body, (n) => tagOf(n) === 'FLT-SEMANTICS-PLACEHOLDER');
  }

  /** 见文件头"激活"一节。只在 [start] 里调一次,闩死。 */
  function activateOnce() {
    if (activated) return;
    activated = true;
    const placeholder = findPlaceholder();
    if (!placeholder) {
      console.warn('[semantics-mirror] 找不到 flt-semantics-placeholder,无法派发激活 click(语义树不会开启)');
      return;
    }
    // ★ 引擎的移动端 SemanticsEnabler(`semantics_helper.dart`
    // `MobileSemanticsEnabler.tryEnableSemantics`)不像桌面端那样只看
    // `event.target`——它按 `_semanticsPlaceholder.getBoundingClientRect()`
    // 的中点(误差 1px)校验点击落点,理由是"模拟真实 AT(VoiceOver/TalkBack)
    // 生成的敲击总是落在被聚焦元素正中"。真实浏览器里占位元素样式是
    // `position:absolute;left:-1px;top:-1px;width:1px;height:1px`,中点几乎
    // 就是 (-0.5,-0.5);但 `bom-shim.js` 的 `getBoundingClientRect()` 没有照抄
    // 每个元素的实际样式几何,统一返回"整个画布"的矩形(`{0,0,ctx.width,
    // ctx.height}`,见该文件同名方法)——所以这里的坐标必须对齐 shim 的这个
    // 近似,取画布中心(`window.innerWidth/2, innerHeight/2`),不能留空
    // (什么坐标都不给,会被判定为落点对不上、`enableConditionPassed` 恒
    // false,语义树永远不会真的打开——2026-09-27 E2E 实测过这个坑)。
    const MouseEvent = shim.window.MouseEvent;
    const cx = shim.window.innerWidth / 2;
    const cy = shim.window.innerHeight / 2;
    placeholder.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: cx, clientY: cy, offsetX: cx, offsetY: cy,
    }));
  }

  function scan() {
    const host = findHost();
    if (!host) return; // boot 尚未就绪或页面已卸载,下一次 tick 再看
    const nodes = collectDescendants(host, (n) => tagOf(n) === 'FLT-SEMANTICS', []);
    const entries = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const label = extractLabel(el);
      if (!label) continue; // 纯容器节点,WXML 没必要为它渲染 <text>
      const rect = computeRect(el, host);
      if (!rect) continue; // 已经断链(不在语义树里了),这一帧不计入
      entries.push({
        id: (el.getAttribute && el.getAttribute('id')) || String(i),
        label: label,
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      });
    }

    let out = entries;
    if (entries.length > MAX_ENTRIES) {
      out = entries.slice(0, MAX_ENTRIES);
      if (!warnedCap) {
        warnedCap = true;
        console.warn('[semantics-mirror] flt-semantics 节点数(' + entries.length +
          ')超过上限 ' + MAX_ENTRIES + ',已截断到前 ' + MAX_ENTRIES + ' 条');
      }
    }

    const key = JSON.stringify(out);
    if (key === lastKey) return; // 没有实质变化,不占用 setData 预算
    lastKey = key;
    setData({ mpSemantics: out });
  }

  function start() {
    activateOnce();
    scan();
    if (timer == null) timer = setIntervalFn(scan, SCAN_INTERVAL_MS);
  }

  function stop() {
    if (timer != null) { clearIntervalFn(timer); timer = null; }
  }

  return { start: start, stop: stop, scan: scan };
}

module.exports = {
  createSemanticsMirror,
  // 供单测直接打桩纯函数部分,不必每次都搭一整棵 DOM 树。
  parseTranslate, parseScale, computeRect, extractLabel,
};
