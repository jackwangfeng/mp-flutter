const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');
const { createMpContext } = require('./context');

function setup(wxOverrides) {
  const c = createMpContext();
  Object.assign(c.wx, wxOverrides || {});
  const { createWechatBridge } = c.requireModule(path.join(RT, 'wechat.js'));
  return { c, b: createWechatBridge({ wx: c.wx }) };
}

test('login:success 参数以 JSON 返回', async () => {
  const { b } = setup({ login: (o) => setTimeout(() => o.success({ code: 'abc', errMsg: 'login:ok' }), 0) });
  assert.deepStrictEqual(JSON.parse(await b.call('login', '{}')), { code: 'abc', errMsg: 'login:ok' });
});

test('参数 JSON 原样传给 wx(中文、嵌套、字符串 timeStamp)', async () => {
  let seen;
  const { b } = setup({ requestPayment: (o) => { seen = o; o.success({ errMsg: 'requestPayment:ok' }); } });
  await b.call('requestPayment', JSON.stringify({ timeStamp: '1700000000', nonceStr: '随机', package: 'prepay_id=x', signType: 'RSA', paySign: 's', ext: { a: [1] } }));
  assert.strictEqual(seen.timeStamp, '1700000000');
  assert.strictEqual(typeof seen.timeStamp, 'string');
  assert.strictEqual(seen.nonceStr, '随机');
  assert.deepStrictEqual(seen.ext, { a: [1] });
});

test('用户取消:reject 且 mpCancelled=true,message 含 api 与 errMsg', async () => {
  const { b } = setup({ requestPayment: (o) => o.fail({ errMsg: 'requestPayment:fail cancel' }) });
  await assert.rejects(b.call('requestPayment', '{}'),
    (e) => e.mpCancelled === true && e.mpApi === 'requestPayment' && /requestPayment: requestPayment:fail cancel/.test(e.message));
});

test('普通失败:mpCancelled=false', async () => {
  const { b } = setup({ requestPayment: (o) => o.fail({ errMsg: 'requestPayment:fail invalid params' }) });
  await assert.rejects(b.call('requestPayment', '{}'), (e) => e.mpCancelled === false && /invalid params/.test(e.mpErrMsg));
});

test('接口不存在:立即 reject,不挂起', async () => {
  const { b } = setup();
  await assert.rejects(b.call('noSuchApi', '{}'), /noSuchApi: 当前基础库不支持该接口/);
});

test('非回调式接口(同步/事件订阅/工厂/Manager)立即 reject,不挂起', async () => {
  const { b } = setup();
  await assert.rejects(b.call('getSystemInfoSync', '{}'), /仅支持 success\/fail 回调式异步接口/);
  await assert.rejects(b.call('toString', '{}'), /仅支持 success\/fail 回调式异步接口/);
  await assert.rejects(b.call('onNetworkStatusChange', '{}'), /仅支持 success\/fail 回调式异步接口/);
});

test('参数不是合法 JSON 对象:立即 reject', async () => {
  const { b } = setup({ login: (o) => o.success({}) });
  await assert.rejects(b.call('login', '[1,2]'), /参数必须是 JSON 对象/);
  await assert.rejects(b.call('login', '{bad'), /参数必须是 JSON 对象/);
});

test('wx 接口同步抛错:转成 reject', async () => {
  const { b } = setup({ scanCode: () => { throw new Error('boom'); } });
  await assert.rejects(b.call('scanCode', '{}'), /scanCode: boom/);
});

test('不接受 success/fail/complete 由调用方注入(防止覆盖回调)', async () => {
  let called = 0;
  const { b } = setup({ login: (o) => { called++; o.success({ code: 'x' }); } });
  await b.call('login', JSON.stringify({ success: 1, fail: 2 }));
  assert.strictEqual(called, 1);
});

test('分享信息:path 必须以 / 开头;getShareInfo 返回已设置的字段', () => {
  const { b } = setup();
  assert.strictEqual(b.getShareInfo(), null);
  assert.throws(() => b.setShareInfo(JSON.stringify({ path: 'pages/x' })), /必须以 \/ 开头/);
  b.setShareInfo(JSON.stringify({ title: '限时特惠', path: '/pages/flutter/flutter?sku=1' }));
  assert.deepStrictEqual(b.getShareInfo(), { title: '限时特惠', path: '/pages/flutter/flutter?sku=1' });
});

test('menuButtonRect:同步取 wx.getMenuButtonBoundingClientRect,返回 JSON', () => {
  const { b } = setup({ getMenuButtonBoundingClientRect: () => ({ left: 281, top: 51, right: 368, bottom: 83, width: 87, height: 32 }) });
  assert.deepStrictEqual(JSON.parse(b.menuButtonRect()), { left: 281, top: 51, right: 368, bottom: 83, width: 87, height: 32 });
});

test('menuButtonRect:接口缺失/抛错/字段不全时返回 null,不抛', () => {
  assert.strictEqual(setup({ getMenuButtonBoundingClientRect: undefined }).b.menuButtonRect(), null);
  assert.strictEqual(setup({ getMenuButtonBoundingClientRect: () => { throw new Error('x'); } }).b.menuButtonRect(), null);
  assert.strictEqual(setup({ getMenuButtonBoundingClientRect: () => ({ left: 1 }) }).b.menuButtonRect(), null);
});
