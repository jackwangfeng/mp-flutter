'use strict';
/**
 * crypto.getRandomValues / crypto.randomUUID(K4)。
 *
 * 小程序逻辑层没有 window.crypto,dart:math 的 `Random.secure()`(dart2js 编译到
 * web 时经 `self.crypto.getRandomValues`)拿不到就直接抛 UnsupportedError——
 * 一个真实电商小程序在插件注册阶段就调用它(uuid 初始化),Phase 3 把这个缺口标成
 * "后续最高优先级"(K4)。
 *
 * 设计:
 *   1. 启动时 `wx.getRandomValues({length: 48})` 取一次真随机种子(异步;拷进
 *      本域,原因见下)。
 *   2. 种子喂给 ChaCha20(RFC 8439 §2.3 的分组函数)当确定性随机数发生器
 *      (DRBG)——`getRandomValues`/`randomUUID` 因此可以**同步**产出(浏览器
 *      的 crypto.getRandomValues 也是同步 API,Dart 侧按同步语义调用)。
 *   3. 每产出 1MB 或每 60s(先到者为准),后台异步再取一次 `wx.getRandomValues`
 *      并采用 fast-key-erasure 策略重新播种:立即用*当前*密钥消耗掉紧接着的
 *      一个分组(这块绝不会被当作随机数交给调用方——nextBlock() 已把计数器
 *      前移过去),新种子到达后把它与这块"废料"异或得到新密钥。这样即使新
 *      种子迟迟不来,generate() 也不阻塞;新密钥到位后旧密钥的任何输出都无法
 *      被用来推算新密钥(前向安全)。
 *
 * 不伪造安全性:`wx.getRandomValues` 不存在(基础库版本太旧)或播种失败,
 * 这里返回 null——调用方(boot.js)因此不会把 crypto 挂到 window/self,
 * dart:math 的 Random.secure() 继续按浏览器无该 API 时的语义抛 Unsupported,
 * 绝不退回 Math.random 之类的假随机源。
 *
 * 外来 realm 拷贝:`wx.getRandomValues` 的 `res.randomValues` 与 `wx.request`
 * 返回的 ArrayBuffer 一样,是另一个 realm 的对象(开发者工具 2.02 起原型链
 * 冻结,dart2js 首次触达会尝试写 dispatch 标记从而抛错)。这里用
 * `new Uint8Array(foreign)` 读出字节后 `.set()` 进本域新建的数组,绝不
 * 直接持有/透传外来对象本身。
 */

// ---------------------------------------------------------------------
// ChaCha20 分组函数(RFC 8439 §2.3)。
// ---------------------------------------------------------------------

// "expand 32-byte k" 按 4 字节一组、小端序读出的四个常量字。
const CHACHA_CONST0 = 0x61707865, CHACHA_CONST1 = 0x3320646e,
      CHACHA_CONST2 = 0x79622d32, CHACHA_CONST3 = 0x6b206574;

function rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

// 一次 quarter round(RFC 8439 §2.1):a/b/c/d 是 state 数组里的下标。
function quarterRound(s, a, b, c, d) {
  s[a] += s[b]; s[d] = rotl32(s[d] ^ s[a], 16);
  s[c] += s[d]; s[b] = rotl32(s[b] ^ s[c], 12);
  s[a] += s[b]; s[d] = rotl32(s[d] ^ s[a], 8);
  s[c] += s[d]; s[b] = rotl32(s[b] ^ s[c], 7);
}

/**
 * ChaCha20 分组函数:32 字节 key + 12 字节 nonce(IETF 变体)+ 32 位分组计数器
 * → 64 字节密钥流。RFC 8439 §2.3 的 20 轮(10 组"列 + 对角线"双轮)。
 */
function chacha20Block(key, counter, nonce) {
  const init = new Uint32Array(16);
  init[0] = CHACHA_CONST0; init[1] = CHACHA_CONST1;
  init[2] = CHACHA_CONST2; init[3] = CHACHA_CONST3;
  for (let i = 0; i < 8; i++) {
    const o = i * 4;
    init[4 + i] = key[o] | (key[o + 1] << 8) | (key[o + 2] << 16) | (key[o + 3] << 24);
  }
  init[12] = counter >>> 0;
  init[13] = nonce[0] | (nonce[1] << 8) | (nonce[2] << 16) | (nonce[3] << 24);
  init[14] = nonce[4] | (nonce[5] << 8) | (nonce[6] << 16) | (nonce[7] << 24);
  init[15] = nonce[8] | (nonce[9] << 8) | (nonce[10] << 16) | (nonce[11] << 24);

  const work = Uint32Array.from(init);
  for (let round = 0; round < 10; round++) {
    quarterRound(work, 0, 4, 8, 12);
    quarterRound(work, 1, 5, 9, 13);
    quarterRound(work, 2, 6, 10, 14);
    quarterRound(work, 3, 7, 11, 15);
    quarterRound(work, 0, 5, 10, 15);
    quarterRound(work, 1, 6, 11, 12);
    quarterRound(work, 2, 7, 8, 13);
    quarterRound(work, 3, 4, 9, 14);
  }

  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const v = (work[i] + init[i]) >>> 0;
    const o = i * 4;
    out[o] = v & 0xff; out[o + 1] = (v >>> 8) & 0xff;
    out[o + 2] = (v >>> 16) & 0xff; out[o + 3] = (v >>> 24) & 0xff;
  }
  return out;
}

/** 从 counter 开始连续产出 length 字节密钥流(多分组拼接)。 */
function chacha20Keystream(key, counter, nonce, length) {
  const out = new Uint8Array(length);
  let c = counter >>> 0;
  let offset = 0;
  while (offset < length) {
    const block = chacha20Block(key, c, nonce);
    const take = Math.min(64, length - offset);
    out.set(take === 64 ? block : block.subarray(0, take), offset);
    offset += take;
    c = (c + 1) >>> 0;
  }
  return out;
}

function readUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

// ---------------------------------------------------------------------
// wx.getRandomValues 取种子:异步、拷进本域。
// ---------------------------------------------------------------------

function describeErr(err) {
  return (err && (err.errMsg || err.message)) || String(err);
}

function fetchEntropy(wx, length) {
  return new Promise((resolve, reject) => {
    let done = false;
    try {
      wx.getRandomValues({
        length,
        success(res) {
          if (done) return; done = true;
          try {
            const raw = res && res.randomValues;
            if (raw == null) { reject(new Error('wx.getRandomValues 返回值缺少 randomValues')); return; }
            // 外来 realm 拷贝(见文件头注释)
            const foreign = new Uint8Array(raw);
            if (foreign.length < length) {
              reject(new Error('wx.getRandomValues 返回字节数不足: 期望 ' + length + ',实际 ' + foreign.length));
              return;
            }
            const local = new Uint8Array(length);
            local.set(foreign.subarray(0, length));
            resolve(local);
          } catch (e) { reject(e); }
        },
        fail(err) { if (done) return; done = true; reject(err || new Error('wx.getRandomValues:fail')); },
      });
    } catch (e) { reject(e); }
  });
}

// ---------------------------------------------------------------------
// DRBG:重新播种阈值 + fast-key-erasure。
// ---------------------------------------------------------------------

const SEED_BYTES = 48;              // 32(key) + 12(nonce) + 4(初始计数器,增加多样性)
const RESEED_BYTES = 1024 * 1024;   // 每产出 1MB
const RESEED_TIMEOUT_MS = 10 * 1000; // 取熵超时按失败处理
const INITIAL_SEED_TIMEOUT_MS = 4 * 1000; // 首次播种超时(I1):拿不到就按失败处理,不永久黑屏
const RESEED_MS = 60 * 1000;        // 或每 60s,先到者为准
const MAX_GET_RANDOM_VALUES_BYTES = 65536; // 与浏览器 crypto.getRandomValues 上限一致

function domError(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

const INTEGER_TYPE_TAGS = new Set([
  '[object Int8Array]', '[object Uint8Array]', '[object Uint8ClampedArray]',
  '[object Int16Array]', '[object Uint16Array]',
  '[object Int32Array]', '[object Uint32Array]',
  '[object BigInt64Array]', '[object BigUint64Array]',
]);

// 用 Object.prototype.toString 的 tag 判定,而不是 instanceof——不依赖调用方
// 的类型化数组构造器与本模块出自同一个 realm(与本文件其余"拷进本域"的
// 谨慎一致,虽然生产环境里 dart2js 的类型化数组本就与本模块同 realm)。
function isIntegerTypedArray(v) {
  return v != null && INTEGER_TYPE_TAGS.has(Object.prototype.toString.call(v));
}

function buildApi(wx, warn, now, seed) {
  const state = {
    key: seed.slice(0, 32),
    nonce: seed.slice(32, 44),
    counter: readUint32LE(seed, 44),
    bytesSinceReseed: 0,
    lastReseedAt: now(),
    reseeding: false,
    warnedReseedFail: false,
  };

  function nextBlock() {
    const block = chacha20Block(state.key, state.counter, state.nonce);
    state.counter = (state.counter + 1) >>> 0;
    // 计数器回绕(2^32 个分组)前就地换钥,杜绝同一 (key, nonce, counter) 复用
    // (新钥取自翻转 nonce 首字节的分组——该分组从未输出过,做域分离)
    if (state.counter === 0) {
      const sep = state.nonce.slice();
      sep[0] ^= 0xff;
      state.key = chacha20Block(state.key, 0, sep).slice(0, 32);
    }
    return block;
  }

  function maybeReseed() {
    if (state.reseeding) return;
    const due = state.bytesSinceReseed >= RESEED_BYTES || (now() - state.lastReseedAt) >= RESEED_MS;
    if (!due) return;
    state.reseeding = true;
    // fast key erasure:立即(同步)烧掉下一个分组当"旧料"——它已经被
    // nextBlock() 转出计数器,不会再被当成随机数输出给调用方。
    const erasureBlock = nextBlock();
    // wx 回调可能永不触发:超时按失败处理,避免 reseeding 永久卡住
    const timed = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('wx.getRandomValues 超时')), RESEED_TIMEOUT_MS);
      fetchEntropy(wx, SEED_BYTES).then((v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); });
    });
    timed.then((fresh) => {
      const newKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) newKey[i] = erasureBlock[i] ^ fresh[i];
      state.key = newKey;
      state.nonce = fresh.slice(32, 44);
      state.counter = readUint32LE(fresh, 44);
      state.bytesSinceReseed = 0;
      state.lastReseedAt = now();
      state.reseeding = false;
    }, (err) => {
      // 播种失败:用自身输出换钥(fast key erasure,保住前向安全与计数器空间),
      // 下次达到阈值时再重试取新熵。只 warn 一次,不刷屏。
      state.key = erasureBlock.slice(0, 32);
      state.counter = 0;
      if (!state.warnedReseedFail) {
        state.warnedReseedFail = true;
        warn('mp-flutter: crypto DRBG 重新播种失败,继续使用旧密钥(' + describeErr(err) + ')');
      }
      state.lastReseedAt = now();
      state.reseeding = false;
    });
  }

  function fill(out) {
    let offset = 0;
    while (offset < out.length) {
      const block = nextBlock();
      const take = Math.min(64, out.length - offset);
      out.set(take === 64 ? block : block.subarray(0, take), offset);
      offset += take;
    }
    state.bytesSinceReseed += out.length;
    maybeReseed();
  }

  function getRandomValues(typedArray) {
    if (!isIntegerTypedArray(typedArray)) {
      throw domError('TypeMismatchError',
        'crypto.getRandomValues: 参数必须是整数类型化数组'
        + '(Int8/Uint8/Uint8Clamped/Int16/Uint16/Int32/Uint32/BigInt64/BigUint64Array 之一)');
    }
    if (typedArray.byteLength > MAX_GET_RANDOM_VALUES_BYTES) {
      throw domError('QuotaExceededError',
        'crypto.getRandomValues: 单次最多 ' + MAX_GET_RANDOM_VALUES_BYTES + ' 字节(与浏览器一致),'
        + '实际请求 ' + typedArray.byteLength + ' 字节');
    }
    fill(new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength));
    return typedArray;
  }

  function randomUUID() {
    const bytes = new Uint8Array(16);
    fill(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.prototype.map.call(bytes, (b) => b.toString(16).padStart(2, '0'));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') + '-'
      + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('');
  }

  return { version: 1, getRandomValues, randomUUID };
}

function defaultWarn(msg) {
  try { if (typeof console !== 'undefined' && console.warn) console.warn(msg); } catch (e) { /* 忽略 */ }
}

/**
 * 异步构造 crypto API。`wx.getRandomValues` 缺失、播种失败或**首次播种超时**
 * (I1,默认 4s;`wx.getRandomValues` 回调永不触发也不例外——`boot.js` 串行 await
 * 这个 Promise,拿不到就永久黑屏)时解出 `null`(调用方不得挂 window.crypto,
 * 见文件头注释);成功时解出 `{ getRandomValues, randomUUID }`。
 *
 * deps.now 仅供单测注入可控时钟,生产环境不传,默认 Date.now。
 * deps.initialSeedTimeoutMs 仅供单测覆盖首次播种超时阈值,生产环境不传。
 */
function createCrypto(deps) {
  deps = deps || {};
  const wx = deps.wx;
  const warn = deps.warn || defaultWarn;
  const now = deps.now || Date.now;
  const timeoutMs = deps.initialSeedTimeoutMs || INITIAL_SEED_TIMEOUT_MS;
  if (!wx || typeof wx.getRandomValues !== 'function') {
    warn('mp-flutter: 当前基础库不支持 wx.getRandomValues,crypto.getRandomValues/randomUUID 不挂载'
      + '(dart:math 的 Random.secure() 将按浏览器无该 API 时的语义抛 Unsupported;需升级微信基础库版本)。');
    return Promise.resolve(null);
  }
  // I1:首次播种套超时,`wx.getRandomValues` 回调迟迟不来(或压根不触发)不能让
  // boot.js 永久卡在 await 上——超时按失败处理,复用下面同一条"播种失败"分支
  // (返回 null、只 warn 一次),不伪造安全性,也不阻塞 loadDart。
  const seeded = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('wx.getRandomValues 首次播种超时(' + timeoutMs + 'ms 内未回调)')), timeoutMs);
    fetchEntropy(wx, SEED_BYTES).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); });
  });
  return seeded.then(
    (seed) => buildApi(wx, warn, now, seed),
    (err) => {
      warn('mp-flutter: wx.getRandomValues 播种失败,crypto.getRandomValues/randomUUID 不挂载('
        + describeErr(err) + ')。');
      return null;
    });
}

module.exports = { createCrypto, chacha20Block, chacha20Keystream };
