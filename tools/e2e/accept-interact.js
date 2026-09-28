'use strict';
/**
 * Phase 2 交互验收:点击(左右半区)、拖动滚动、文本输入、确认键提交后清空、多输入框切换(Task 5 完成后启用)。
 *   node accept-interact.js <产物目录> [--no-text]
 * 一键跑法见 tools/e2e/run.sh,例如 `tools/e2e/run.sh stable accept-interact.js`。
 * 产物须由 tools/e2e/apps/mpf_interact(附录 A)以 --verify 构建。App 用 print 输出
 * `STATE|...` 行,经 --verify 缓冲(getApp().__mpVerify)回到这里 —— 只认本次
 * App 实例的缓冲,不看 console 通道(开发者工具可能把上一次运行的历史重放进
 * 新连接,console 行不可信,见 drive.js)。
 */
const path = require('path');
const { runE2E } = require('./drive');

const dir = process.argv[2];
const withText = process.argv.indexOf('--no-text') < 0;
if (!dir) { console.error('用法: node accept-interact.js <产物目录> [--no-text]'); process.exit(2); }

const safe = { top: null, bottom: null };
const T = (identifier, x, y) => ({ identifier, x, y, pageX: x, pageY: y, clientX: x, clientY: y });

runE2E({
  projectPath: path.resolve(dir),
  settleMs: 20000,
  async interact(mp, page, log) {
    const canvas = await page.$('#flutter-canvas');
    const size = await canvas.size();
    // K1:App 的内容在 SafeArea 里,顶部让出安全区(状态栏/刘海)。下面按 App 几何
    // 点输入框的 y 坐标都要加上它;同时供 STATE|pad 断言比对。
    try {
      const si = await Promise.race([mp.systemInfo(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('systemInfo 超时')), 15000))]);
      const sa = si && si.safeArea;
      safe.top = Math.round((sa && sa.top) || si.statusBarHeight || 0);
      safe.bottom = Math.round(sa ? Math.max(0, si.windowHeight - sa.bottom) : 0);
      log('[info] 安全区 top=' + safe.top + ' bottom=' + safe.bottom);
    } catch (e) { safe.top = null; log('[ASSERT] 读安全区失败: ' + e.message); }
    const tap = async (x, y) => {
      await canvas.touchstart({ touches: [T(0, x, y)], changedTouches: [T(0, x, y)] });
      await canvas.touchend({ touches: [], changedTouches: [T(0, x, y)] });
      await page.waitFor(800);
    };
    // 下半区左右各点一次(App 的下半区分左右两个 GestureDetector)
    await tap(size.width * 0.25, size.height * 0.8);
    await tap(size.width * 0.75, size.height * 0.8);
    // 在中部列表上向上拖 300px
    const x = size.width / 2, y0 = size.height * 0.55;
    await canvas.touchstart({ touches: [T(1, x, y0)], changedTouches: [T(1, x, y0)] });
    for (let i = 1; i <= 10; i++) {
      const y = y0 - i * 30;
      await canvas.touchmove({ touches: [T(1, x, y)], changedTouches: [T(1, x, y)] });
    }
    await canvas.touchend({ touches: [], changedTouches: [T(1, x, y0 - 300)] });
    await page.waitFor(1500);
    if (withText) {
      // 前面点画布会让 TextField 失焦(Flutter Web 触摸 onTapOutside 默认 unfocus),
      // 原生框随之隐藏。先点回 TextField(顶部 16px 内边距内的第一行,实测几何
      // left16/top28/358×24,再加顶部安全区)重新聚焦,再找原生框。
      await tap(size.width / 2, 40 + (safe.top || 0));
      await page.waitFor(700);
      const input = await page.$('.mp-input');
      if (!input) { log('[ASSERT] 没有找到原生输入框 .mp-input'); return; }
      await input.input('hello世界😀');
      await page.waitFor(1500);
      // 发送后清空:原生确认键 → 引擎 onSubmitted → controller.clear()(App 保持焦点)。
      // 清空必须推回原生框,否则下次按键原生会把"旧文本+新字符"整串送回引擎。
      await input.trigger('confirm', { value: 'hello世界😀' });
      await page.waitFor(1500);
      const input2 = await page.$('.mp-input');
      if (!input2) { log('[ASSERT] 确认后原生输入框消失(App 应保持焦点)'); return; }
      // automator 的 input() 是整串替换;真实键盘是在原生框当前内容后追加。
      // 用"原生框当前值 + x"模拟一次按键,才能暴露清空没推到原生的问题。
      let cur = '';
      try { cur = String(await input2.value() || ''); } catch (e) { log('[ASSERT] 读原生框 value 失败: ' + e.message); }
      log('[info] 确认后原生框 value=' + JSON.stringify(cur));
      await input2.input(cur + 'x');
      await page.waitFor(1500);
      // 实测提交后引擎会重建输入元素(原生框随之销毁重建),上面那条走不到"同一原生框
      // 上引擎改值"。App 在输入以 # 结尾时 clear():同一连接内清空,再追加一个 y。
      const input3 = await page.$('.mp-input');
      if (!input3) { log('[ASSERT] 输入 x 后原生输入框消失'); return; }
      cur = String(await input3.value() || '');
      await input3.input(cur + '#');
      await page.waitFor(1500);
      cur = String(await input3.value() || '');
      log('[info] 输入 # 触发清空后原生框 value=' + JSON.stringify(cur));
      await input3.input(cur + 'y');
      await page.waitFor(1500);
      // 多输入框切换:第一个框聚焦中直接点第二个框(App 第二个 TextField 紧挨第一个下方,
      // 顶部内边距 0、底部 16,文字行实测约 y=92~116,再加顶部安全区)。焦点 A→B 时 wx:if 销毁 A 的原生框,
      // A 框的 bindblur 可能在 B 聚焦后才到 —— 用 A 的会话号补发一次 onMpBlur 模拟这次
      // 迟到的 blur,B 不得因此失焦(否则下面找不到原生框或输入进不了 text2)。
      let sessionA;
      try { sessionA = (await page.data('mpInput')).session; } catch (e) { log('[ASSERT] 读 mpInput.session 失败: ' + e.message); }
      log('[info] 第一个框 session=' + sessionA);
      await tap(size.width / 2, 104 + (safe.top || 0));
      await page.waitFor(700);
      let sessionB;
      try { sessionB = (await page.data('mpInput')).session; } catch (e) { log('[ASSERT] 读 mpInput.session 失败: ' + e.message); }
      log('[info] 第二个框 session=' + sessionB);
      if (sessionA === undefined || sessionB === sessionA) log('[ASSERT] 点第二个框后会话号未变化(没有切到新的输入元素)');
      await page.callMethod('onMpBlur', { currentTarget: { dataset: { session: sessionA } } });
      await page.waitFor(700);
      const inputB = await page.$('.mp-input');
      if (!inputB) { log('[ASSERT] 旧会话迟到的 blur 之后第二个框的原生输入框消失'); return; }
      await inputB.input('b2');
      await page.waitFor(1500);
      // K5 路由切换:第二个框输入 route → App push 带图片+滚动的页面,该页在转场/
      // 滚动帧密集时 pushReplacement(同真实电商场景"申请售后→提交")。曾稳定触发
      // "Null check operator used on a null value"(preroll 读已 dispose 的 picture)。
      await inputB.input('route');
      await page.waitFor(3000);
    }
  },
}).then((r) => {
  // STATE| 只从本次 App 实例的 __mpVerify 缓冲解析(r.states),不看 console 通道
  // 的 r.lines —— 开发者工具可能把上一次运行的 console 历史重放进新连接,造成假通过
  const states = r.states;
  const has = (re) => states.some((s) => re.test(s));
  const checks = [
    ['逻辑尺寸与屏幕一致', has(/^size=\d+x\d+ ok$/)],
    // K1:SafeArea 生效——padding/viewPadding 等于小程序安全区,且顶部非 0
    ['安全区注入 MediaQuery.padding/viewPadding', safe.top > 0 &&
      has(new RegExp('^pad=' + safe.top + ',' + safe.bottom + ' vpad=' + safe.top + ',' + safe.bottom + '$'))],
    ['点左半区', has(/^tap=left$/)],
    ['点右半区', has(/^tap=right$/)],
    ['拖动滚动', has(/^scroll=(\d+)$/) && states.some((s) => /^scroll=(\d+)$/.test(s) && Number(RegExp.$1) >= 100)],
    // K2 守护:冷启动后、第一次拖动之前列表不得自己滚(拖动紧跟在 tap=right 之后;
    // App 只在偏移变化 ≥50 时报 scroll=,所以拖动前出现任何 scroll= 都算失败)
    ['冷启动滚动位置保持在顶部(拖动前无 scroll)', states.indexOf('tap=right') >= 0 &&
      states.findIndex((s) => /^scroll=/.test(s)) > states.indexOf('tap=right')],
  ];
  if (withText) checks.push(['中文与 emoji 输入', has(/^text=hello世界😀$/)]);
  if (withText) {
    const iSubmit = states.indexOf('submit=hello世界😀');
    checks.push(['确认键提交', iSubmit >= 0]);
    checks.push(['提交后清空推回原生框(之后输入得到 text=x)',
      iSubmit >= 0 && states.indexOf('text=x', iSubmit) > iSubmit && !has(/^text=hello世界😀x$/)]);
    const iHash = states.indexOf('text=x#');
    checks.push(['聚焦中引擎清空推回原生框(之后输入得到 text=y)',
      iHash >= 0 && states.indexOf('text=y', iHash) > iHash && !has(/^text=x#y$/)]);
    checks.push(['切到第二个输入框,旧框迟到的 blur 不关新连接(text2=b2)', has(/^text2=b2$/)]);
    checks.push(['路由切换:push 后 pushReplacement 完成',
      states.indexOf('route=pushed') >= 0 && states.indexOf('route=replaced') > states.indexOf('route=pushed')]);
  }
  // K5:整次运行(含冷启动、点击、滚动、输入、路由切换)本次 App 实例控制台无 error。
  // 只认 --verify 缓冲(r.errors),不看可能混入重放历史的 console 通道。
  checks.push(['控制台无 error(含路由切换)', r.errors.length === 0]);
  r.errors.forEach((l) => console.log('  [ERROR|] ' + l.slice(0, 300)));
  r.lines.filter((l) => /^\[(error|EXCEPTION|ASSERT|AUTOMATOR|info)\]/.test(l))
    .forEach((l) => console.log('  ' + l.split('\n')[0]));
  // 排障:E2E_VERBOSE=1 打印全部原始行
  if (process.env.E2E_VERBOSE) r.lines.forEach((l) => console.log('  | ' + l));
  checks.forEach(([name, ok]) => console.log((ok ? '✓ ' : '✗ ') + name));
  console.log('  STATE 行:', states.slice(-8).join(' ; '));
  process.exit(checks.every(([, ok]) => ok) && !process.exitCode ? 0 : 1);
}).catch((e) => { console.error('E2E 驱动失败:', e && (e.stack || e.message)); process.exit(1); });
