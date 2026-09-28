'use strict';
/**
 * 小程序安全区 → Flutter 的 MediaQuery.viewPadding / padding(K1)。
 *
 * 为什么要自己供给:承载页是 navigationStyle: custom(整屏画布,没有原生导航栏),
 * 内容从屏幕最顶上画起;而 Flutter Web 引擎(3.41.x,
 * lib/web_ui/lib/src/engine/window.dart)的 viewPadding/padding 取自
 * `final ViewConfiguration _viewConfiguration = const ViewConfiguration()`,
 * 恒为 ViewPadding.zero——既不读 env(safe-area-inset-*),也不读 visualViewport;
 * dart2js 甚至把 MediaQueryData.fromView 里的 view.padding 常量折叠成了同一个
 * 零值常量。于是 SafeArea 在小程序里什么都不做,内容顶到状态栏/刘海下面。
 *
 * 数值(CSS 像素 = Flutter 逻辑像素,与 innerWidth/innerHeight 同一坐标系):
 *   top    = safeArea.top(缺失时退回 statusBarHeight)
 *   bottom = 窗口高 - safeArea.bottom(Home 指示条)
 *   left/right 同理(横屏刘海)
 * 胶囊按钮不算进 padding——与原生 App 一致;需要避开胶囊的页面用
 * package:mp_flutter_wechat 的 MpWechat.menuButtonRect()。
 *
 * Dart 侧(构建期生成的入口包装,见 mp_flutter 的 entrypoint.dart)经
 * `self.__mpSafeArea` 读取 top/right/bottom/left,并用 listen(fn) 订阅变化;
 * 横竖屏切换、窗口尺寸变化经 wx.onWindowResize 重算后通知。
 */
function computeInsets(info) {
  info = info || {};
  const w = num(info.windowWidth, num(info.screenWidth, 0));
  const h = num(info.windowHeight, num(info.screenHeight, 0));
  const sa = info.safeArea;
  let top = 0, left = 0, right = 0, bottom = 0;
  if (sa && typeof sa === 'object') {
    top = num(sa.top, 0);
    left = num(sa.left, 0);
    // safeArea.right/bottom 是坐标(不是距离),换算成到窗口边缘的距离
    if (sa.right != null && w > 0) right = w - num(sa.right, w);
    if (sa.bottom != null && h > 0) bottom = h - num(sa.bottom, h);
  }
  if (!(top > 0)) top = num(info.statusBarHeight, 0);
  return { top: clamp(top), right: clamp(right), bottom: clamp(bottom), left: clamp(left) };
}

function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
function clamp(v) { return v > 0 ? v : 0; }

function createSafeArea(deps) {
  const wx = deps.wx;
  const listeners = [];
  const read = () => {
    try { return computeInsets(wx.getWindowInfo ? wx.getWindowInfo() : null); }
    catch (e) { return computeInsets(null); }
  };
  const bridge = { version: 1, top: 0, right: 0, bottom: 0, left: 0,
    /** 订阅变化;返回取消函数。回调异常不影响其它订阅者。 */
    listen(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
  };
  function apply(v) {
    const changed = v.top !== bridge.top || v.right !== bridge.right ||
      v.bottom !== bridge.bottom || v.left !== bridge.left;
    bridge.top = v.top; bridge.right = v.right; bridge.bottom = v.bottom; bridge.left = v.left;
    return changed;
  }
  apply(read());

  function refresh() {
    if (!apply(read())) return false;
    listeners.slice().forEach((fn) => { try { fn(); } catch (e) { /* 订阅者异常不影响其它订阅者 */ } });
    return true;
  }
  // wx.onWindowResize 回调里的 size 不带 safeArea,重新读一次 getWindowInfo
  const onResize = () => refresh();
  try { if (typeof wx.onWindowResize === 'function') wx.onWindowResize(onResize); } catch (e) { /* 旧基础库忽略 */ }

  return {
    bridge,
    refresh,
    dispose() {
      try { if (typeof wx.offWindowResize === 'function') wx.offWindowResize(onResize); } catch (e) { /* 忽略 */ }
      listeners.length = 0;
    },
  };
}

module.exports = { createSafeArea, computeInsets };
