'use strict';
/**
 * Dart ↔ 微信能力的 JS 桥。业务代码经 package:mp_flutter_wechat 显式调用;
 * 参数与结果用 JSON 字符串往返,避免 js_interop 类型转换的边角问题。
 * 敏感操作(code 换 session、支付下单签名)必须在业务服务端完成。
 */
function createWechatBridge(deps) {
  const wx = deps.wx;
  let share = null;

  function fail(api, msg, cancelled) {
    const e = new Error(api + ': ' + msg);
    e.mpApi = api; e.mpErrMsg = msg; e.mpCancelled = !!cancelled;
    return e;
  }

  // 非回调式接口(同步返回值、on/off 事件订阅、create* 工厂、*Manager 句柄)
  // 用这条 success/fail 回调协议去调用永远不会 resolve/reject —— 它们要么
  // 同步返回结果(getSystemInfoSync、getStorageSync 等),要么把回调长期存着
  // 反复触发(onNetworkStatusChange 等),不是"调用一次、成功或失败一次"的
  // 语义,call() 会永久挂起。Object.prototype 上的属性(toString、
  // constructor、hasOwnProperty…)则是原型链噪音,`typeof wx[name]` 对它们
  // 也会判断为 function,必须在那之前就拒绝,不能等 wx[name](params) 抛错才
  // 发现。
  function isNonCallbackApi(name) {
    return /Sync$/.test(name) || /^(on|off)[A-Z]/.test(name) ||
      /^create[A-Z]/.test(name) || /Manager$/.test(name) || name in Object.prototype;
  }

  function call(api, paramsJson) {
    return new Promise((resolve, reject) => {
      const name = String(api);
      if (isNonCallbackApi(name)) { reject(fail(name, '仅支持 success/fail 回调式异步接口')); return; }
      if (typeof wx[name] !== 'function') { reject(fail(name, '当前基础库不支持该接口')); return; }
      let params;
      try {
        params = JSON.parse(paramsJson == null || paramsJson === '' ? '{}' : String(paramsJson));
        if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error('not object');
      } catch (e) { reject(fail(name, '参数必须是 JSON 对象')); return; }
      delete params.success; delete params.fail; delete params.complete;
      params.success = (res) => {
        try { resolve(JSON.stringify(res == null ? {} : res)); }
        catch (e) { reject(fail(name, '结果无法序列化: ' + e.message)); }
      };
      params.fail = (err) => {
        const msg = (err && err.errMsg) || String(err);
        reject(fail(name, msg, /cancel/i.test(msg)));
      };
      try { wx[name](params); } catch (e) { reject(fail(name, (e && e.message) || String(e))); }
    });
  }

  function setShareInfo(json) {
    const info = JSON.parse(String(json));
    if (info.path != null && String(info.path)[0] !== '/') {
      throw new Error('分享路径必须以 / 开头(小程序页面路径),实际: ' + info.path);
    }
    // ★ 不能写 `const out = {}`(对象字面量):wechat.js 经 vm.runInContext 在独立
    // realm 里执行,字面量对象的 [[Prototype]] 是该 realm 自己的 Object.prototype,
    // 与调用方(单测/宿主页)所在 realm 不是同一个 —— assert.deepStrictEqual 等按
    // 引用比较原型,会误判"结构相同但不相等"。JSON.parse 是从外层 realm 引入的引用
    // (见 context.js sandbox 装配),其内部创建的对象天然带外层 realm 的原型。
    const out = JSON.parse('{}');
    ['title', 'path', 'imageUrl', 'query'].forEach((k) => { if (info[k] != null) out[k] = String(info[k]); });
    share = out;
  }

  // 胶囊按钮的布局位置(wx.getMenuButtonBoundingClientRect,同步接口,不能走
  // call())。返回 JSON 字符串 {left,top,right,bottom,width,height}(CSS 像素 =
  // Flutter 逻辑像素);拿不到(旧基础库/接口抛错/字段缺失)时返回 null。
  function menuButtonRect() {
    try {
      if (typeof wx.getMenuButtonBoundingClientRect !== 'function') return null;
      const r = wx.getMenuButtonBoundingClientRect();
      if (!r) return null;
      const keys = ['left', 'top', 'right', 'bottom', 'width', 'height'];
      if (!keys.every((k) => typeof r[k] === 'number' && isFinite(r[k]))) return null;
      return JSON.stringify({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    } catch (e) { return null; }
  }

  return { version: 1, call, setShareInfo, getShareInfo: () => share, menuButtonRect };
}

module.exports = { createWechatBridge };
