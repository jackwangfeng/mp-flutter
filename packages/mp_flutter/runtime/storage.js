'use strict';
/**
 * localStorage 由小程序同步存储承载(shared_preferences_web 用它)。
 * - 值包成 { v } 存:wx.getStorageSync 对不存在的键返回 '',包一层才能区分"不存在"和"空串"
 * - 只读写带前缀的键:clear() 不能误删小程序里其它模块的存储
 * - 小程序限制:单键 1MB、总量 10MB
 *
 * 性能(修复轮 1):shared_preferences_web 的 getString/getInt/… 每次单键读取都先
 * 经 localStorage.keys 枚举一次(内部实现如此),若 length/key(i)/clear() 都实时
 * 调 wx.getStorageInfoSync() 全量扫描,会变成"每读一个 preference 就有一次 O(N)
 * 的原生同步桥调用"(评审实测 10 个键触发 21 次)。这里改为:构造时调用一次
 * getStorageInfoSync() 建内存索引(去前缀的键的有序集合),之后 setItem 成功后
 * 加入索引、removeItem/clear 同步摘除,length/key(i) 只读索引,不再触达 wx。
 * getItem 仍然直接读 wx(值本身不缓存,避免与小程序侧并发写入的场景产生脏读)。
 *
 * 假设(索引可信的前提):
 * ① 带本 prefix 的键只由本框架(本 Storage 实例)写入 —— 索引因此与 wx 里
 *    实际存在的带前缀键集合一致,clear() 按索引删也不会漏删/错删。
 * ② 若小程序里其它模块也直接写入了同前缀的键:构造之后才写入的,不会被本索引
 *    捕捉到,既不出现在 key(i)/length 里,也不会被 clear() 误删;但构造时已存在
 *    的会被当成"本框架的键"一并纳入索引,可能被 clear() 误删。真实场景里
 *    'mpf:' 前缀由本框架专用,不与业务代码共享,该假设成立。
 */
function createWxStorage(opts) {
  const wx = opts.wx;
  const prefix = opts.prefix || 'mpf:';
  // 内存索引:构造时建一次,后续增量维护,避免每次枚举都全量扫描 wx 存储。
  const index = new Set(
    wx.getStorageInfoSync().keys
      .filter((k) => k.indexOf(prefix) === 0)
      .map((k) => k.slice(prefix.length)));
  // key(i) 常被 shared_preferences_web 逐个调用来枚举所有键(length 次调用,
  // 每次都是"当前所有键"的第 i 个)。每次都新 Array.from(index) 会把枚举
  // 一个前缀集合变成 O(N^2) 次数组构造。这里缓存数组,只在 index 变化
  // (set/remove/clear)时作废,读多写少,枚举命中缓存不再重建。
  let keysCache = null;
  function keysArray() { if (keysCache === null) keysCache = Array.from(index); return keysCache; }
  function invalidate() { keysCache = null; }
  return {
    getItem(k) {
      const raw = wx.getStorageSync(prefix + String(k));
      return raw && typeof raw === 'object' && 'v' in raw ? String(raw.v) : null;
    },
    setItem(k, v) {
      const key = String(k);
      try { wx.setStorageSync(prefix + key, { v: String(v) }); }
      catch (e) {
        const err = new Error('本地存储写入失败(小程序单键上限 1MB、总量 10MB):' + ((e && (e.errMsg || e.message)) || e));
        err.name = 'QuotaExceededError';
        throw err;
      }
      if (!index.has(key)) invalidate();
      index.add(key);
    },
    removeItem(k) {
      wx.removeStorageSync(prefix + String(k));
      if (index.delete(String(k))) invalidate();
    },
    clear() {
      if (index.size === 0) return;
      for (const k of keysArray()) { wx.removeStorageSync(prefix + k); index.delete(k); }
      invalidate();
    },
    key(i) { const keys = keysArray(); return i >= 0 && i < keys.length ? keys[i] : null; },
    get length() { return index.size; },
  };
}

function createMemoryStorage() {
  const m = new Map();
  return {
    getItem(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(String(k)); },
    clear() { m.clear(); },
    key(i) { const keys = [...m.keys()]; return i >= 0 && i < keys.length ? keys[i] : null; },
    get length() { return m.size; },
  };
}

module.exports = { createWxStorage, createMemoryStorage };
