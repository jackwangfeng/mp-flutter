const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createSafeArea, computeInsets } = require(path.resolve(__dirname, '../../packages/mp_flutter/runtime/safe-area.js'));

const PORTRAIT = {
  windowWidth: 390, windowHeight: 844, screenWidth: 390, screenHeight: 844, statusBarHeight: 47,
  safeArea: { top: 47, left: 0, right: 390, bottom: 810, width: 390, height: 763 },
};
const LANDSCAPE = {
  windowWidth: 844, windowHeight: 390, screenWidth: 844, screenHeight: 390, statusBarHeight: 0,
  safeArea: { top: 0, left: 47, right: 797, bottom: 369, width: 750, height: 369 },
};

test('竖屏:top=safeArea.top,bottom=窗口高-safeArea.bottom', () => {
  assert.deepStrictEqual(computeInsets(PORTRAIT), { top: 47, right: 0, bottom: 34, left: 0 });
});

test('横屏:左右刘海按 safeArea.left / 窗口宽-safeArea.right', () => {
  assert.deepStrictEqual(computeInsets(LANDSCAPE), { top: 0, right: 47, bottom: 21, left: 47 });
});

test('缺 safeArea 时 top 退回 statusBarHeight;什么都没有时全 0,不产生 NaN/负数', () => {
  assert.deepStrictEqual(computeInsets({ windowWidth: 375, windowHeight: 667, statusBarHeight: 20 }),
    { top: 20, right: 0, bottom: 0, left: 0 });
  assert.deepStrictEqual(computeInsets(null), { top: 0, right: 0, bottom: 0, left: 0 });
  assert.deepStrictEqual(computeInsets({ windowWidth: 390, windowHeight: 800,
    safeArea: { top: 47, left: 0, right: 390, bottom: 844 } }), { top: 47, right: 0, bottom: 0, left: 0 });
});

test('wx.onWindowResize 触发后重读安全区并通知订阅者;值不变不通知', () => {
  let info = PORTRAIT;
  let resizeCb = null;
  const wx = { getWindowInfo: () => info, onWindowResize: (cb) => { resizeCb = cb; }, offWindowResize: () => { resizeCb = null; } };
  const sa = createSafeArea({ wx });
  assert.strictEqual(sa.bridge.top, 47);
  assert.strictEqual(sa.bridge.bottom, 34);
  let n = 0;
  const off = sa.bridge.listen(() => { n++; });
  assert.strictEqual(typeof resizeCb, 'function');
  resizeCb({ size: {} });
  assert.strictEqual(n, 0, '安全区没变不通知');
  info = LANDSCAPE;
  resizeCb({ size: {} });
  assert.strictEqual(n, 1);
  assert.deepStrictEqual([sa.bridge.top, sa.bridge.right, sa.bridge.bottom, sa.bridge.left], [0, 47, 21, 47]);
  off();
  info = PORTRAIT;
  resizeCb({ size: {} });
  assert.strictEqual(n, 1, '取消订阅后不再通知');
  assert.strictEqual(sa.bridge.top, 47);
  sa.dispose();
  assert.strictEqual(resizeCb, null);
});

test('订阅者抛异常不影响其它订阅者;没有 onWindowResize 的旧基础库照常可用', () => {
  const sa = createSafeArea({ wx: { getWindowInfo: () => PORTRAIT } });
  let ok = 0;
  sa.bridge.listen(() => { throw new Error('boom'); });
  sa.bridge.listen(() => { ok++; });
  sa.bridge.top = -1;   // 人为制造差异
  assert.strictEqual(sa.refresh(), true);
  assert.strictEqual(ok, 1);
});
