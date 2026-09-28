const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const path = require('path');
const { createMpContext } = require('./context');

const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

function hexToBytes(h) {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}
function bytesToHex(b) {
  return Array.prototype.map.call(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// RFC 8439 §2.4.2("Example and Test Vector for the ChaCha20 Cipher")的
// key/nonce/keystream——取自 RustCrypto/stream-ciphers 的 chacha20 crate
// (0.9.1)测试固件 tests/mod.rs,该固件本身就是照 RFC 原文抄的常量,并且
// 与固件里的 CIPHERTEXT = PLAINTEXT ^ KEYSTREAM 自洽(已用脚本核对过)。
// 固件说明:测试向量省略了前 64 字节密钥流(分组计数器从 1 开始,计数器 0
// 那一块被跳过未使用),所以 KEYSTREAM 对应分组计数器 1、2(第 2 块只用了
// 前 50 字节,114 = 64 + 50)。
const RFC8439_KEY = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const RFC8439_NONCE = hexToBytes('000000000000004a00000000');
const RFC8439_KEYSTREAM_114 =
  '224f51f3401bd9e12fde276fb8631ded8c131f823d2c06e27e4fcaec9ef3cf788a3b0aa372600a92b57974cded2b93' +
  '34794cba40c63e34cdea212c4cf07d41b769a6749f3f630f4122cafe28ec4dc47e26d4346d70b98c73f3e9c53ac40c5' +
  '945398b6eda1a832c89c167eacd901d7e2bf363';

function loadCrypto(c) {
  return c.requireModule(path.join(RT, 'crypto.js'));
}

test('ChaCha20 分组函数匹配 RFC 8439 §2.4.2 测试向量(计数器 1、2 拼接的密钥流)', () => {
  const c = createMpContext();
  const { chacha20Block } = loadCrypto(c);
  const block1 = chacha20Block(RFC8439_KEY, 1, RFC8439_NONCE);
  const block2 = chacha20Block(RFC8439_KEY, 2, RFC8439_NONCE);
  assert.strictEqual(block1.length, 64);
  const got = bytesToHex(block1) + bytesToHex(block2).slice(0, (114 - 64) * 2);
  assert.strictEqual(got, RFC8439_KEYSTREAM_114);
});

test('ChaCha20 多分组密钥流生成(chacha20Keystream)与 RFC 8439 §2.4.2 一致', () => {
  const c = createMpContext();
  const { chacha20Keystream } = loadCrypto(c);
  const stream = chacha20Keystream(RFC8439_KEY, 1, RFC8439_NONCE, 114);
  assert.strictEqual(bytesToHex(stream), RFC8439_KEYSTREAM_114);
});

test('分组计数器/nonce 改变时密钥流不同(基本 sanity,不是靠巧合撞对)', () => {
  const c = createMpContext();
  const { chacha20Block } = loadCrypto(c);
  const a = chacha20Block(RFC8439_KEY, 1, RFC8439_NONCE);
  const b = chacha20Block(RFC8439_KEY, 2, RFC8439_NONCE);
  const d = chacha20Block(RFC8439_KEY, 1, hexToBytes('000000000000004a00000001'));
  assert.notDeepStrictEqual(Array.from(a), Array.from(b));
  assert.notDeepStrictEqual(Array.from(a), Array.from(d));
});

// ---------------------------------------------------------------------
// wx.getRandomValues 播种 + DRBG API(getRandomValues/randomUUID)
// ---------------------------------------------------------------------

// 模拟"外来 realm"的 ArrayBuffer(与 tools/mp-context/context.js 内部
// foreignRealm 的做法一致):开发者工具 2.02 起 wx.getRandomValues 的
// res.randomValues 原型链冻结,必须验证实现会把它拷进本域而不是直接持有。
const foreignRealm = vm.runInNewContext(
  'Object.freeze(ArrayBuffer.prototype); (b) => { const a = new ArrayBuffer(b.length); new Uint8Array(a).set(b); return a; }');

// deterministic 假种子源:每次调用返回不同但可预测的字节,便于断言"确实用了
// 新播种的种子"而不是巧合;success 回调经 Promise 微任务延后,模拟真实异步。
function makeFakeWx() {
  let calls = 0;
  const lastLength = [];
  const wx = {
    getRandomValues(opts) {
      calls++;
      lastLength.push(opts.length);
      const bytes = new Uint8Array(opts.length);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (calls * 37 + i * 11) & 0xff;
      Promise.resolve().then(() => opts.success({ randomValues: foreignRealm(bytes) }));
    },
  };
  return { wx, calls: () => calls, lastLength };
}

function tick(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 3); i++) p = p.then(() => Promise.resolve());
  return p;
}

test('wx.getRandomValues 不存在:createCrypto 解出 null,且只 warn 一次', async () => {
  const c = createMpContext();
  const { createCrypto } = loadCrypto(c);
  const warned = [];
  const api = await createCrypto({ wx: {}, warn: (m) => warned.push(m) });
  assert.strictEqual(api, null);
  assert.strictEqual(warned.length, 1);
  assert.match(warned[0], /基础库|升级/);
});

test('wx.getRandomValues 播种失败(fail 回调):createCrypto 解出 null 并说明原因', async () => {
  const c = createMpContext();
  const { createCrypto } = loadCrypto(c);
  const wx = { getRandomValues(opts) { Promise.resolve().then(() => opts.fail({ errMsg: 'getRandomValues:fail 太旧' })); } };
  const warned = [];
  const api = await createCrypto({ wx, warn: (m) => warned.push(m) });
  assert.strictEqual(api, null);
  assert.strictEqual(warned.length, 1);
  assert.match(warned[0], /太旧/);
});

test('播种成功后 getRandomValues 同步产出、拷贝自外来 realm 的 ArrayBuffer、且与直接调用分组函数一致', async () => {
  const c = createMpContext();
  const { createCrypto, chacha20Block } = loadCrypto(c);
  const { wx } = makeFakeWx();
  const api = await createCrypto({ wx });
  assert.notStrictEqual(api, null);

  const out = new Uint8Array(20);
  const ret = api.getRandomValues(out);
  assert.strictEqual(ret, out, '必须返回同一个 typed array(与浏览器 API 一致)');
  assert.ok(out.some((b) => b !== 0), '不应该原样返回全零(没真的填充)');

  // 独立用种子(第一次 wx.getRandomValues 调用产出的 48 字节)重算前 20 字节
  // 密钥流,必须与 getRandomValues 的结果一致——证明 DRBG 状态是从这颗种子
  // 正确初始化的,不是另一套/伪造的随机源。
  const seed = new Uint8Array(48);
  for (let i = 0; i < 48; i++) seed[i] = (1 * 37 + i * 11) & 0xff;
  const key = seed.slice(0, 32), nonce = seed.slice(32, 44);
  const counter = (seed[44] | (seed[45] << 8) | (seed[46] << 16) | (seed[47] << 24)) >>> 0;
  const expected = chacha20Block(key, counter, nonce).subarray(0, 20);
  assert.deepStrictEqual(Array.from(out), Array.from(expected));
});

test('getRandomValues:超过 65536 字节抛 QuotaExceededError(DOMException 名称)', async () => {
  const c = createMpContext();
  const { createCrypto } = loadCrypto(c);
  const { wx } = makeFakeWx();
  const api = await createCrypto({ wx });
  assert.throws(() => api.getRandomValues(new Uint8Array(65537)),
    (e) => e.name === 'QuotaExceededError');
  // 边界值本身必须放行,不能"顺手"改成 >=
  assert.doesNotThrow(() => api.getRandomValues(new Uint8Array(65536)));
});

test('getRandomValues:非整数类型化数组抛 TypeMismatchError', async () => {
  const c = createMpContext();
  const { createCrypto } = loadCrypto(c);
  const { wx } = makeFakeWx();
  const api = await createCrypto({ wx });
  const bad = [new Float32Array(4), new Float64Array(4), new DataView(new ArrayBuffer(4)), {}, null, [1, 2, 3]];
  bad.forEach((v) => {
    assert.throws(() => api.getRandomValues(v), (e) => e.name === 'TypeMismatchError', String(v));
  });
  // 反例:各整数类型化数组都必须放行
  [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
    BigInt64Array, BigUint64Array].forEach((Ctor) => {
    assert.doesNotThrow(() => api.getRandomValues(new Ctor(4)), Ctor.name);
  });
});

test('randomUUID:符合 RFC 4122 v4 格式(version/variant 位),且两次不同', async () => {
  const c = createMpContext();
  const { createCrypto } = loadCrypto(c);
  const { wx } = makeFakeWx();
  const api = await createCrypto({ wx });
  const a = api.randomUUID();
  const b = api.randomUUID();
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(a, re);
  assert.match(b, re);
  assert.notStrictEqual(a, b);
});

test('每产出 ≥1MB 后台重新播种一次(不阻塞 generate,fast-key-erasure)', async () => {
  const c = createMpContext();
  const { createCrypto } = loadCrypto(c);
  const { wx, calls } = makeFakeWx();
  const api = await createCrypto({ wx });
  assert.strictEqual(calls(), 1, '初始播种应该已经调用过一次');

  const chunk = new Uint8Array(65536);
  // 65536 * 17 = 1,114,112 > 1MB,足以跨过阈值;getRandomValues 不是 async
  // 函数、不返回 Promise——触发重新播种时只是"发起" wx.getRandomValues(与
  // 真实 wx API 一样,调用本身同步返回、结果经 success/fail 回调异步交付),
  // 整个循环必须立即完成,不等待重新播种的结果落地。
  const before = Date.now();
  for (let i = 0; i < 17; i++) {
    const ret = api.getRandomValues(chunk);
    assert.strictEqual(ret instanceof Promise, false, 'getRandomValues 必须同步返回,不是 Promise');
  }
  assert.ok(Date.now() - before < 1000, 'generate 必须是同步的,不能等重新播种落地');
  assert.strictEqual(calls(), 2, '产出超过 1MB 时应该已经发起了一次新的取种子请求');

  // 此刻新种子还没经 success 回调落地(那是下一个微任务),继续 generate 用的
  // 仍是旧密钥,不应该抛错或卡住。
  assert.doesNotThrow(() => api.getRandomValues(new Uint8Array(4)));

  await tick();
  assert.strictEqual(calls(), 2, '重新播种只发起一次请求,不会因为落地过程被重复触发');
});

test('60s 到期后台重新播种一次(用可控时钟,不依赖真实墙钟)', async () => {
  const c = createMpContext();
  const { createCrypto } = loadCrypto(c);
  const { wx, calls } = makeFakeWx();
  let t = 0;
  const api = await createCrypto({ wx, now: () => t });
  assert.strictEqual(calls(), 1);

  api.getRandomValues(new Uint8Array(4));
  await tick();
  assert.strictEqual(calls(), 1, '不到 60s 不应该重新播种');

  t += 60000;
  api.getRandomValues(new Uint8Array(4));
  await tick();
  assert.strictEqual(calls(), 2, '满 60s 之后下一次 generate 应该触发重新播种');
});

test('重新播种失败时继续用旧密钥(不崩、不阻塞),只 warn 一次', async () => {
  const c = createMpContext();
  const { createCrypto } = loadCrypto(c);
  let n = 0;
  const wx = {
    getRandomValues(opts) {
      n++;
      if (n === 1) {
        const bytes = new Uint8Array(opts.length);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i;
        Promise.resolve().then(() => opts.success({ randomValues: foreignRealm(bytes) }));
      } else {
        Promise.resolve().then(() => opts.fail({ errMsg: '重新播种失败(模拟)' }));
      }
    },
  };
  const warned = [];
  const api = await createCrypto({ wx, warn: (m) => warned.push(m) });

  const chunk = new Uint8Array(65536);
  for (let i = 0; i < 17; i++) api.getRandomValues(chunk);
  await tick();
  assert.strictEqual(n, 2, '应该已经尝试过一次重新播种');
  assert.strictEqual(warned.length, 1);
  assert.match(warned[0], /重新播种失败/);

  // 继续可用:不因为重新播种失败就抛错或返回全零
  const out = new Uint8Array(16);
  api.getRandomValues(out);
  assert.ok(out.some((b) => b !== 0));

  // 再跑一轮超过 1MB,确认失败之后还能重试(不是永久卡死在 reseeding=true)
  for (let i = 0; i < 17; i++) api.getRandomValues(chunk);
  await tick();
  assert.ok(n >= 3, '失败后下次达到阈值应该重试重新播种');
});
