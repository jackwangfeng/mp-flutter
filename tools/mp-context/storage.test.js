const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');
const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

function setup(opts) {
  const c = createMpContext(opts);
  const s = c.requireModule(path.join(RT, 'storage.js'));
  return { c, local: s.createWxStorage({ wx: c.wx }), session: s.createMemoryStorage(), s };
}

test('不存在返回 null,存了空串返回空串', () => {
  const { local } = setup();
  assert.strictEqual(local.getItem('none'), null);
  local.setItem('e', '');
  assert.strictEqual(local.getItem('e'), '');
});

test('值一律转成字符串;removeItem', () => {
  const { local } = setup();
  local.setItem('n', 42);
  assert.strictEqual(local.getItem('n'), '42');
  local.removeItem('n');
  assert.strictEqual(local.getItem('n'), null);
});

test('length/key(i) 枚举(shared_preferences_web 的枚举方式)', () => {
  const { local } = setup();
  local.setItem('flutter.a', '1'); local.setItem('flutter.b', '2');
  const keys = []; for (let i = 0; i < local.length; i++) keys.push(local.key(i));
  assert.deepStrictEqual(keys.sort(), ['flutter.a', 'flutter.b']);
  assert.strictEqual(local.key(99), null);
});

test('clear 只清本框架写入的键,不误删小程序其它模块的存储', () => {
  const { local, c } = setup();
  c.wx.setStorageSync('other_module_token', 'keep');
  local.setItem('x', '1');
  local.clear();
  assert.strictEqual(local.length, 0);
  assert.strictEqual(c.wx.getStorageSync('other_module_token'), 'keep');
});

test('持久化:同一份 wx 存储,重建 Storage 仍能读到(模拟冷启动)', () => {
  const shared = new Map();
  setup({ storage: shared }).local.setItem('flutter.token', 'A');
  assert.strictEqual(setup({ storage: shared }).local.getItem('flutter.token'), 'A');
});

test('超限抛 QuotaExceededError', () => {
  const { local } = setup({ storageQuotaKeys: ['mpf:big'] });
  assert.throws(() => local.setItem('big', 'x'), (e) => e.name === 'QuotaExceededError' && /1MB|10MB/.test(e.message));
});

test('sessionStorage 为内存实现,语义相同', () => {
  const { session } = setup();
  assert.strictEqual(session.getItem('a'), null);
  session.setItem('a', '');
  assert.strictEqual(session.getItem('a'), '');
  assert.strictEqual(session.length, 1);
  session.clear();
  assert.strictEqual(session.length, 0);
});

test('索引一次建好:构造后连续 50 次 length/key(i) 枚举不再触发 wx.getStorageInfoSync', () => {
  const c = createMpContext();
  let calls = 0;
  const orig = c.wx.getStorageInfoSync;
  c.wx.getStorageInfoSync = (...args) => { calls++; return orig.apply(c.wx, args); };
  const s = c.requireModule(path.join(RT, 'storage.js'));
  const local = s.createWxStorage({ wx: c.wx });
  assert.strictEqual(calls, 1, '构造时应且只应调用一次 getStorageInfoSync');
  local.setItem('a', '1');
  local.setItem('b', '2');
  for (let i = 0; i < 50; i++) {
    void local.length;
    void local.key(0);
    void local.key(1);
  }
  assert.strictEqual(calls, 1, 'length/key(i) 走内存索引,不应再触发 getStorageInfoSync');
});

test('超限抛错的键不进索引', () => {
  const { local } = setup({ storageQuotaKeys: ['mpf:big'] });
  assert.throws(() => local.setItem('big', 'x'));
  assert.strictEqual(local.length, 0);
  assert.strictEqual(local.key(0), null);
});

// —— 终审修复 M-c:key(i) 缓存 Array.from(index),在 set/removeItem/clear 时作废 ——

function keysOf(local) {
  const out = [];
  for (let i = 0; i < local.length; i++) out.push(local.key(i));
  return out;
}

test('key(i) 缓存在 set/removeItem/clear 后正确作废,不会返回陈旧的枚举结果', () => {
  const { local } = setup();
  local.setItem('a', '1');
  assert.deepStrictEqual(keysOf(local), ['a']);
  // 读一次 key(0) 让缓存建立,紧接着 setItem 新键:缓存必须失效才能枚举到它
  void local.key(0);
  local.setItem('b', '2');
  assert.deepStrictEqual(keysOf(local), ['a', 'b'], '新增键后 key(i) 缓存必须失效,能枚举到新键');
  void local.key(0);
  local.removeItem('a');
  assert.deepStrictEqual(keysOf(local), ['b'], '删除键后 key(i) 缓存必须失效');
  local.setItem('c', '3');
  void local.key(0);
  local.clear();
  assert.strictEqual(local.length, 0);
  assert.strictEqual(local.key(0), null, 'clear 后 key(i) 缓存必须失效,不能返回陈旧键');
});

test('覆盖已存在的键不影响 key(i) 枚举结果(不产生重复项)', () => {
  const { local } = setup();
  local.setItem('a', '1');
  void local.key(0);
  local.setItem('a', '2');   // 覆盖同一个键
  assert.deepStrictEqual(keysOf(local), ['a']);
  assert.strictEqual(local.getItem('a'), '2');
});

test('垫片把 localStorage/sessionStorage 挂到 window 与 self', () => {
  const c = createMpContext();
  const shim = c.requireModule(path.join(RT, 'bom-shim.js')).install({ canvas: c.canvas, width: 390, height: 844, dpr: 3 });
  shim.window.localStorage.setItem('k', 'v');
  assert.strictEqual(shim.self.localStorage.getItem('k'), 'v');
  assert.strictEqual(typeof shim.window.sessionStorage.getItem, 'function');
});
