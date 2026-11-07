'use strict';

// 平台选择只返回局部宿主引用,不往 globalThis 注入 wx/tt 别名。
let douyinHost = null;
let douyinApi = null;
function getHost(target) {
  const name = target || (typeof tt !== 'undefined' ? 'douyin' : 'wechat');
  if (name === 'wechat') {
    return {
      name,
      api: typeof wx !== 'undefined' ? wx : null,
      wasm: typeof WXWebAssembly !== 'undefined' ? WXWebAssembly : null,
      selectCanvas(selector, callback) { wx.createSelectorQuery().select(selector).node(callback).exec(); },
    };
  }
  if (name !== 'douyin') throw new Error('未知小程序平台: ' + name);
  if (typeof tt === 'undefined') throw new Error('抖音产物需要在抖音小程序环境运行(tt 不存在)');
  if (douyinHost && douyinApi === tt) return douyinHost;
  douyinApi = tt;
  const api = tt;
  const methods = new Map();
  const adapted = new Proxy(api, {
    get(obj, key) {
      if (key === 'getWindowInfo') return () => typeof api.getWindowInfo === 'function'
        ? api.getWindowInfo() : api.getSystemInfoSync();
      if (key === 'getDeviceInfo') return () => typeof api.getDeviceInfo === 'function'
        ? api.getDeviceInfo() : api.getSystemInfoSync();
      const value = obj[key];
      if (typeof value !== 'function') return value;
      if (!methods.has(key) || methods.get(key).source !== value) {
        methods.set(key, { source: value, bound: key === 'request'
          ? function (options) {
            // tt.request 只允许 json/string;二进制由 responseType 决定。
            const request = Object.assign({}, options);
            if (request.dataType === 'arraybuffer') request.dataType = 'string';
            // Dart HTTP 客户端可能传数值头;tt 要求字符串,长度交给宿主计算。
            if (request.header) {
              const headers = {};
              Object.keys(request.header).forEach(function (name) {
                if (name.toLowerCase() !== 'content-length') headers[name] = String(request.header[name]);
              });
              request.header = headers;
            }
            return value.call(api, request);
          } : value.bind(api) });
      }
      return methods.get(key).bound;
    },
  });
  douyinHost = {
    name,
    api: adapted,
    wasm: typeof TTWebAssembly !== 'undefined' ? TTWebAssembly : null,
    selectCanvas(selector, callback) {
      api.createSelectorQuery().select(selector).node().exec((nodes) => callback(nodes && nodes[0]));
    },
  };
  return douyinHost;
}
module.exports = { getHost };
