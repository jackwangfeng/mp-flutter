const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');
const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');
const { createFontCache, cacheFileName } = require(path.join(RT, 'font-cache.js'));

const WOFF2 = (n, fill) => { const b = new Uint8Array(n); b.fill(fill || 1); b.set([0x77, 0x4F, 0x46, 0x32]); return b; };

// 内存版 wx 文件系统:files 是 路径 → Buffer / string
function mockWx(files) {
  const fsCalls = [];
  const fs = {
    accessSync(p) { if (![...files.keys()].some((k) => k === p || k.startsWith(p + '/')) && !files.has(p + '/')) throw new Error('accessSync:fail no such file'); },
    mkdirSync(p) { fsCalls.push('mkdir ' + p); files.set(p + '/', ''); },
    readFileSync(p, enc) {
      fsCalls.push('read ' + p.split('/').pop());
      if (!files.has(p)) throw new Error('readFileSync:fail no such file');
      const v = files.get(p);
      if (enc === 'utf8') return String(v);
      return Uint8Array.from(v).buffer;
    },
    writeFileSync(p, data) {
      fsCalls.push('write ' + p.split('/').pop());
      files.set(p, typeof data === 'string' ? data : Buffer.from(new Uint8Array(data)));
    },
    unlinkSync(p) { fsCalls.push('unlink ' + p.split('/').pop()); if (!files.delete(p)) throw new Error('unlink:fail'); },
  };
  return { wx: { env: { USER_DATA_PATH: 'wxfile://usr' }, getFileSystemManager: () => fs }, fsCalls };
}

test('缓存文件名:/ 换成 __,非法字符换成 _', () => {
  assert.strictEqual(cacheFileName('notosanssc/v37/k3kC-o_84.4.woff2'), 'notosanssc__v37__k3kC-o_84.4.woff2');
  assert.strictEqual(cacheFileName('a b/c?.woff2'), 'a_b__c_.woff2');
});

test('未命中:从 baseUrl 下载、写文件与索引;再次加载直接读文件,不再下载', async () => {
  const files = new Map();
  const { wx } = mockWx(files);
  const urls = [];
  const c = createFontCache({ wx, baseUrl: 'https://cdn.x.com/f/', download: (u) => { urls.push(u); return Promise.resolve({ status: 200, bytes: WOFF2(100) }); } });
  const a = await c.load('notosanssc/v37/x.4.woff2');
  assert.strictEqual(a.length, 100);
  assert.deepStrictEqual(urls, ['https://cdn.x.com/f/notosanssc/v37/x.4.woff2']);
  assert.ok(files.has('wxfile://usr/mp-fonts-cache/notosanssc__v37__x.4.woff2'));
  const idx = JSON.parse(files.get('wxfile://usr/mp-fonts-cache/index.json'));
  assert.strictEqual(idx['notosanssc__v37__x.4.woff2'].size, 100);

  // 新实例(模拟下次启动):命中文件,不下载
  const c2 = createFontCache({ wx, baseUrl: 'https://cdn.x.com/f/', download: () => { throw new Error('不应下载'); } });
  const b = await c2.load('notosanssc/v37/x.4.woff2');
  assert.deepStrictEqual(Array.from(b), Array.from(a));
});

test('并发请求同一文件只下载一次', async () => {
  const { wx } = mockWx(new Map());
  let n = 0;
  const c = createFontCache({ wx, baseUrl: 'https://c/', download: () => { n++; return new Promise((r) => setTimeout(() => r({ status: 200, bytes: WOFF2(10) }), 5)); } });
  const [x, y] = await Promise.all([c.load('a.woff2'), c.load('a.woff2')]);
  assert.strictEqual(n, 1);
  assert.strictEqual(x.length, 10); assert.strictEqual(y.length, 10);
});

test('超过容量上限按 LRU 淘汰最久未用的文件,刚写入的不淘汰', async () => {
  const files = new Map();
  const { wx } = mockWx(files);
  let t = 0;
  const c = createFontCache({ wx, baseUrl: 'https://c/', maxBytes: 250, now: () => ++t,
    download: () => Promise.resolve({ status: 200, bytes: WOFF2(100) }) });
  await c.load('a.woff2');
  await c.load('b.woff2');
  await c.load('a.woff2');          // a 变成最近使用
  await c.load('c.woff2');          // 300 > 250 → 淘汰 b
  const idx = c._debugIndex();
  assert.deepStrictEqual(Object.keys(idx).sort(), ['a.woff2', 'c.woff2']);
  assert.ok(!files.has('wxfile://usr/mp-fonts-cache/b.woff2'));
});

test('索引里有、文件被清理了:当未命中重新下载', async () => {
  const files = new Map();
  const { wx } = mockWx(files);
  let n = 0;
  const dl = () => { n++; return Promise.resolve({ status: 200, bytes: WOFF2(10) }); };
  await createFontCache({ wx, baseUrl: 'https://c/', download: dl }).load('a.woff2');
  files.delete('wxfile://usr/mp-fonts-cache/a.woff2');
  await createFontCache({ wx, baseUrl: 'https://c/', download: dl }).load('a.woff2');
  assert.strictEqual(n, 2);
});

test('HTTP 非 200 或内容不是 woff2:reject 并点名 URL,不写缓存', async () => {
  const files = new Map();
  const { wx } = mockWx(files);
  const c404 = createFontCache({ wx, baseUrl: 'https://c/', download: () => Promise.resolve({ status: 404, bytes: new Uint8Array(0) }) });
  await assert.rejects(c404.load('a.woff2'), /https:\/\/c\/a\.woff2.*HTTP 404/);
  const html = createFontCache({ wx, baseUrl: 'https://c/', download: () => Promise.resolve({ status: 200, bytes: new Uint8Array([60, 104, 116, 109]) }) });
  await assert.rejects(html.load('b.woff2'), /不是 woff2/);
  assert.ok(![...files.keys()].some((k) => k.endsWith('.woff2')));
});

test('M10:缓存命中只节流写 index.json(默认最多 2s 一次),不是每次命中都同步写', async () => {
  const files = new Map();
  const { wx } = mockWx(files);
  let t = 0;
  const timers = [];
  const fakeSetTimeout = (fn, ms) => { const id = { fn, ms }; timers.push(id); return id; };
  const fakeClearTimeout = (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); };
  const c = createFontCache({
    wx, baseUrl: 'https://c/', now: () => ++t,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
    download: () => Promise.resolve({ status: 200, bytes: WOFF2(10) }),
  });
  await c.load('a.woff2');   // 下载写入:立即落盘(不节流)
  const writesAfterDownload = files.has('wxfile://usr/mp-fonts-cache/index.json');
  assert.ok(writesAfterDownload);
  const idxBefore = files.get('wxfile://usr/mp-fonts-cache/index.json');

  // 再命中几次:只标记待写,不应该已经又同步写了一遍(内容还是老的 t)
  await c.load('a.woff2');
  await c.load('a.woff2');
  assert.strictEqual(files.get('wxfile://usr/mp-fonts-cache/index.json'), idxBefore, '命中没有立即落盘');
  assert.strictEqual(timers.length, 1, '节流只排一个定时器,不是每次命中都排');

  // 定时器到点才真正落盘,拿到的是最后一次命中的 t
  timers[0].fn();
  const idxAfter = JSON.parse(files.get('wxfile://usr/mp-fonts-cache/index.json'));
  assert.strictEqual(idxAfter['a.woff2'].t, 3);
});

test('M10:flush() 立即把还没落盘的命中写掉', async () => {
  const files = new Map();
  const { wx } = mockWx(files);
  const c = createFontCache({ wx, baseUrl: 'https://c/', download: () => Promise.resolve({ status: 200, bytes: WOFF2(10) }) });
  await c.load('a.woff2');
  await c.load('a.woff2');   // 命中,排上节流定时器,还没落盘
  c.flush();
  const idx = JSON.parse(files.get('wxfile://usr/mp-fonts-cache/index.json'));
  assert.ok(idx['a.woff2']);
});

test('没有文件系统(或写失败)时照样返回字节,只是不缓存', async () => {
  const c = createFontCache({ wx: {}, baseUrl: 'https://c/', download: () => Promise.resolve({ status: 200, bytes: WOFF2(8) }) });
  assert.strictEqual((await c.load('a.woff2')).length, 8);
  const files = new Map();
  const { wx } = mockWx(files);
  wx.getFileSystemManager().writeFileSync = () => { throw new Error('writeFile:fail the maximum size of the file storage limit is exceeded'); };
  const quiet = console.warn; console.warn = () => {};
  try {
    const c2 = createFontCache({ wx, baseUrl: 'https://c/', download: () => Promise.resolve({ status: 200, bytes: WOFF2(8) }) });
    assert.strictEqual((await c2.load('a.woff2')).length, 8);
  } finally { console.warn = quiet; }
});

test('net:远端字体表里的 mp-fonts/ 请求走 baseUrl 下载(同一 wx.request 队列),包内资源优先', async () => {
  const seen = [];
  const c = createMpContext({ net: (req) => { seen.push(req.url); return { statusCode: 200, data: Buffer.from(WOFF2(20)) }; } });
  const net = c.requireModule(path.join(RT, 'net.js'));
  const boot = c.requireModule(path.join(RT, 'boot.js'));
  const assets = { 'mp-fonts/roboto/v32/R.woff2': () => Promise.resolve([Buffer.from(WOFF2(4)).toString('base64')]) };
  const n = net.createNet({ wx: c.wx, assets, matchAsset: boot.matchAsset, decodeParts: boot.decodeParts,
    remoteFonts: { baseUrl: 'https://cdn.x.com/fonts/', files: { 'mp-fonts/notosanssc/v37/s.4.woff2': 1 } } });
  const fetch = net.makeFetch(n);
  const r = await fetch('mp-fonts/notosanssc/v37/s.4.woff2');
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.arrayBuffer()).byteLength, 20);
  assert.deepStrictEqual(seen, ['https://cdn.x.com/fonts/notosanssc/v37/s.4.woff2']);
  // 带垫片 origin 的绝对 URL 同样命中
  await fetch('https://mp.local/mp-fonts/notosanssc/v37/s.4.woff2');
  // 包内的 Roboto 不走网络
  const rb = await fetch('mp-fonts/roboto/v32/R.woff2');
  assert.strictEqual((await rb.arrayBuffer()).byteLength, 4);
  assert.strictEqual(seen.length, 2);
  // 两边都没有:404
  assert.strictEqual((await fetch('mp-fonts/notosansjp/x.woff2')).status, 404);
});

test('net:远端字体下载失败时 reject 并点名资源,不伪装成 404', async () => {
  const c = createMpContext({ net: () => ({ statusCode: 500, data: Buffer.alloc(0) }) });
  const net = c.requireModule(path.join(RT, 'net.js'));
  const boot = c.requireModule(path.join(RT, 'boot.js'));
  const n = net.createNet({ wx: c.wx, assets: {}, matchAsset: boot.matchAsset, decodeParts: boot.decodeParts,
    remoteFonts: { baseUrl: 'https://cdn/', files: { 'mp-fonts/a.woff2': 1 } } });
  await assert.rejects(net.makeFetch(n)('mp-fonts/a.woff2'), /远端字体 mp-fonts\/a\.woff2 加载失败.*HTTP 500/);
});
