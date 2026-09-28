const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');
const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

function setup(netHandler, extraAssets) {
  const c = createMpContext({ net: netHandler });
  const net = c.requireModule(path.join(RT, 'net.js'));
  const boot = c.requireModule(path.join(RT, 'boot.js'));
  const assets = Object.assign(
    { 'assets/a.txt': () => Promise.resolve([Buffer.from('资源').toString('base64')]) },
    extraAssets || {});
  const n = net.createNet({ wx: c.wx, assets, matchAsset: boot.matchAsset, decodeParts: boot.decodeParts });
  return { c, net, n, fetch: net.makeFetch(n) };
}

test('绝对 URL 走 wx.request:方法、头、体、响应头小写、字节拷贝到本 realm', async () => {
  let seen;
  const { fetch, c } = setup((req) => { seen = req; return { statusCode: 201, header: { 'Content-Type': 'application/json', 'X-Id': '7' }, data: Buffer.from('{"ok":1}') }; });
  const body = new Uint8Array([123, 34, 97, 34, 58, 49, 125]);   // {"a":1}
  const resp = await fetch('https://api.example.com/x?q=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.strictEqual(seen.method, 'POST');
  assert.strictEqual(seen.url, 'https://api.example.com/x?q=1');
  assert.strictEqual(seen.header['Content-Type'], 'application/json');
  assert.strictEqual(Buffer.from(new Uint8Array(seen.data)).toString(), '{"a":1}');
  assert.strictEqual(seen.responseType, 'arraybuffer');
  assert.strictEqual(resp.status, 201);
  assert.strictEqual(resp.ok, true);
  assert.strictEqual(resp.headers.get('x-id'), '7');
  const names = []; resp.headers.forEach((v, k) => names.push(k + '=' + v));
  assert.deepStrictEqual(names.sort(), ['content-type=application/json', 'x-id=7']);
  const ab = await resp.arrayBuffer();
  assert.strictEqual(Object.isFrozen(Object.getPrototypeOf(ab)), false, '必须拷贝进本 realm');
});

test('GET 不传 data(wx 会把它拼进查询串)', async () => {
  let seen;
  const { fetch } = setup((req) => { seen = req; return { statusCode: 200, data: Buffer.alloc(0) }; });
  await fetch('https://a.com/g', { method: 'GET', body: 'x' });
  assert.strictEqual(seen.data, undefined);
});

test('中文 emoji 往返:text()/json() 用 UTF-8', async () => {
  const { fetch } = setup(() => ({ statusCode: 200, data: Buffer.from('{"s":"世界😀"}') }));
  const r = await fetch('https://a.com/j', {});
  assert.deepStrictEqual(await r.json(), { s: '世界😀' });
});

test('二进制不被改写:流式 body 读出原始字节', async () => {
  const bytes = Buffer.from([0, 255, 128, 10, 13, 0x89, 0x50, 0x4e, 0x47]);
  const { fetch } = setup(() => ({ statusCode: 200, data: bytes }));
  const r = await fetch('https://a.com/b.png', {});
  const reader = r.body.getReader();
  const got = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; got.push(...value); }
  assert.deepStrictEqual(got, [...bytes]);
});

test('404 是正常响应(ok=false),不是异常', async () => {
  const { fetch } = setup(() => ({ statusCode: 404, data: Buffer.from('nope') }));
  const r = await fetch('https://a.com/missing', {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(await r.text(), 'nope');
});

test('连不上:reject TypeError,消息含方法、URL 与 errMsg', async () => {
  const { fetch } = setup(() => ({ fail: 'request:fail url not in domain list' }));
  await assert.rejects(fetch('https://bad.com/x', { method: 'PUT' }),
    (e) => e instanceof TypeError && /PUT https:\/\/bad\.com\/x/.test(e.message) && /domain list/.test(e.message));
});

test('AbortController:中途 abort 结束 wx 请求并以 AbortError 拒绝', async () => {
  const { fetch, c, net } = setup(() => new Promise(() => {}));   // 永不返回
  const ac = new net.AbortController();
  const p = fetch('https://a.com/slow', { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.ok(ac.signal.aborted);
});

test('signal 已中止:不发请求直接拒绝', async () => {
  let called = false;
  const { fetch, net } = setup(() => { called = true; return { statusCode: 200, data: Buffer.alloc(0) }; });
  const ac = new net.AbortController(); ac.abort();
  await assert.rejects(fetch('https://a.com/x', { signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.strictEqual(called, false);
});

test('相对路径走资源,不发 wx.request', async () => {
  let called = false;
  const { fetch } = setup(() => { called = true; return { statusCode: 200, data: Buffer.alloc(0) }; });
  const r = await fetch('assets/a.txt');
  assert.strictEqual(await r.text(), '资源');
  const miss = await fetch('assets/none.txt');
  assert.strictEqual(miss.status, 404);
  assert.strictEqual(called, false);
});

test('FormData/Blob 请求体显式报错', async () => {
  const { fetch } = setup(() => ({ statusCode: 200, data: Buffer.alloc(0) }));
  class FormData {}
  await assert.rejects(fetch('https://a.com/u', { method: 'POST', body: new FormData() }), /暂不支持 FormData\/Blob/);
});

test('Headers:大小写不敏感、append 合并、可迭代', () => {
  const { net } = setup(() => ({}));
  const h = new net.Headers({ 'X-A': '1' });
  h.append('x-a', '2');
  h.set('Y', 'z');
  assert.strictEqual(h.get('X-a'), '1, 2');
  assert.deepStrictEqual([...h].map(([k]) => k).sort(), ['x-a', 'y']);
  h.delete('Y');
  assert.strictEqual(h.has('y'), false);
});

test('引擎内部 fetch(url) 不带 init 也能工作(字体等)', async () => {
  const { fetch } = setup(() => ({ statusCode: 200, data: Buffer.from('font') }));
  const r = await fetch('https://fonts.example.com/x.woff2');
  assert.strictEqual(r.status, 200);
});

test('同一 AbortSignal 复用于多个请求:请求结束后必须摘除监听器,不能累积(修复轮 1 Important 2)', async () => {
  const { fetch, net } = setup(() => ({ statusCode: 200, data: Buffer.alloc(0) }));
  const ac = new net.AbortController();
  await fetch('https://a.com/1', { signal: ac.signal });
  await fetch('https://a.com/2', { signal: ac.signal });
  assert.strictEqual(ac.signal._l.length, 0, '每次请求落地都应摘除自己挂的 abort 监听器');
});

// —— 终审修复(final-fix)Important 1:绝对 URL 按后缀命中打包资源,不发网络请求 ——

test('绝对 CDN URL 即使后缀与打包资源同名,也必须走 wx.request(fetch 路径)', async () => {
  let called = false;
  const { fetch } = setup((req) => {
    called = true;
    assert.strictEqual(req.url, 'https://cdn.example.com/shop/assets/images/banner.png');
    return { statusCode: 200, data: Buffer.from('来自远端') };
  }, { 'assets/images/banner.png': () => Promise.resolve([Buffer.from('打包资源').toString('base64')]) });
  const r = await fetch('https://cdn.example.com/shop/assets/images/banner.png');
  assert.strictEqual(called, true, '不能被本地资源命中拦截,必须真的发请求');
  assert.strictEqual(await r.text(), '来自远端');
});

test('垫片自身 origin(https://mp.local)下的绝对 URL:命中资源不发 wx.request,未命中直接 404 也不发 wx.request', async () => {
  let called = false;
  const { fetch } = setup(() => { called = true; return { statusCode: 200, data: Buffer.alloc(0) }; });
  const hit = await fetch('https://mp.local/assets/a.txt');
  assert.strictEqual(await hit.text(), '资源');
  const miss = await fetch('https://mp.local/none');
  assert.strictEqual(miss.status, 404);
  assert.strictEqual(called, false, 'mp.local 是垫片自身 origin,未命中不应回退到 wx.request(真机会报非法域名)');
});

// —— 终审修复 Important 2:wx.request 最多 10 个并发 ——

test('wx.request 同时在途最多 10 个,超出排队;25 个并发请求全部完成且峰值不超过 10', async () => {
  let inFlight = 0, peak = 0, total = 0;
  const { fetch } = setup(() => {
    inFlight++; total++; peak = Math.max(peak, inFlight);
    return new Promise((resolve) => {
      setTimeout(() => { inFlight--; resolve({ statusCode: 200, data: Buffer.alloc(0) }); }, 5);
    });
  });
  const N = 25;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => fetch('https://a.com/' + i)));
  assert.strictEqual(total, N, '全部 25 个请求最终都要发出并完成');
  assert.ok(results.every((r) => r.status === 200));
  assert.strictEqual(peak, 10, '同时在途请求数应被限制在 10(峰值应恰好打满到 10)');
});

test('排队中的请求被 abort:不占槽、不调用 wx.request,直接以 AbortError 拒绝', async () => {
  // 注意:context.js 的 wx.request 桩里,真正调用 opts.net(req) 前先过一个
  // Promise.resolve().then(...)(模拟异步基础库),不能靠它计次;wx.request 本身
  // 是否被调用(同步)要看 c.calls 里记录的 'wx.request' 项。
  const { fetch, net, c } = setup(() => new Promise(() => {}));   // 占住槽位,永不返回
  const wxCalls = () => c.calls.filter((x) => x.name === 'wx.request').length;
  const holding = Array.from({ length: 10 }, (_, i) => fetch('https://a.com/hold' + i));
  assert.strictEqual(wxCalls(), 10, '前 10 个请求应立即占满槽位并调用 wx.request');
  const ac = new net.AbortController();
  const p = fetch('https://a.com/queued', { signal: ac.signal });
  await Promise.resolve();
  assert.strictEqual(wxCalls(), 10, '第 11 个请求应在队列中等待,不应调用 wx.request');
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.strictEqual(wxCalls(), 10, '排队中被 abort 的请求出队时也不应调用 wx.request');
  void holding;   // 占槽的 10 个请求本测试无需等待其结束
});

// —— 终审修复 M-a:fetch 的 abort 不能完全依赖 wx 回调 fail('abort') ——

test('M-a:桩在 abort 后不回调 fail,fetch 仍必须以 AbortError 结束(不能悬空等待)', async () => {
  const netMod = require(path.join(RT, 'net.js'));
  const fakeWx = { request() { return { abort() { /* 真机偶发:不触发 success/fail */ } }; } };
  const n = netMod.createNet({ wx: fakeWx, assets: {}, matchAsset: () => null, decodeParts: () => new Uint8Array(0) });
  const ac = new netMod.AbortController();
  const p = n.route({ method: 'GET', url: 'https://a.com/slow', signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
});

// ── 回退字体合并窗口(fontSettleMs)──
function fakeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await new Promise((r) => setImmediate(r));
        timers.sort((a, b) => a.at - b.at);
        const h = timers[0];
        if (!h || h.at > end) break;
        timers.shift();
        t = h.at;
        h.fn();
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

test('回退字体分片:同一阵的响应等最后一次请求后 100ms 且全部落地才一起交出;Roboto 与普通资源不等', async () => {
  const clk = fakeClock();
  const c = createMpContext({ net: () => ({ statusCode: 200, data: Buffer.alloc(0) }) });
  const net = c.requireModule(path.join(RT, 'net.js'));
  const boot = c.requireModule(path.join(RT, 'boot.js'));
  const later = (ms) => () => new Promise((r) => clk.setTimeout(() => r(['AAAA']), ms));
  const assets = {
    'mp-fonts/notosanssc/v37/x.1.woff2': later(10),
    'mp-fonts/notosanssc/v37/x.2.woff2': later(10),
    'mp-fonts/notosanssc/v37/x.3.woff2': later(10),
    'mp-fonts/roboto/v32/R.woff2': later(10),
    'assets/a.png': later(10),
  };
  const n = net.createNet({ wx: c.wx, assets, matchAsset: boot.matchAsset, decodeParts: boot.decodeParts,
    now: clk.now, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  const fetch = net.makeFetch(n);
  const done = [];
  const go = (u) => fetch(u).then(() => done.push(u.split('/').pop() + '@' + clk.now()));
  go('mp-fonts/notosanssc/v37/x.1.woff2');
  go('mp-fonts/roboto/v32/R.woff2');
  go('assets/a.png');
  await clk.advance(50);
  go('mp-fonts/notosanssc/v37/x.2.woff2');      // 窗口内又来一个:并进同一阵
  await clk.advance(200);
  go('mp-fonts/notosanssc/v37/x.3.woff2');      // 上一阵已交出:新的一阵
  await clk.advance(200);
  assert.deepStrictEqual(done, ['R.woff2@10', 'a.png@10', 'x.1.woff2@150', 'x.2.woff2@150', 'x.3.woff2@350']);
});

test('回退字体合并窗口:请求源源不断时最多压 1000ms;fontSettleMs: 0 关闭', async () => {
  const clk = fakeClock();
  const gate = require(path.join(RT, 'net.js')).createFontGate({ settleMs: 100, maxMs: 1000,
    now: clk.now, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  const out = [];
  for (let i = 0; i < 20; i++) {
    gate.track(new Promise((r) => clk.setTimeout(() => r(i), 5))).then((v) => out.push(v + '@' + clk.now()));
    await clk.advance(80);
  }
  await clk.advance(300);
  assert.ok(out[0].endsWith('@1000'), out[0]);
  assert.strictEqual(out.length, 20);

  const c = createMpContext({ net: () => ({}) });
  const net = c.requireModule(path.join(RT, 'net.js'));
  const boot = c.requireModule(path.join(RT, 'boot.js'));
  const n = net.createNet({ wx: c.wx, fontSettleMs: 0, matchAsset: boot.matchAsset, decodeParts: boot.decodeParts,
    assets: { 'mp-fonts/n/v1/a.woff2': () => Promise.resolve(['AAAA']) } });
  const t0 = Date.now();
  await net.makeFetch(n)('mp-fonts/n/v1/a.woff2');
  assert.ok(Date.now() - t0 < 50);
});
