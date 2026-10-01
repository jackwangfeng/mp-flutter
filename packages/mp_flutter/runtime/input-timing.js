'use strict';
/**
 * 输入计时诊断(`--input-timing`,默认关;关闭时本文件不进产物,承载页也不注入
 * 任何调用)。每个事件打一行:
 *
 *   [mp-t] <自启用起的毫秒> <事件> <详情>
 *
 * 事件:touchstart/touchend(画布)、engine-focus(引擎焦点变化,editable=是否
 * 输入元素)、state(文本桥下发的状态)、setData / setData-done(同步耗时、回调
 * 到达)、native-focus / native-blur / native-input(带完整 e.detail 与
 * e.timeStamp)、input-ignored(组字空值被丢弃)、kb(键盘高度)、engine-in
 * (原生输入交给引擎元素、input 事件派发完)、paint(CanvasKit
 * ParagraphBuilder.addText 第一次出现这次输入的文字)、flush(该帧
 * Surface.flush 完)、next-frame(flush 之后的下一个 rAF,估算上屏)。
 *
 * ## 按键 → JS 的延迟估算
 *
 * e.timeStamp 是视图层(WebView)页面时间轴上的事件生成时刻(相对页面打开的毫秒),
 * 逻辑层只有 Date.now(墙钟)。两者差 d = Date.now() - e.timeStamp = 页面时间
 * 轴原点的墙钟时刻 + 本次事件从生成到逻辑层回调的延迟。取所有带 timeStamp 的事件
 * (触摸、原生 focus/blur/input)里 d 的最小值作为基准(假设最快那次延迟≈0),
 * 每个事件的 lag ≈ d - 基准。基准随更快的事件出现而下调,所以早期的 lag 偏小、
 * 只可比相对值;触摸事件通常最快,先点一下画布再打字,估算更准。
 */
function createInputTiming(opts) {
  const log = opts.log || function (l) { console.log(l); };
  const t0 = Date.now();
  let base = null;          // min(Date.now() - e.timeStamp)
  let seq = 0;              // native-input 序号
  let pending = null;       // 等待上屏的输入 { id, value, t }
  let painted = null;       // 已在 addText 里看到、等 flush 的输入
  const unwraps = [];

  function out(name, extra) {
    try { log('[mp-t] ' + (Date.now() - t0) + ' ' + name + (extra ? ' ' + extra : '')); } catch (e) { /* 忽略 */ }
  }
  function json(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }
  function lag(e) {
    const ts = e && e.timeStamp;
    if (typeof ts !== 'number' || !isFinite(ts)) return '';
    const d = Date.now() - ts;
    if (base === null || d < base) base = d;
    return ' ts=' + ts + ' lag≈' + (d - base) + 'ms';
  }
  function tagOf(n) { return n && n.tagName ? String(n.tagName).toLowerCase() : String(n); }

  // 引擎焦点变化(先于文本桥订阅,日志里排在 state 之前)
  if (opts.shim && typeof opts.shim.onFocusChange === 'function') {
    unwraps.push(opts.shim.onFocusChange(function (n) {
      const t = tagOf(n);
      out('engine-focus', 'el=' + t + ' editable=' + (t === 'input' || t === 'textarea'));
    }));
  }

  // 输入上屏检测:Flutter 排版段落时 addText 的文字里出现这次输入的末尾字符
  function matches(text) {
    if (!pending || typeof text !== 'string') return false;
    const v = pending.value;
    if (v === '') return true;                    // 删空:输入之后的第一段排版
    const chars = Array.from(v);
    const tail = chars.slice(-2).join('');
    return text.indexOf(tail) >= 0;
  }
  const CK = opts.CK;
  if (CK && CK.ParagraphBuilder && CK.ParagraphBuilder.prototype &&
      typeof CK.ParagraphBuilder.prototype.addText === 'function') {
    const proto = CK.ParagraphBuilder.prototype;
    const orig = proto.addText;
    proto.addText = function (text) {
      if (pending && matches(text)) {
        out('paint', '#' + pending.id + ' +' + (Date.now() - pending.t) + 'ms text=' + json(String(text).slice(-24)));
        painted = pending;
        pending = null;
      }
      return orig.apply(this, arguments);
    };
    unwraps.push(function () { proto.addText = orig; });
  }
  if (CK && CK.Surface && CK.Surface.prototype && typeof CK.Surface.prototype.flush === 'function') {
    const sp = CK.Surface.prototype;
    const origFlush = sp.flush;
    sp.flush = function () {
      const ret = origFlush.apply(this, arguments);
      if (painted) {
        const p = painted;
        painted = null;
        out('flush', '#' + p.id + ' +' + (Date.now() - p.t) + 'ms');
        if (typeof opts.raf === 'function') {
          try { opts.raf(function () { out('next-frame', '#' + p.id + ' +' + (Date.now() - p.t) + 'ms'); }); } catch (e) { /* 忽略 */ }
        }
      }
      return ret;
    };
    unwraps.push(function () { sp.flush = origFlush; });
  }

  return {
    touch(e) {
      const n = e && e.touches ? e.touches.length : 0;
      out(e && e.type, 'touches=' + n + lag(e));
    },
    nativeInput(e) {
      const d = (e && e.detail) || {};
      seq++;
      pending = { id: seq, value: String(d.value == null ? '' : d.value), t: Date.now() };
      out('native-input', '#' + seq + ' detail=' + json(d) + lag(e));
    },
    /** 原生输入交给引擎元素完毕。[accepted] 为 false 表示被桥丢弃。 */
    engineIn(t, accepted) {
      out('engine-in', '#' + seq + ' ' + (Date.now() - t) + 'ms' + (accepted === false ? ' ignored' : ''));
      if (accepted === false) pending = null;
    },
    ignored(prev, ev) { out('input-ignored', 'prev=' + json(prev) + ' ev=' + json(ev)); },
    nativeFocus(e) { out('native-focus', 'detail=' + json(e && e.detail) + lag(e)); },
    nativeBlur(e) {
      const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
      out('native-blur', 'session=' + ds.session + ' detail=' + json(e && e.detail) + lag(e));
    },
    keyboard(res) { out('kb', 'h=' + (res && res.height) + (res && res.duration != null ? ' dur=' + res.duration : '')); },
    state(s) { out('state', json(s)); },
    /** 其它一次性事件(如 kb-ghost-hidden)。 */
    note(name, extra) { out(name, extra); },
    /** setData 发出前调用,返回在回调里调用的函数。 */
    setData(patch) {
      const t = Date.now();
      const keys = Object.keys(patch || {}).map(function (k) { return k.replace(/^mpInput\./, ''); });
      out('setData', json(keys) + (('mpInput.value' in (patch || {})) ? ' value=' + json(patch['mpInput.value']) : ''));
      return {
        sent() { out('setData-sync', (Date.now() - t) + 'ms'); },
        done() { out('setData-done', '+' + (Date.now() - t) + 'ms'); },
      };
    },
    stop() { unwraps.splice(0).forEach(function (f) { try { f(); } catch (e) { /* 忽略 */ } }); },
  };
}

module.exports = { createInputTiming };
