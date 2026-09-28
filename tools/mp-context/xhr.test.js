const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');
const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

function setup(netHandler, extraAssets) {
  const c = createMpContext({ net: netHandler });
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({ canvas: c.canvas, width: 390, height: 844, dpr: 3 });
  const netMod = c.requireModule(path.join(RT, 'net.js'));
  const boot = c.requireModule(path.join(RT, 'boot.js'));
  const assets = Object.assign(
    { 'assets/i.png': () => Promise.resolve([Buffer.from([1, 2, 3]).toString('base64')]) },
    extraAssets || {});
  const net = netMod.createNet({ wx: c.wx, assets, matchAsset: boot.matchAsset, decodeParts: boot.decodeParts });
  const { createXMLHttpRequestClass } = c.requireModule(path.join(RT, 'xhr.js'));
  const XHR = createXMLHttpRequestClass({ getNet: () => net, Event: shim.window.Event, ProgressEvent: shim.window.ProgressEvent });
  return { XHR, shim };
}

function run(xhr, body) {
  return new Promise((resolve) => {
    const events = [];
    ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'timeout', 'abort', 'loadend'].forEach((t) =>
      xhr.addEventListener(t, () => { events.push(t === 'readystatechange' ? 'rs' + xhr.readyState : t); if (t === 'loadend') resolve(events); }));
    xhr.send(body);
  });
}

test('NetworkImage 形态:GET + arraybuffer,load 后 response 是本 realm ArrayBuffer', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
  const { XHR } = setup(() => ({ statusCode: 200, header: { 'Content-Type': 'image/png' }, data: png }));
  const x = new XHR();
  x.open('GET', 'https://cdn.example.com/a.png', true);
  x.responseType = 'arraybuffer';
  const ev = await run(x);
  assert.deepStrictEqual(ev, ['loadstart', 'rs2', 'rs3', 'progress', 'rs4', 'load', 'loadend']);
  assert.strictEqual(x.status, 200);
  assert.deepStrictEqual([...new Uint8Array(x.response)], [...png]);
  assert.strictEqual(Object.isFrozen(Object.getPrototypeOf(x.response)), false);
  assert.strictEqual(x.getResponseHeader('CONTENT-TYPE'), 'image/png');
});

test('dio 形态:POST 字节体、自定义头、getAllResponseHeaders 格式、readyState 常量', async () => {
  let seen;
  const { XHR } = setup((req) => { seen = req; return { statusCode: 200, header: { 'X-A': '1', 'Content-Type': 'text/plain' }, data: Buffer.from('ok') }; });
  const x = new XHR();
  assert.strictEqual(XHR.HEADERS_RECEIVED, 2);
  assert.strictEqual(x.DONE, 4);
  x.open('POST', 'https://api.example.com/p');
  x.setRequestHeader('Authorization', 'Bearer t');
  x.responseType = 'arraybuffer';
  await run(x, new Uint8Array([104, 105]));
  assert.strictEqual(seen.header.Authorization, 'Bearer t');
  assert.strictEqual(Buffer.from(new Uint8Array(seen.data)).toString(), 'hi');
  assert.strictEqual(x.getAllResponseHeaders(), 'content-type: text/plain\r\nx-a: 1\r\n');
});

test('responseType 默认/text:responseText 为 UTF-8 解码;json 解析', async () => {
  const { XHR } = setup(() => ({ statusCode: 200, data: Buffer.from('{"s":"世界😀"}') }));
  const a = new XHR(); a.open('GET', 'https://a.com/j'); await run(a);
  assert.strictEqual(a.responseText, '{"s":"世界😀"}');
  const b = new XHR(); b.open('GET', 'https://a.com/j'); b.responseType = 'json'; await run(b);
  assert.deepStrictEqual(b.response, { s: '世界😀' });
});

test('404 走 load(不是 error)', async () => {
  const { XHR } = setup(() => ({ statusCode: 404, data: Buffer.from('x') }));
  const x = new XHR(); x.open('GET', 'https://a.com/404');
  const ev = await run(x);
  assert.ok(ev.includes('load') && !ev.includes('error'));
  assert.strictEqual(x.status, 404);
});

test('网络失败:error + loadend,status 为 0', async () => {
  const { XHR } = setup(() => ({ fail: 'request:fail' }));
  const x = new XHR(); x.open('GET', 'https://a.com/x');
  const ev = await run(x);
  assert.deepStrictEqual(ev.slice(-3), ['rs4', 'error', 'loadend']);
  assert.strictEqual(x.status, 0);
});

test('超时:timeout 事件,并把 timeout 传给 wx.request', async () => {
  let seen;
  const { XHR } = setup((req) => { seen = req; return { fail: 'request:fail timeout' }; });
  const x = new XHR(); x.open('GET', 'https://a.com/slow'); x.timeout = 1500;
  const ev = await run(x);
  assert.strictEqual(seen.timeout, 1500);
  assert.ok(ev.includes('timeout') && !ev.includes('error'));
});

test('abort:结束底层请求,派发 abort + loadend,不再派发 load', async () => {
  const { XHR } = setup(() => new Promise(() => {}));
  const x = new XHR(); x.open('GET', 'https://a.com/slow');
  const p = run(x);
  x.abort();
  const ev = await p;
  assert.ok(ev.includes('abort') && !ev.includes('load'));
  assert.strictEqual(x.readyState, 4);
});

test('相对 URL 走资源(Image.network("assets/i.png"))', async () => {
  const { XHR } = setup(() => { throw new Error('不应发网络请求'); });
  const x = new XHR(); x.open('GET', 'assets/i.png'); x.responseType = 'arraybuffer';
  await run(x);
  assert.deepStrictEqual([...new Uint8Array(x.response)], [1, 2, 3]);
});

test('同步 open 与 blob responseType 显式报错', async () => {
  const { XHR } = setup(() => ({ statusCode: 200, data: Buffer.alloc(0) }));
  assert.throws(() => new XHR().open('GET', 'https://a.com', false), /同步/);
  const x = new XHR(); x.open('GET', 'https://a.com'); x.responseType = 'blob';
  assert.throws(() => x.send(), /blob/);
});

test('onload 等属性式监听与 upload.addEventListener 可用', async () => {
  const { XHR } = setup(() => ({ statusCode: 200, data: Buffer.from('ok') }));
  const x = new XHR(); x.open('POST', 'https://a.com/u');
  let onload = 0, up = 0;
  x.onload = () => { onload++; };
  x.upload.addEventListener('load', () => { up++; });
  await run(x, 'body');
  assert.strictEqual(onload, 1);
  assert.strictEqual(up, 1);
});

// —— 终审修复(final-fix)Important 1:绝对 URL 按后缀命中打包资源,不发网络请求 ——

test('绝对 CDN URL 即使后缀与打包资源同名,也必须走 wx.request,不能误命中资源', async () => {
  let called = false;
  const { XHR } = setup((req) => {
    called = true;
    assert.strictEqual(req.url, 'https://cdn.example.com/shop/assets/images/banner.png');
    return { statusCode: 200, header: { 'Content-Type': 'image/png' }, data: Buffer.from([9, 9, 9]) };
  }, { 'assets/images/banner.png': () => Promise.resolve([Buffer.from([1, 2, 3]).toString('base64')]) });
  const x = new XHR(); x.open('GET', 'https://cdn.example.com/shop/assets/images/banner.png');
  x.responseType = 'arraybuffer';
  await run(x);
  assert.strictEqual(called, true, '同名后缀的绝对 CDN URL 必须真的发 wx.request');
  assert.deepStrictEqual([...new Uint8Array(x.response)], [9, 9, 9], '响应必须来自 wx.request,不是打包资源');
});

test('垫片自身 origin(https://mp.local)下的绝对 URL 按资源匹配,命中不发 wx.request', async () => {
  const { XHR } = setup(() => { throw new Error('不应发网络请求'); });
  const x = new XHR(); x.open('GET', 'https://mp.local/assets/i.png');
  x.responseType = 'arraybuffer';
  await run(x);
  assert.deepStrictEqual([...new Uint8Array(x.response)], [1, 2, 3]);
});

test('垫片自身 origin 下未命中资源:直接 404,不调用 wx.request', async () => {
  let called = false;
  const { XHR } = setup(() => { called = true; return { statusCode: 200, data: Buffer.alloc(0) }; });
  const x = new XHR(); x.open('GET', 'https://mp.local/assets/none.png');
  await run(x);
  assert.strictEqual(x.status, 404);
  assert.strictEqual(called, false, '垫片自身 origin 下未命中资源不应回退到 wx.request(真机会报非法域名)');
});

// —— 终审修复 M-b:arraybuffer 大响应不做多余拷贝 ——

test('arraybuffer 响应:r.bytes 独占整块 buffer 时直接复用,不 slice(内容仍正确)', async () => {
  const payload = Buffer.from([1, 2, 3, 4, 5, 250, 251, 252]);
  const { XHR } = setup(() => ({ statusCode: 200, data: payload }));
  const x = new XHR(); x.open('GET', 'https://a.com/bin'); x.responseType = 'arraybuffer';
  await run(x);
  assert.deepStrictEqual([...new Uint8Array(x.response)], [...payload]);
  assert.strictEqual(x.response.byteLength, payload.length);
  assert.strictEqual(x._bytes, null, 'arraybuffer 模式不需要 responseText,不应保留 _bytes');
});

// —— 终审修复 M-d:重复 open() 必须重置 _resHeaders ——

test('同一个 XHR 实例重复 open():上一次的响应头不能残留', async () => {
  const { XHR } = setup(() => ({ statusCode: 200, header: { 'X-A': '1' }, data: Buffer.from('x') }));
  const x = new XHR();
  x.open('GET', 'https://a.com/1');
  await run(x);
  assert.strictEqual(x.getResponseHeader('X-A'), '1');
  x.open('GET', 'https://a.com/2');
  assert.strictEqual(x.getResponseHeader('X-A'), null, 'open() 之后、下一次 send() 落地之前,上次的响应头必须已清空');
});
