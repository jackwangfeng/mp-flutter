'use strict';
/**
 * Phase 4 微信能力验收:
 *   node accept-wx.js <产物目录>
 *
 * 一键跑法见 tools/e2e/run.sh,例如 `tools/e2e/run.sh stable accept-wx.js`。
 *
 * 产物须由验收工程 tools/e2e/apps/mpf_wx(附录 A)以 --verify 构建。App 用
 * print 输出
 * `STATE|...` 行,经 --verify 缓冲(getApp().__mpVerify)回到这里 —— 只认本次
 * App 实例的缓冲(r.states),不看 console 通道(见 drive.js)。
 *
 * 覆盖:登录(code→假后端 openid)、checkSession、支付(故意无效签名的失败
 * 路径,验证可诊断不挂起)、剪贴板往返、分享(默认 + 设置后)。
 */
const path = require('path');
const { runE2E } = require('./drive');
const { startServer } = require('./test-server');

const dir = process.argv[2];
if (!dir) { console.error('用法: node accept-wx.js <产物目录>'); process.exit(2); }

// 轮询 getApp().__mpVerify 缓冲,直到出现匹配 `pred` 的行或超时。
// drive.js 的 evaluate 已经是这一次 App 实例的可信来源,轮询只是提前拿一次
// 快照,不影响 runE2E 结束时的最终解析(r.states)。
async function waitForState(mp, pred, timeoutMs, log, what) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let buf = '';
    try {
      buf = await mp.evaluate(function () {
        const a = getApp();
        return (a && a.__mpVerify) ? a.__mpVerify.join('\n') : '';
      });
    } catch (e) { /* 单次读取失败不致命,继续轮询 */ }
    if (pred(buf)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  log('[ASSERT] 等待 ' + what + ' 超时(' + timeoutMs + 'ms)');
  return false;
}

(async () => {
  const server = await startServer({ port: 18080 });
  let shareDefault = null;
  let shareSet = null;
  try {
    const r = await runE2E({
      projectPath: path.resolve(dir),
      settleMs: 15000,
      // App 从启动到打印 ready_share_default 只需几秒(登录/后端/session/支付/
      // 剪贴板全部很快),随后仅 3 秒就会到 share_set_done —— drive.js 默认
      // bootMs=12000 的话,interact 开始轮询时两个状态往往都已经发生,第一次
      // callMethod 就会拿到"设置后"的分享信息。缩短 bootMs,让轮询尽早开始,
      // 才能在 ready_share_default 和 share_set_done 之间的窗口里各取一次。
      bootMs: 1500,
      async interact(mp, page, log) {
        // App 启动后先打印 ready_share_default 再等 3 秒才调用 setShareInfo,
        // 这里先取一次分享(默认值),再等 share_set_done 之后再取一次
        const gotDefault = await waitForState(
          mp, (b) => /STATE\|ready_share_default/.test(b), 20000, log, 'STATE|ready_share_default');
        if (!gotDefault) return;
        try { shareDefault = await page.callMethod('onShareAppMessage'); }
        catch (e) { log('[ASSERT] 取默认分享信息失败: ' + (e && e.message)); }
        log('[info] share_default=' + JSON.stringify(shareDefault));

        const gotSet = await waitForState(
          mp, (b) => /STATE\|share_set_done/.test(b), 20000, log, 'STATE|share_set_done');
        if (!gotSet) return;
        try { shareSet = await page.callMethod('onShareAppMessage'); }
        catch (e) { log('[ASSERT] 取设置后分享信息失败: ' + (e && e.message)); }
        log('[info] share_set=' + JSON.stringify(shareSet));
      },
    });

    const states = r.states;
    const has = (re) => states.some((s) => re.test(s));
    // 后端(test-server.js 的 /api/wx/login)按 'mock-' + code 前 6 位拼 openid,
    // 断言必须跟着实际拿到的 login code 走,不能只看 'mock-' 前缀(那样即使
    // code 传丢了、后端拿到 undefined 也能碰巧匹配)。
    const loginCode = (states.find((s) => /^login=[A-Za-z0-9_-]{8,}$/.test(s)) || '').slice('login='.length);
    const expectedBackend = loginCode ? 'mock-' + loginCode.slice(0, 6) : null;
    const checks = [
      ['wx_available=true', has(/^wx_available=true$/)],
      ['login 拿到非空 code', has(/^login=[A-Za-z0-9_-]{8,}$/)],
      ['code 送到模拟后端并换回 openid(mock- + login code 前 6 位)',
        !!expectedBackend && has(new RegExp('^backend=' + expectedBackend.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'))],
      ['checkSession 不抛、不挂起(true 或 false)', has(/^session=(true|false)$/)],
      ['requestPayment 无效签名在开发者工具里失败,错误可诊断(含 requestPayment)',
        has(/^pay=ERR MpWechatException\(requestPayment\): requestPayment:fail /)],
      ['剪贴板往返(setClipboardData → getClipboardData)', has(/^clip=口令123$/)],
      // 计划里的第 7 项:分享默认值(setShareInfo 之前)与设置后(之后)各取一次
      ['分享:默认 path=/pages/flutter/flutter 且无 title;设置后 title=限时特惠 且 path 带 query',
        !!shareDefault && shareDefault.path === '/pages/flutter/flutter' && shareDefault.title == null &&
        !!shareSet && shareSet.title === '限时特惠' && shareSet.path === '/pages/flutter/flutter?sku=42'],
    ];

    r.lines.filter((l) => /^\[(error|EXCEPTION|ASSERT|AUTOMATOR|info)\]/.test(l))
      .forEach((l) => console.log('  ' + l.split('\n')[0]));
    if (process.env.E2E_VERBOSE) r.lines.forEach((l) => console.log('  | ' + l));
    checks.forEach(([name, ok]) => console.log((ok ? '✓ ' : '✗ ') + name));
    console.log('  STATE 行:', states.join(' ; '));
    process.exitCode = checks.every(([, ok]) => ok) && !process.exitCode ? 0 : 1;
  } finally {
    await server.close();
  }
})().catch((e) => { console.error('微信能力验收驱动失败:', e && (e.stack || e.message)); process.exit(1); });
