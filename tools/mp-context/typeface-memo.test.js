const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');
const { installTypefaceMemo } = require(path.join(RT, 'typeface-memo.js'));

// 模拟 embind 句柄:clone 共享计数,delete 只减自己的;计数归零即释放
function fakeCK() {
  const parsed = [];
  function handle(shared) {
    let deleted = false;
    shared.count++;
    return {
      shared,
      clone() { return handle(shared); },
      delete() { if (deleted) throw new Error('double delete'); deleted = true; shared.count--; },
      isDeleted() { return deleted; },
    };
  }
  const make = function (data) {
    parsed.push(data.byteLength);
    if (data.byteLength === 0) return null;
    return handle({ id: parsed.length, count: 0 });
  };
  const CK = { Typeface: { MakeTypefaceFromData: make } };
  CK.Typeface.MakeFreeTypeFaceFromData = make;
  // 与 CanvasKit 同形:registerFont 内部经 Typeface.MakeTypefaceFromData 解析后 delete
  CK.registerFont = function (bytes) { const tf = CK.Typeface.MakeTypefaceFromData(bytes); tf.delete(); };
  return { CK, parsed };
}

test('同一份字节只解析一次:ArrayBuffer 与其上的 Uint8Array 视图共用一份', () => {
  const { CK, parsed } = fakeCK();
  const m = installTypefaceMemo(CK);
  const buf = new ArrayBuffer(16);
  const a = CK.Typeface.MakeFreeTypeFaceFromData(buf);   // 引擎持有
  CK.registerFont(new Uint8Array(buf));                  // 第 1 批注册
  CK.registerFont(new Uint8Array(buf));                  // 第 2 批重新注册
  assert.deepStrictEqual(parsed, [16]);
  assert.deepStrictEqual(m.stats, { parses: 1, hits: 2 });
  assert.strictEqual(a.isDeleted(), false);
  // registerFont 的 delete 只释放 clone;主句柄 + 引擎那份仍在
  assert.strictEqual(a.shared.count, 2);
});

test('不同字节、不同视图范围各自解析;解析失败不缓存', () => {
  const { CK, parsed } = fakeCK();
  const m = installTypefaceMemo(CK);
  const buf = new ArrayBuffer(32);
  CK.Typeface.MakeTypefaceFromData(new Uint8Array(buf, 0, 16));
  CK.Typeface.MakeTypefaceFromData(new Uint8Array(buf, 16, 16));
  CK.Typeface.MakeTypefaceFromData(new ArrayBuffer(8));
  assert.strictEqual(CK.Typeface.MakeTypefaceFromData(new ArrayBuffer(0)), null);
  assert.strictEqual(CK.Typeface.MakeTypefaceFromData(new ArrayBuffer(0)), null);
  assert.deepStrictEqual(parsed, [16, 16, 8, 0, 0]);
  assert.strictEqual(m.stats.hits, 0);
});

test('onParse 回调区分真解析与命中;uninstall 还原', () => {
  const { CK } = fakeCK();
  const orig = CK.Typeface.MakeTypefaceFromData;
  const ev = [];
  let t = 0;
  const m = installTypefaceMemo(CK, { now: () => (t += 5), onParse: (e) => ev.push(e) });
  const buf = new ArrayBuffer(4);
  CK.Typeface.MakeTypefaceFromData(buf);
  CK.Typeface.MakeTypefaceFromData(new Uint8Array(buf));
  assert.deepStrictEqual(ev, [{ ms: 5, bytes: 4 }, { hit: true, bytes: 4 }]);
  m.uninstall();
  assert.strictEqual(CK.Typeface.MakeTypefaceFromData, orig);
  assert.strictEqual(CK.Typeface.MakeFreeTypeFaceFromData, orig);
});

test('MakeFreeTypeFaceFromData 不是别名时不接管;CK 缺 API 返回 null', () => {
  const { CK } = fakeCK();
  const other = function () { return null; };
  CK.Typeface.MakeFreeTypeFaceFromData = other;
  installTypefaceMemo(CK);
  assert.strictEqual(CK.Typeface.MakeFreeTypeFaceFromData, other);
  assert.strictEqual(installTypefaceMemo({}), null);
});
