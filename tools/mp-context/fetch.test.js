const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');

const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

// boot.js 会 require ./canvaskit.js(构建期才产出),这里只单独测
// matchAsset / loadSubpackages / decodeParts,不调用 boot 本身。
function loadBoot(c) {
  return c.requireModule(path.join(RT, 'boot.js'));
}

function loadNet(c) {
  return c.requireModule(path.join(RT, 'net.js'));
}

// 生产路径:window.fetch = makeFetch(createNet(...))(boot.js 里就是这么接的)。
// 不再测已删除的 makeAssetFetch —— 那条路径已经不在生产代码里跑了,测它只会
// 给假信心(修复轮 1 Important 1 指出的问题)。
//
// 本文件里"命中/未命中资源"的绝对 URL 一律用 https://mp.local(垫片自身
// origin,见 bom-shim.js 的 loc)——终审修复(final-fix)Important 1:只有
// 垫片自身 origin 下的绝对 URL 才按后缀匹配资源,其它 origin(哪怕后缀同名)
// 一律发 wx.request,不做资源匹配。这一区分单独在 net.test.js 里覆盖。
function fetchWithAssets(c, assets) {
  const boot = loadBoot(c);
  const net = loadNet(c);
  const n = net.createNet({ wx: c.wx, assets, matchAsset: boot.matchAsset, decodeParts: boot.decodeParts });
  return net.makeFetch(n);
}

async function readAll(resp) {
  const reader = resp.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(...value);
  }
  return Uint8Array.from(chunks);
}

test('命中资源:异步加载 base64 模块,流式 body 返回原始字节', async () => {
  const c = createMpContext();
  let loads = 0;
  const fetchFn = fetchWithAssets(c, {
    'assets/FontManifest.json': () => { loads++; return Promise.resolve(Buffer.from('[{"a":1}]').toString('base64')); },
  });
  const resp = await fetchFn('https://mp.local/assets/FontManifest.json');
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(resp.status, 200);
  assert.strictEqual(Buffer.from(await readAll(resp)).toString(), '[{"a":1}]');
  assert.strictEqual(loads, 1);
});

test('命中资源:text()/json() 走同一份字节', async () => {
  const c = createMpContext();
  const b64 = Buffer.from('{"中":1}').toString('base64');
  const fetchFn = fetchWithAssets(c, { 'assets/x.json': () => Promise.resolve(b64) });
  const resp = await fetchFn('assets/x.json');
  assert.deepStrictEqual(await resp.json(), { '中': 1 });
});

test('资源模块加载失败必须 reject 并带出资源路径,不能伪装成 404(生产路径:net.route)', async () => {
  const c = createMpContext();
  const fetchFn = fetchWithAssets(c, {
    'assets/fonts/MaterialIcons-Regular.otf': () => Promise.reject(new Error('module not defined')),
  });
  await assert.rejects(fetchFn('https://mp.local/assets/fonts/MaterialIcons-Regular.otf'),
    /MaterialIcons-Regular\.otf.*module not defined/);
});

test('未命中:404,流式 body 仍可读且第二次 read 为 done', async () => {
  const c = createMpContext();
  const fetchFn = fetchWithAssets(c, {});
  const miss = await fetchFn('https://mp.local/assets/NotThere.json');
  assert.strictEqual(miss.ok, false);
  assert.strictEqual(miss.status, 404);
  const reader = miss.body.getReader();
  assert.strictEqual((await reader.read()).done, false);
  assert.strictEqual((await reader.read()).done, true, '第二次 read 必须 done');
});

test('未命中的响应 text() 返回空串而非抛错', async () => {
  const c = createMpContext();
  const fetchFn = fetchWithAssets(c, {});
  const resp = await fetchFn('https://mp.local/whatever');
  assert.strictEqual(await resp.text(), '');
});

test('loadSubpackages 并行加载每个分包的就位探针', async () => {
  const c = createMpContext();
  const { loadSubpackages } = loadBoot(c);
  const started = [];
  await loadSubpackages({
    'pkg-dart': () => { started.push('pkg-dart'); return Promise.resolve(true); },
    'pkg-wasm': () => { started.push('pkg-wasm'); return Promise.resolve(true); },
  });
  assert.deepStrictEqual(started, ['pkg-dart', 'pkg-wasm']);
});

test('任一分包加载失败:reject 且错误信息点名该分包', async () => {
  const c = createMpContext();
  const { loadSubpackages } = loadBoot(c);
  await assert.rejects(loadSubpackages({
    'pkg-dart': () => Promise.resolve(true),
    'pkg-wasm': () => Promise.reject(new Error('subpackage download fail')),
  }), /分包 pkg-wasm 加载失败: subpackage download fail/);
});

test('小程序没有 wx.loadSubpackage:boot.js 不得调用它', () => {
  const src = require('fs').readFileSync(
    path.resolve(__dirname, '../../packages/mp_flutter/runtime/boot.js'), 'utf8');
  assert.ok(!/wx\.loadSubpackage\s*\(/.test(src), 'wx.loadSubpackage 是小游戏 API');
});

test('wx.base64ToArrayBuffer 返回外来 realm 的冻结原型 buffer 时,交给引擎的必须是本 realm 的 buffer', async () => {
  const vm = require('vm');
  // 模拟开发者工具 2.02:buffer 来自另一个 realm,且那个 realm 的 ArrayBuffer.prototype 被冻结
  const foreign = vm.runInNewContext(
    'Object.freeze(ArrayBuffer.prototype); (b) => { const a = new ArrayBuffer(b.length); new Uint8Array(a).set(b); return a; }');
  const c = createMpContext();
  c.wx.base64ToArrayBuffer = (b64) => foreign(Buffer.from(b64, 'base64'));
  const b64 = Buffer.from('hello').toString('base64');
  const fetchFn = fetchWithAssets(c, { 'assets/a.txt': () => Promise.resolve(b64) });
  const resp = await fetchFn('assets/a.txt');
  const ab = await resp.arrayBuffer();
  const proto = Object.getPrototypeOf(ab);
  assert.strictEqual(Object.isFrozen(proto), false, '原型被冻结,dart2js 写 dispatch 标记会抛错');
  assert.strictEqual(Buffer.from(new Uint8Array(ab)).toString(), 'hello');
});

test('matchAsset 取最长后缀:请求 .bin.json 不能拿到 .bin 的内容', () => {
  const c = createMpContext();
  const { matchAsset } = loadBoot(c);
  const assets = { 'assets/AssetManifest.bin': 1, 'assets/AssetManifest.bin.json': 1, 'mp-fonts/roboto/v32/a.woff2': 1 };
  assert.strictEqual(matchAsset(assets, 'assets/AssetManifest.bin.json'), 'assets/AssetManifest.bin.json');
  assert.strictEqual(matchAsset(assets, 'assets/AssetManifest.bin'), 'assets/AssetManifest.bin');
  assert.strictEqual(matchAsset(assets, 'https://x/assets/AssetManifest.bin?v=1'), 'assets/AssetManifest.bin');
  assert.strictEqual(matchAsset(assets, 'mp-fonts/roboto/v32/a.woff2'), 'mp-fonts/roboto/v32/a.woff2');
  // 只在路径分隔处认后缀:xassets/... 不算命中
  assert.strictEqual(matchAsset(assets, 'xassets/AssetManifest.bin'), null);
  assert.strictEqual(matchAsset(assets, 'assets/Other.bin'), null);
});

test('切片资源:各片独立解码后按序拼接', async () => {
  const c = createMpContext();
  const whole = Buffer.from('0123456789abcdefghij');
  // 切在 6 字节处 → 每片 base64 长度都是 4 的倍数
  const parts = [whole.subarray(0, 6), whole.subarray(6, 12), whole.subarray(12)].map((b) => b.toString('base64'));
  const fetchFn = fetchWithAssets(c, { 'assets/big.bin': () => Promise.resolve(parts) });
  const resp = await fetchFn('assets/big.bin');
  assert.strictEqual(Buffer.from(await readAll(resp)).toString(), whole.toString());
});

test('matchAsset 先 URL 解码:引擎对资源路径做了 Uri.encodeFull', () => {
  const c = createMpContext();
  const { matchAsset } = loadBoot(c);
  const assets = { 'assets/assets/图片/a b.png': 1 };
  assert.strictEqual(matchAsset(assets, encodeURI('assets/assets/图片/a b.png')), 'assets/assets/图片/a b.png');
  // 非法百分号编码不应抛错
  assert.strictEqual(matchAsset(assets, 'assets/%E0%A4%A.png'), null);
});

test('加载表条目不是函数时 loadSubpackages 显式失败,不静默通过', async () => {
  const c = createMpContext();
  const { loadSubpackages } = loadBoot(c);
  await assert.rejects(loadSubpackages({ 'pkg-dart': 'oops' }), /加载表损坏.*pkg-dart/);
});

test('boot 第二次调用以 MP_REENTRY 失败(承载页据此重启小程序)', async () => {
  const c = createMpContext();
  const { boot } = loadBoot(c);
  const stubManifest = { subPackages: {}, loadDart: () => new Promise(() => {}), assets: {} };
  // 第一次:单测环境没有构建期产物 canvaskit.js,boot() 内部同步 require 它会
  // 同步抛出(而不是走到 Promise 链再 reject)——用 try/catch 兜住同步抛出和
  // 异步 reject 两种情况,这里只关心第二次调用能否以 MP_REENTRY 拒绝。
  try { boot({ canvas: c.canvas, manifest: stubManifest }).catch(() => {}); } catch (e) { /* 无所谓 */ }
  await assert.rejects(boot({ canvas: c.canvas, manifest: stubManifest }), (e) => e.code === 'MP_REENTRY');
});
