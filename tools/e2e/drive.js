'use strict';
const automator = require('miniprogram-automator');
const { execFile } = require('child_process');

const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';

// 冷启动:开发者工具对同一工程路径的重连会把上一次运行的 console 历史重放进
// 新连接(实测:第二次运行的日志里出现第一次运行的唯一标记行)。旧遥测行可能
// 恰好满足本次断言,造成验收假通过。launch 之前先强制关闭该工程一次,让下面
// 的 launch 走冷启动,__mpVerify 从空开始。
//
// close 失败(CLI 语义变更、路径错误等)不应让测试崩掉 —— 但也不能默默吞掉:
// 冷启动没生效的话,旧 App 实例的 __mpVerify 会继续累积,"只信缓冲解析"这层
// 修复会被同一个根因绕开而无人知晓,所以把失败原因返回给调用方记进 `lines`。
function closeProject(projectPath) {
  return new Promise((resolve) => {
    execFile(CLI, ['close', '--project', projectPath], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) resolve((err.message || String(err)) + (stderr ? ' | stderr: ' + String(stderr).trim() : ''));
      else resolve(null);
    });
  });
}

// 开发者工具会推送不带 id 的 `{method:"error"}` 消息(如首次编译新工程时 JS
// 线程忙,报 "timeout waiting for automator response")。automator 的 Connection
// 把它 emit 成 'error' 事件;没有监听器时 Node 直接让整个进程崩掉,而这发生在
// launch 内部、调用方来不及挂监听。在类层面兜住:只记录,不崩。
const pendingAutomatorErrors = [];
const Connection = require('miniprogram-automator/out/Connection').default;
const origEmit = Connection.prototype.emit;
Connection.prototype.emit = function (ev, ...args) {
  if (ev === 'error' && this.listenerCount('error') === 0) {
    const e = args[0];
    const msg = (e && (e.message || JSON.stringify(e))) || String(e);
    // 只放过自动化超时;断连、开发者工具崩溃等照常抛出
    if (/timeout waiting for automator response/.test(msg)) {
      pendingAutomatorErrors.push(msg);
      return false;
    }
  }
  return origEmit.call(this, ev, ...args);
};

// 同一类消息也会以"某个已发出调用被 reject"的形式出现:自动化调用输掉了
// race 超时之后仍挂着,稍后被开发者工具以超时 reject,无人处理 → Node 默认
// 因 unhandled rejection 退出进程。只吞这一类(开发者工具的自动化超时),
// 其余 unhandled rejection 照常暴露。
process.on('unhandledRejection', (e) => {
  const msg = (e && e.message) || String(e);
  if (/timeout waiting for automator response/.test(msg)) {
    pendingAutomatorErrors.push('late reject: ' + msg);
    return;
  }
  console.error('unhandled rejection:', e);
  process.exitCode = 1;
});

// 首次打开某个工程路径时开发者工具偶发内部错误,launch 整体重试一次
async function launchWithRetry(projectPath) {
  const opts = { cliPath: CLI, projectPath, timeout: 120000 };
  try {
    return await automator.launch(opts);
  } catch (e) {
    pendingAutomatorErrors.push('launch 首次失败,重试: ' + (e && e.message));
    await new Promise((r) => setTimeout(r, 5000));
    return automator.launch(opts);
  }
}
const race = (p, ms, tag) => Promise.race([p,
  new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT ' + tag)), ms))]);

/**
 * 驱动微信开发者工具跑一个产物工程,收集遥测。
 *
 * 遥测全部走 console 的纯字符串通道 —— page.data() 会被阻塞的 JS 线程卡死。
 *
 * 两条通道:① automator 的 console 监听(实时,但开发者工具可能把上一次连接
 * 的历史重放进来,不可信);② 结束时 mp.evaluate 取回 `getApp().__mpVerify`
 * ——只属于本次 App 实例(且 launch 前已冷启动),断言解析只认这一条。
 * console 行仍然收集进 `lines` 供诊断打印,前缀保持 `[log]`/`[error]` 等原样;
 * 缓冲行单独进 `verifyLines`(不带前缀),同时以 `[verify] ` 前缀并入 `lines`
 * 方便人工核对,但解析函数(parsePrefixed)只吃 `verifyLines`。
 */
async function runE2E(opts) {
  const lines = [];
  const verifyLines = [];
  const closeErr = await closeProject(opts.projectPath);
  if (closeErr) lines.push('[AUTOMATOR] cli close 失败: ' + closeErr);
  const mp = await launchWithRetry(opts.projectPath);
  pendingAutomatorErrors.splice(0).forEach((m) => lines.push('[AUTOMATOR] ' + m));
  try {
    mp.on('console', (m) => {
      const txt = (m.args || []).map((x) => {
        if (x && typeof x === 'object') {
          if (x.message || x.stack) {
            return (x.name || 'Error') + ': ' + (x.message || '') +
                   ' @@ ' + String(x.stack || '').split('\n').slice(0, 4).join(' / ');
          }
          return JSON.stringify(x).slice(0, 400);
        }
        return String(x);
      }).join(' ');
      // 小程序基础库刷大量 deprecation 警告,与业务遥测无关,过滤掉避免噪音
      if (/deprecated/.test(txt)) return;
      lines.push('[' + m.type + '] ' + txt);
    });
    mp.on('exception', (e) => lines.push('[EXCEPTION] ' + (e.message || JSON.stringify(e))));

    // 首次打开某个工程路径时,开发者工具内部状态还没就绪,reLaunch 偶发报
    // `getPageMetaByWebviewId(...) is null` 之类的内部错误。等几秒重试一次。
    const entry = '/' + (opts.entryPage || 'pages/flutter/flutter');
    // 已经在入口页就不要 reLaunch:引擎是 JS 上下文单例,承载页重入不会重新
    // 启动引擎,测到的会是被销毁的旧页面实例
    let current = null;
    try { current = await race(mp.currentPage(), 15000, 'currentPage'); } catch (_) {}
    if (current && '/' + current.path === entry) {
      lines.push('[AUTOMATOR] 已在入口页,跳过 reLaunch');
    } else try {
      await race(mp.reLaunch(entry), 90000, 'reLaunch');
    } catch (e) {
      lines.push('[AUTOMATOR] reLaunch 首次失败,重试: ' + (e && e.message));
      await new Promise((r) => setTimeout(r, 5000));
      await race(mp.reLaunch(entry), 90000, 'reLaunch(重试)');
    }
    // 交互驱动(Task 4):点击/拖动等需要在引擎首帧渲染完、承载页 onMpTouch
    // 就位之后才有意义,所以放在 settle 等待之前、boot 等待之后执行。
    if (opts.interact) {
      await new Promise((r) => setTimeout(r, opts.bootMs || 12000));   // 等引擎首帧
      const page = await race(mp.currentPage(), 15000, 'currentPage');
      await opts.interact(mp, page, (l) => lines.push(l));
    }
    await new Promise((r) => setTimeout(r, opts.settleMs || 30000));
    // --verify 页面把遥测缓冲在本次 App 实例上;这是唯一可信的断言来源
    // (console 监听可能混入开发者工具重放的上一次运行历史)
    try {
      const buffered = await race(mp.evaluate(function () {
        const a = getApp();
        return (a && a.__mpVerify) ? a.__mpVerify.join('\n') : '';
      }), 15000, 'evaluate');
      for (const l of String(buffered || '').split('\n').filter(Boolean)) {
        verifyLines.push(l);
        lines.push('[verify] ' + l);
      }
    } catch (e) {
      lines.push('[AUTOMATOR] 取回缓冲遥测失败: ' + (e && e.message));
    }
  } finally {
    try { await race(mp.close(), 15000, 'close'); } catch (_) {}
    pendingAutomatorErrors.splice(0).forEach((m) => lines.push('[AUTOMATOR] ' + m));
  }

  return {
    lines,
    verifyLines,
    steps: parsePrefixed(verifyLines, 'STEP|'),
    touchedApis: parsePrefixed(verifyLines, 'TOUCH|'),
    pixels: parsePrefixed(verifyLines, 'PIXEL|'),
    states: parsePrefixed(verifyLines, 'STATE|'),
    // 本次 App 实例里的 console.error(--verify 构建把它们以 ERROR| 缓冲,见 pipeline.dart)
    errors: parsePrefixed(verifyLines, 'ERROR|'),
  };
}

function parsePrefixed(lines, prefix) {
  return lines
    .filter((l) => l.indexOf(prefix) >= 0)
    .map((l) => l.slice(l.indexOf(prefix) + prefix.length).trim());
}

module.exports = { runE2E };
