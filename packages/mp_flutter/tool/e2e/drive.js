'use strict';
const path = require('path');
const { execFile } = require('child_process');

const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';

// `miniprogram-automator` 懒解析:本文件可能被复制到调用方工程里单独使用
// (见同目录 README.md),不一定和调用方共享同一棵 node_modules 树;本仓库内
// 部 tools/e2e/drive.js 这条路径本身就是一层转发(见该文件),转发目标
// (本文件)又不与 tools/e2e/node_modules 同目录,同样需要靠下面第 2 条才能
// 找到依赖。解析顺序(都失败才报错,顺序即优先级):
//   1. 正常 require 解析 —— 本文件自身所在目录向上找 node_modules(仓库内
//      直接用,或把整个 tool/e2e 目录连同 node_modules 一起复制时命中)
//   2. 从实际被 `node` 执行的入口脚本所在目录向上找(`require.main.filename`)
//      —— 覆盖"入口脚本与 node_modules 同目录,但该脚本通过别的路径转发式
//      require 到本文件"的情况(本仓库 tools/e2e/accept-*.js + 它们的
//      node_modules 正是这种布局)
//   3. 从调用方当前工作目录(process.cwd())向上找 —— 推荐用法:复制本目录
//      到别处后 `npm install`,再从那份副本的目录里跑脚本
//   4. `NODE_PATH` 环境变量列出的各个目录
// 直到实际调用 runE2E 时才解析并 require——这样单独 require('./drive.js')
// (例如只是想看看 module.exports 的 shape)不会因为没装 automator 而报错。
function resolveAutomatorRoot() {
  const attempts = [
    () => require.resolve('miniprogram-automator/package.json'),
    ...(require.main && require.main.filename
      ? [() => require.resolve('miniprogram-automator/package.json',
          { paths: [path.dirname(require.main.filename)] })]
      : []),
    () => require.resolve('miniprogram-automator/package.json', { paths: [process.cwd()] }),
    ...(process.env.NODE_PATH
      ? process.env.NODE_PATH
          .split(path.delimiter)
          .filter(Boolean)
          .map((np) => () => require.resolve('miniprogram-automator/package.json', { paths: [np] }))
      : []),
  ];
  for (const attempt of attempts) {
    try {
      return path.dirname(attempt());
    } catch (_) {
      // 试下一种解析方式
    }
  }
  throw new Error(
    "找不到依赖 'miniprogram-automator'。\n" +
    '请先安装它,三选一:\n' +
    '  1. 在本目录(或你复制到的目录)下执行 `npm install`\n' +
    '  2. 在调用方工程根(process.cwd())执行 `npm i miniprogram-automator`\n' +
    '  3. 设置 NODE_PATH 指向一个已安装该依赖的 node_modules 目录\n' +
    '注意:不要在 pub 缓存目录(~/.pub-cache 等)里直接 npm install —— pub 缓存'
    + '是只读/共享的,应先把本目录复制到自己的工程里再装依赖(见同目录 README.md)。'
  );
}

let automator = null;
let pendingAutomatorErrors;
/** 懒加载并(仅一次)给 Connection 打上容错补丁、挂 unhandledRejection 兜底。 */
function ensureAutomator() {
  if (automator) return automator;
  const automatorRoot = resolveAutomatorRoot();
  automator = require(automatorRoot);

  // 开发者工具会推送不带 id 的 `{method:"error"}` 消息(如首次编译新工程时 JS
  // 线程忙,报 "timeout waiting for automator response")。automator 的 Connection
  // 把它 emit 成 'error' 事件;没有监听器时 Node 直接让整个进程崩掉,而这发生在
  // launch 内部、调用方来不及挂监听。在类层面兜住:只记录,不崩。
  pendingAutomatorErrors = [];
  const Connection = require(path.join(automatorRoot, 'out', 'Connection')).default;
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

  return automator;
}

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

// 首次打开某个工程路径时开发者工具偶发内部错误,launch 整体重试一次
async function launchWithRetry(projectPath) {
  const automator = ensureAutomator();
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

// 2026-09-28 排障实录:accept-interact.js/accept-wx.js 报
// `Error: No context found for objectId N`(accept-interact.js 在 canvas 交互
// 之后的 onMpBlur 上炸,accept-wx.js 在 onShareAppMessage 上炸)。先在
// 21dc9f8(上一次这两个脚本全绿的提交)重跑同一套 accept-*.js,同样复现—
// 排除业务代码回归。查 WeappLog 证实:`cli auto` 实际用的基础库是服务端
// fetchAttr 按 appid 下发的 3.17.4,完全无视 project.config.json 里锁的
// libVersion 3.15.0——这是一次环境变化(账号/appid 的基础库策略被服务端调
// 高),不是本仓库提交引入的。开 `DEBUG=automator:protocol` 抓协议帧进一步
// 定位到:失败的**只有** `Page.callMethod` 这一条 RPC;同一个 pageId 上
// `Page.getData`、`App.getCurrentPage`、`App.callFunction`(即 mp.evaluate)
// 全部正常,且 App.getCurrentPage 重新确认过 pageId 依旧有效——不是句柄过
// 期,重试同一条 RPC 无效(实测原样报同一个错)。判断是 3.17.4 这个基础库
// 版本下 `Page.callMethod` 的协议实现本身坏了(automator 客户端已是 npm 最
// 新的 0.12.1,没有更高版本可升)。
//
// 绕过:`page.callMethod(method, ...args)` 不再走原生 `Page.callMethod` RPC,
// 改用始终正常的 `mp.evaluate()`(走 `App.callFunction`,在 App Service 层跑),
// 在那一层用小程序官方 API `getCurrentPages()` 拿到当前页面的真实实例,直接
// `pageInstance[method].apply(pageInstance, args)`——同一个 this、同一份闭包
// 状态,方法里的 setData 照常触发 WXML 重渲染,效果与框架自己派发事件到这个
// 方法等价,只是不经过那条坏掉的 RPC 通道。
//
// 另外用 Proxy 包一层通用的"句柄过期重试":元素/页面 objectId 在冷启动极短
// 窗口内偶发整体失效(不限于 callMethod)时,重新取一次句柄(mp.currentPage()
// 或原 selector 的 page.$())再重试一次;命中特征错误之外的异常原样抛出。这条
// 和上面的 callMethod 绕过是两个独立的兜底,互不影响。
const STALE_CONTEXT_RE = /No context found for objectId/;

async function callPageMethod(mp, method, args) {
  return mp.evaluate(function (m, a) {
    var pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    var p = pages && pages[pages.length - 1];
    if (!p || typeof p[m] !== 'function') {
      throw new Error('page.' + m + ' 不存在或不是函数(getCurrentPages 拿到的当前页)');
    }
    return p[m].apply(p, a);
  }, method, args);
}

function wrapElement(mp, pageProxy, selector, element) {
  let live = element;
  return new Proxy({}, {
    get(_, prop) {
      const orig = live[prop];
      if (typeof orig !== 'function') return orig;
      return async function (...args) {
        try {
          return await orig.apply(live, args);
        } catch (e) {
          if (!STALE_CONTEXT_RE.test((e && e.message) || '')) throw e;
          const fresh = await pageProxy.$(selector);
          if (!fresh) throw e;
          live = fresh;
          return live[prop](...args);
        }
      };
    },
  });
}

function wrapPage(mp, page) {
  let live = page;
  const proxy = new Proxy({}, {
    get(_, prop) {
      // Page.callMethod 这条 RPC 在当前环境下坏掉了(见上面大段注释),直接
      // 绕开,不走下面通用的"同一条调用重试"路径(重试也没用)。
      if (prop === 'callMethod') {
        return (method, ...args) => callPageMethod(mp, method, args);
      }
      const orig = live[prop];
      if (typeof orig !== 'function') return orig;
      return async function (...args) {
        const finish = async (target) => {
          const ret = await target[prop](...args);
          return prop === '$' && ret ? wrapElement(mp, proxy, args[0], ret) : ret;
        };
        try {
          return await finish(live);
        } catch (e) {
          if (!STALE_CONTEXT_RE.test((e && e.message) || '')) throw e;
          live = await mp.currentPage();
          return finish(live);
        }
      };
    },
  });
  return proxy;
}

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
      const page = wrapPage(mp, await race(mp.currentPage(), 15000, 'currentPage'));
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
