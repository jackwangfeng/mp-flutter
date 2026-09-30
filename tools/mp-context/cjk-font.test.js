const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { preloadCjkFont, createCjkBold } = require(path.resolve(__dirname, '../../packages/mp_flutter/runtime/cjk-font.js'));

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

// ── 粗体(cjk_font_bold)──
function fakeWx(delays) {
  return { getFileSystemManager: () => ({ readCompressedFile(o) {
    const d = delays[o.filePath];
    if (d == null) { setTimeout(() => o.fail({ errMsg: 'denied' }), 1); return; }
    setTimeout(() => o.success({ data: new Uint8Array([o.filePath.length]).buffer }), d);
  } }) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOLD = { key: 'assets/mp-cjk/NotoSansSC-Bold.ttf', family: 'MpNotoSansSC', file: '/pkg-cjkb/b.br', load: () => Promise.resolve() };

test('粗体不晚于常规字体:随清单一起交给引擎(served),不走补注册', async () => {
  const wx = fakeWx({ '/pkg-cjk/r.br': 20, '/pkg-cjkb/b.br': 1 });
  const regular = preloadCjkFont({ file: '/pkg-cjk/r.br', load: () => Promise.resolve() }, { wx, warn: () => {} });
  const lines = [];
  const bold = createCjkBold(BOLD, regular, { wx, warn: () => {}, perfLog: (l) => lines.push(l) });
  const got = await bold.respond();
  assert.ok(got instanceof Uint8Array);
  assert.strictEqual(bold.state.status, 'served');
  let called = 0;
  bold.bridge.listen(() => { called++; });
  await sleep(5);
  assert.strictEqual(called, 0);
  assert.ok(lines.some((l) => /cjk-bold 随常规字体注册/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^\[mp-perf\] cjk-bold read /.test(l)), lines.join('\n'));
});

test('粗体晚于常规字体:先 404(首帧不等),到了再交给 listen(先 listen 后到 / 先到后 listen 都行)', async () => {
  for (const listenFirst of [true, false]) {
    const wx = fakeWx({ '/pkg-cjk/r.br': 1, '/pkg-cjkb/b.br': 30 });
    const regular = preloadCjkFont({ file: '/pkg-cjk/r.br', load: () => Promise.resolve() }, { wx, warn: () => {} });
    const bold = createCjkBold(BOLD, regular, { wx, warn: () => {} });
    await regular;
    assert.strictEqual(await bold.respond(), null);
    assert.strictEqual(bold.state.status, 'late');
    const calls = [];
    const fn = (b, fam) => calls.push([b.length, fam]);
    if (listenFirst) bold.bridge.listen(fn);
    await sleep(40);
    if (!listenFirst) { assert.strictEqual(calls.length, 0); bold.bridge.listen(fn); }
    assert.deepStrictEqual(calls, [[1, 'MpNotoSansSC']]);
    assert.strictEqual(bold.state.status, 'late-loaded');
    bold.bridge.listen(fn);   // 只交一次
    assert.strictEqual(calls.length, 1);
  }
});

test('常规字体读取失败:粗体也不注册(家族里只剩粗体会让常规文字也用它);粗体读取失败按 404', async () => {
  let wx = fakeWx({ '/pkg-cjkb/b.br': 1 });
  let regular = preloadCjkFont({ file: '/pkg-cjk/r.br', load: () => Promise.resolve() }, { wx, warn: () => {} });
  let bold = createCjkBold(BOLD, regular, { wx, warn: () => {} });
  let calls = 0;
  bold.bridge.listen(() => { calls++; });
  assert.strictEqual(await bold.respond(), null);
  assert.strictEqual(bold.state.status, 'skipped');
  await sleep(5);
  assert.strictEqual(calls, 0);

  const warns = [];
  wx = fakeWx({ '/pkg-cjk/r.br': 1 });
  regular = preloadCjkFont({ file: '/pkg-cjk/r.br', load: () => Promise.resolve() }, { wx, warn: () => {} });
  bold = createCjkBold(BOLD, regular, { wx, warn: (m) => warns.push(m) });
  await sleep(10);
  assert.strictEqual(await bold.respond(), null);
  assert.strictEqual(bold.state.status, 'failed');
  assert.match(warns[0], /粗体读取失败.*合成加粗/);
});

test('startAfter:闸门定下来(resolve 或 reject)之前不请求分包;onIssue/onReady 各报一次', async () => {
  for (const fail of [false, true]) {
    const order = [];
    let open, shut;
    const gate = new Promise((r, j) => { open = r; shut = j; });
    const wx = { getFileSystemManager: () => ({ readCompressedFile(o) { o.success({ data: new Uint8Array([5]).buffer }); } }) };
    const p = preloadCjkFont({ file: '/pkg-cjkb/f.br', load: () => { order.push('load'); return Promise.resolve(); } },
      { wx, warn: () => {}, startAfter: gate, onIssue: () => order.push('issue'), onReady: () => order.push('ready') });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepStrictEqual(order, []);
    if (fail) shut(new Error('x')); else open();
    assert.deepStrictEqual(Array.from(await p), [5]);
    assert.deepStrictEqual(order, ['issue', 'load', 'ready']);
  }
});

test('createCjkBold whenIdle:字节与监听都就位后经 whenIdle 补交,只排一次', async () => {
  const idle = [];
  const regular = Promise.resolve(new Uint8Array([1]));
  const wx = { getFileSystemManager: () => ({ readCompressedFile(o) { setTimeout(() => o.success({ data: new Uint8Array([7]).buffer }), 5); } }) };
  const b = createCjkBold({ family: 'F', file: '/pkg-cjkb/f.br', load: () => Promise.resolve() }, regular,
    { wx, warn: () => {}, whenIdle: (fn) => idle.push(fn) });
  assert.strictEqual(await b.respond(), null, '粗体晚于常规:404');
  const got = [];
  b.bridge.listen((bytes, fam) => got.push([Array.from(bytes), fam]));
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(idle.length, 1);
  b.bridge.listen((bytes, fam) => got.push([Array.from(bytes), fam]));   // 重复 listen 不重复排
  assert.strictEqual(idle.length, 1);
  assert.deepStrictEqual(got, []);
  idle[0]();
  assert.deepStrictEqual(got, [[[7], 'F']]);
  assert.strictEqual(b.state.status, 'late-loaded');
});
