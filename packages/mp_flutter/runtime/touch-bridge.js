'use strict';
/**
 * 小程序画布触摸 → Flutter Web 引擎的 PointerEvent。
 *
 * 引擎(pointer_binding.dart)的监听点:pointerdown/pointercancel 在
 * flutter-view 元素上,pointermove/pointerup 在 window 上。事件必须是
 * window.PointerEvent 的实例(dart2js 的 isA 走 instanceof),target 为
 * flutter-view 时引擎直接用 offsetX/offsetY 作为逻辑坐标。
 */
function createTouchBridge(opts) {
  const shim = opts.shim;
  const scale = shim.window.innerWidth / opts.cssWidth;
  // 小程序的 touch identifier 可能复用 0;给每次按下分配独立的 pointerId,
  // 抬起/取消后释放,多指时互不干扰。value 除了 pointerId 还存最后一次的
  // 画布内坐标(换算前),供 cancelAll/覆盖旧映射时补发 pointercancel 用。
  const active = new Map();   // identifier → { pointerId, x, y }
  let nextId = 1;

  function view() {
    const targets = shim.listenerTargets('pointerdown');
    // 优先选 tagName 为 flutter-view 的元素:未来插件/平台视图等其他元素也
    // 可能注册 pointerdown 监听器,单纯取"最后注册的一个"会派发到错误目标
    // (修复轮 1 Minor 7)。找不到时退回原来的"取最后一个"兜底。
    for (let i = targets.length - 1; i >= 0; i--) {
      if (targets[i] && targets[i].tagName === 'FLUTTER-VIEW') return targets[i];
    }
    return targets.length ? targets[targets.length - 1] : null;
  }

  // 触摸点的画布内坐标:真机 canvas 触摸事件的 x/y 是画布内坐标(承载页 wxml
  // 里 canvas 恒为 100vw×100vh、左上角与视口重合,所以数值上等价于
  // clientX/clientY)。miniprogram-automator 的 Element.touchstart/move/end
  // 协议(ITouch)本身不带 x/y 字段,只有 identifier/pageX/pageY/clientX/
  // clientY —— 用 automator 驱动 E2E 时收到的 changedTouches[i].x/y 是
  // undefined,真机上永远不会缺。两者都缺时(协议以外的未知来源)不产生
  // NaN 坐标,由调用方丢弃该触点(修复轮 1 Minor 3)。
  function resolveXY(touch) {
    const x = touch.x != null ? touch.x : touch.clientX;
    const y = touch.y != null ? touch.y : touch.clientY;
    if (x == null || y == null) return null;
    return { x, y };
  }

  function make(type, x, y, pointerId, buttons, target, e, primary) {
    const ox = x * scale, oy = y * scale;
    const ev = new shim.window.PointerEvent(type, {
      bubbles: true, cancelable: true,
      pointerId, pointerType: 'touch', isPrimary: primary,
      button: type === 'pointermove' ? -1 : 0, buttons,
      offsetX: ox, offsetY: oy, clientX: ox, clientY: oy, pageX: ox, pageY: oy, screenX: ox, screenY: oy,
      pressure: buttons ? 0.5 : 0, tiltX: 0, tiltY: 0, width: 1, height: 1,
      timeStamp: (e && e.timeStamp) || Date.now(),
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    });
    ev.target = target;
    return ev;
  }

  function handle(e) {
    const target = view();
    if (!target) return;   // 引擎还没起来,丢弃
    const changed = e.changedTouches || [];
    for (let i = 0; i < changed.length; i++) {
      const t = changed[i];
      const xy = resolveXY(t);
      if (!xy) {
        // 丢弃该触点(不产生 NaN 坐标),但仍需上报,便于线上排查协议变化。
        console.warn('[touch-bridge] 触点缺少 x/y 与 clientX/clientY,丢弃: identifier=' + t.identifier);
        continue;
      }
      if (e.type === 'touchstart') {
        if (active.has(t.identifier)) {
          // 前一次同 identifier 的 touchend/touchcancel 丢失(小程序偶发漏报
          // 或调用方误用):覆盖映射前先对旧 pointerId 补发 pointercancel,
          // 避免引擎里残留"按下"状态(修复轮 1 Minor 2)。
          const old = active.get(t.identifier);
          target.dispatchEvent(make('pointercancel', old.x, old.y, old.pointerId, 0, target, e, false));
          active.delete(t.identifier);
        }
        const id = nextId++;
        active.set(t.identifier, { pointerId: id, x: xy.x, y: xy.y });
        target.dispatchEvent(make('pointerdown', xy.x, xy.y, id, 1, target, e, active.size === 1));
      } else if (e.type === 'touchmove') {
        const rec = active.get(t.identifier);
        if (rec) {
          rec.x = xy.x; rec.y = xy.y;
          shim.window.dispatchEvent(make('pointermove', xy.x, xy.y, rec.pointerId, 1, target, e, false));
        }
      } else if (e.type === 'touchend') {
        const rec = active.get(t.identifier);
        if (!rec) continue;
        active.delete(t.identifier);
        shim.window.dispatchEvent(make('pointerup', xy.x, xy.y, rec.pointerId, 0, target, e, false));
      } else if (e.type === 'touchcancel') {
        const rec = active.get(t.identifier);
        if (!rec) continue;
        active.delete(t.identifier);
        target.dispatchEvent(make('pointercancel', xy.x, xy.y, rec.pointerId, 0, target, e, false));
      }
    }
  }

  // 小程序页面切到后台(onHide)时,所有正在按住的手指状态必然丢失——不会
  // 再收到 touchend/touchcancel,不清理会让引擎以为手指仍按着,回前台后行为
  // 错乱。对所有活跃指针发 pointercancel(发到 flutter-view)并清空映射。
  // 承载页在 onHide 里调用(修复轮 1 Minor 2)。
  function cancelAll(timeStamp) {
    const target = view();
    const fakeEvent = { timeStamp: timeStamp || Date.now() };
    if (target) {
      active.forEach((rec) => {
        target.dispatchEvent(make('pointercancel', rec.x, rec.y, rec.pointerId, 0, target, fakeEvent, false));
      });
    }
    active.clear();
  }

  return { handle, cancelAll };
}

module.exports = { createTouchBridge };
