const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { preloadCjkFont } = require(path.resolve(__dirname, '../../packages/mp_flutter/runtime/cjk-font.js'));

test('先拉分包再 readCompressedFile(br),字节拷进本 realm', async () => {
  const order = [];
  const foreign = new Uint8Array([1, 2, 3]).buffer;
  const wx = { getFileSystemManager: () => ({ readCompressedFile(o) {
    order.push('read:' + o.filePath + ':' + o.compressionAlgorithm); o.success({ data: foreign }); } }) };
  const bytes = await preloadCjkFont({ file: '/pkg-cjk/f.br', load: () => { order.push('load'); return Promise.resolve(); } }, { wx, warn: () => {} });
  assert.deepStrictEqual(order, ['load', 'read:/pkg-cjk/f.br:br']);
  assert.deepStrictEqual(Array.from(bytes), [1, 2, 3]);
  assert.notStrictEqual(bytes.buffer, foreign);
});

test('分包失败 / API 不存在 / 读取失败:解出 null 并告警,不 reject', async () => {
  const warns = [];
  const warn = (m) => warns.push(m);
  assert.strictEqual(await preloadCjkFont({ file: 'x', load: () => Promise.reject(new Error('pkg fail')) },
    { wx: {}, warn }), null);
  assert.strictEqual(await preloadCjkFont({ file: 'x', load: () => Promise.resolve() },
    { wx: { getFileSystemManager: () => ({}) }, warn }), null);
  assert.strictEqual(await preloadCjkFont({ file: 'x', load: () => Promise.resolve() },
    { wx: { getFileSystemManager: () => ({ readCompressedFile(o) { o.fail({ errMsg: 'denied' }); } }) }, warn }), null);
  assert.strictEqual(warns.length, 3);
  assert.match(warns[0], /pkg fail/);
  assert.match(warns[1], /readCompressedFile 不可用/);
  assert.match(warns[2], /denied/);
});

test('M6:spec.load() 超时按读取失败处理——解出 null 并告警,不会一直等分包', async () => {
  const warns = [];
  const never = new Promise(() => {});   // 模拟分包一直不来
  const bytes = await preloadCjkFont(
    { file: 'x', load: () => never },
    { wx: {}, warn: (m) => warns.push(m), loadTimeoutMs: 5 },
  );
  assert.strictEqual(bytes, null);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /分包就位超时 5ms/);
});
