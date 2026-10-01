'use strict';
/**
 * Phase 5 Task 1/2/3/4 验收:平台视图(原生组件)冒烟(Task 1)+ 原生视图同步层
 * 几何(Task 2)+ mp_flutter_native(MpVideo/MpMap,Task 3)+ 可选 WXML 伴生层
 * (--semantics-mirror,Task 4)。
 *
 *   node accept-pv.js <产物目录> [--check-semantics]
 *
 * 一键跑法见 tools/e2e/run.sh,例如 `tools/e2e/run.sh android accept-pv.js`
 * (`--check-semantics` 变体需要额外用 --semantics-mirror 单独构建,run.sh
 * 默认不传,见下方手动跑法)。
 *
 * 产物须由验收工程 tools/e2e/apps/mpf_pv 构建(见
 * plans/2026-09-27-mp-flutter-phase5.md 附录 A,以及 task-2-report.md 附的
 * main.dart 全文;Task 4 起改为 lib/main.dart 现状——两个原来"随便什么类型"的
 * HtmlElementView 占位换成真正的 MpVideo/MpMap,见该文件头注释):全屏纯色背景
 * 0xFF2E7D32(屏幕中心期望像素 46,125,50),顶部一个 MpVideo(120px 高,无
 * 裁剪)+ 一个 MpMap(120px 高,包 ClipRRect(12)),下面一段可滚动的空白(留给
 * 滚动验收),中部(未滚动时)留空让屏幕中心落在背景色上。
 *
 *   dart run packages/mp_flutter/bin/flutter_miniprogram.dart \
 *     --project tools/e2e/apps/mpf_pv \
 *     --output <产物目录> --verify --appid <appid> [--semantics-mirror] \
 *     [--flutter <bin>] [--force-platform ios|android]
 *   node tools/e2e/accept-pv.js <产物目录> [--check-semantics]
 *
 * `--check-semantics` 只应该配合以 `--semantics-mirror` 构建的产物使用——
 * 断言 page.data('mpSemantics') 里能读到验收工程里的已知文本(见
 * lib/main.dart 的 Semantics(label: ...))。
 *
 * 断言:
 *   ① 没有 [error](垫片对 webgl2 的探测已静默返回 null,不再豁免任何 error)
 *   ② PIXEL|center 不是全黑,且落在背景色 46,125,50 附近(见 spec §1/§3)
 *   ③(Task 2/3)MPNATIVE| 缓冲行(承载页 `this.data.mpNative` 在 boot 完成
 *      3s 后的一次快照,__mpVerify 通道带出)反映两个原生组件的真实合成几何:
 *      id=0(MpVideo,无裁剪)left=0,top=0,390×120,hidden=false,clip=null;
 *      id=1(MpMap,ClipRRect(12))top=120(紧跟 id=0 之下)、clip.radius=12、
 *      hidden=false。这组数值是本机实测所得(2026-09-27 修复轮 1,mpf_pv
 *      构建产物,iPhone 15 机型/390 逻辑宽度的开发者工具模拟器),几何计算与
 *      视图类型无关(mp_flutter_native 内部同样是 HtmlElementView),Task 4
 *      沿用不变。
 *   ④(Task 4 新增,automator 交互,见 drive.js 的 interact 钩子)
 *      · page.data('mpNative') 里 id=0 的矩形与 Flutter 侧打印的
 *        `STATE|video_rect=` 一致(误差 1px)
 *      · Dart 调 ScrollController.jumpTo 之后,再读一次 mpNative,id=0 的
 *        top 与滚动前不同,且两个原生组件都 hidden:true(已经整块滚出视口)
 *      · 事件回路:page.callMethod('onMpNativeEvent', {type:'ended', ...})
 *        之后,__mpVerify 缓冲里出现 STATE|video_ended
 *      · 控制器:STATE|controller_play_ok 出现(不是 controller_play_error)
 *   ⑤(可选,--check-semantics)page.data('mpSemantics') 数组里某一项的
 *      label 含验收工程里的已知文本
 */
const path = require('path');
const { runE2E } = require('./drive');
const { assertPixels } = require('./assert-render');
const { startServer } = require('./test-server');

const projectPath = process.argv[2];
const checkSemantics = process.argv.indexOf('--check-semantics') >= 0;
if (!projectPath) {
  console.error('用法: node accept-pv.js <产物目录> [--check-semantics]');
  process.exit(2);
}

// 轮询 getApp().__mpVerify 缓冲,直到出现匹配 `pred` 的行或超时(与
// accept-wx.js 的 waitForState 同一套写法:drive.js 结束时的 evaluate 才是
// 最终可信来源,这里只是提前拿一次快照,决定什么时候可以安全地做下一步
// automator 交互)。
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
    if (pred(buf)) return buf;
    await new Promise((r) => setTimeout(r, 500));
  }
  log('[ASSERT] 等待 ' + what + ' 超时(' + timeoutMs + 'ms)');
  return null;
}

function parseNamedFloats(buf, name) {
  const re = new RegExp(name + '=([-\\d.,]+)');
  const m = re.exec(buf || '');
  if (!m) return null;
  return m[1].split(',').map(Number);
}

function checkMpNative(verifyLines) {
  const line = verifyLines.find((l) => l.startsWith('MPNATIVE|'));
  if (!line) return { ok: false, failures: ['没有收到 MPNATIVE| 遥测行'] };
  const body = line.slice('MPNATIVE|'.length);
  let data;
  try { data = JSON.parse(body); }
  catch (e) { return { ok: false, failures: ['MPNATIVE| 内容不是合法 JSON: ' + body] }; }
  return checkMpNativeSnapshot(data);
}

/** 校验一份 mpNative 快照(不管来自 MPNATIVE| 缓冲行还是 page.data('mpNative'))
 * 里 id=0(MpVideo,无裁剪)/id=1(MpMap,ClipRRect(12))的初始几何。 */
function checkMpNativeSnapshot(data) {
  const failures = [];
  const ids = Object.keys(data || {});
  if (ids.length !== 2) failures.push('期望 2 个原生组件,实际 ' + ids.length + '(' + ids.join(',') + ')');

  const plain = data['0'];
  if (!plain) {
    failures.push('缺少 id=0 的视图(MpVideo,无显式裁剪)');
  } else {
    const want = { left: 0, top: 0, width: 390, height: 120, hidden: false, clip: null, type: 'video' };
    Object.keys(want).forEach((k) => {
      const got = JSON.stringify(plain[k]);
      const exp = JSON.stringify(want[k]);
      if (got !== exp) failures.push('id=0 的 ' + k + ' 期望 ' + exp + ',实得 ' + got);
    });
  }

  const clipped = data['1'];
  if (!clipped) {
    failures.push('缺少 id=1 的视图(MpMap,ClipRRect(12))');
  } else {
    if (clipped.type !== 'map') failures.push('id=1 的 type 期望 map,实得 ' + clipped.type);
    if (clipped.hidden !== false) failures.push('id=1 的 hidden 期望 false,实得 ' + clipped.hidden);
    if (!clipped.clip || clipped.clip.radius !== 12) {
      failures.push('id=1 的 clip.radius 期望 12,实得 ' + JSON.stringify(clipped.clip));
    }
    if (clipped.top !== 120) failures.push('id=1 的 top 期望 120(紧跟在 id=0 的 120 高之下),实得 ' + clipped.top);
  }

  return { ok: failures.length === 0, failures };
}

(async () => {
  const server = await startServer({ port: 18080 });

  // 供 interact 回调写、外层读(runE2E resolve 之后才做断言)。
  let mpBefore = null;
  let mpAfter = null;
  let videoRectLine = null;
  let semantics = null;
  const interactAsserts = [];

  try {
    const r = await runE2E({
      projectPath: path.resolve(projectPath),
      settleMs: 20000,
      // 短 bootMs:让 interact 尽早开始轮询 STATE|video_rect(Flutter 侧首帧
      // 后打印),必须赶在 lib/main.dart 里 15s 那个 jumpTo 定时器之前读到
      // "滚动前"的 mpNative 快照——accept-wx.js 已经验证过这个做法可行
      // (page.data()/callMethod() 依赖的是 WXML 页面实例,不依赖 CanvasKit/
      // Dart 引擎已经跑完首帧)。
      bootMs: 1500,
      async interact(mp, page, log) {
        const buf1 = await waitForState(mp, (b) => /STATE\|video_rect=/.test(b),
          20000, log, 'STATE|video_rect(首帧矩形)');
        if (buf1 == null) return;
        videoRectLine = parseNamedFloats(buf1, 'video_rect');
        try { mpBefore = await page.data('mpNative'); }
        catch (e) { log('[ASSERT] 读 mpNative(滚动前)失败: ' + (e && e.message)); }

        // 事件回路:模拟微信原生 <video> 派发的 ended 事件。
        try {
          await page.callMethod('onMpNativeEvent',
            { type: 'ended', currentTarget: { dataset: { mpid: '0' } }, detail: {} });
        } catch (e) { log('[ASSERT] callMethod onMpNativeEvent 失败: ' + (e && e.message)); }

        const buf2 = await waitForState(mp, (b) => /STATE\|video_rect_after_scroll=/.test(b),
          20000, log, 'STATE|video_rect_after_scroll(滚动后)');
        if (buf2 == null) return;
        try { mpAfter = await page.data('mpNative'); }
        catch (e) { log('[ASSERT] 读 mpNative(滚动后)失败: ' + (e && e.message)); }

        if (checkSemantics) {
          try { semantics = await page.data('mpSemantics'); }
          catch (e) { log('[ASSERT] 读 mpSemantics 失败: ' + (e && e.message)); }
        }
      },
    });

    const notable = r.lines.filter((l) => /^\[(error|EXCEPTION|AUTOMATOR)\]/.test(l));
    notable.forEach((l) => console.log('  ' + l.split('\n')[0]));

    const errs = r.lines.filter((l) => /^\[error\]/.test(l));
    const noErr = { ok: errs.length === 0, failures: errs };

    const px = assertPixels(r.pixels, { center: [46, 125, 50, 255] });

    const mpNative = checkMpNative(r.verifyLines);

    // ④ 新增断言。
    if (!mpBefore) interactAsserts.push('没有拿到 page.data(\'mpNative\')(滚动前)');
    if (!videoRectLine) interactAsserts.push('没有拿到 STATE|video_rect=');
    if (mpBefore && videoRectLine) {
      const v0 = mpBefore['0'];
      if (!v0) interactAsserts.push('page.data(\'mpNative\') 缺少 id=0');
      else {
        const [rx, ry, rw, rh] = videoRectLine;
        const close = (a, b) => Math.abs(a - b) <= 1;
        if (!close(v0.left, rx) || !close(v0.top, ry) || !close(v0.width, rw) || !close(v0.height, rh)) {
          interactAsserts.push('page.data(\'mpNative\')[0] 矩形 ' +
            JSON.stringify([v0.left, v0.top, v0.width, v0.height]) +
            ' 与 STATE|video_rect=' + videoRectLine.join(',') + ' 误差超过 1px');
        }
      }
      const snapBefore = checkMpNativeSnapshot(mpBefore);
      if (!snapBefore.ok) interactAsserts.push(...snapBefore.failures.map((f) => '(滚动前)' + f));
    }

    if (!mpAfter) {
      interactAsserts.push('没有拿到 page.data(\'mpNative\')(滚动后)');
    } else {
      const v0b = mpBefore && mpBefore['0'];
      const v0a = mpAfter['0'];
      const v1a = mpAfter['1'];
      // "矩形随之变化"的信号是 hidden(以及/或者几何字段)翻转,不是死抠 top
      // 数值一定要不同——滚出视口后 native-views.js 在找不到
      // flt-platform-view-slot 时按"隐藏"兜底上报 left/top 都是 0(见
      // native-views.js computeGeometry 的 noSlot 分支),那本身就是"变化"的
      // 证据之一,不能反过来当成"没变化"。
      if (v0b && v0a && JSON.stringify(v0b) === JSON.stringify(v0a)) {
        interactAsserts.push('ScrollController.jumpTo 之后 id=0 的 mpNative 记录与滚动前完全相同,矩形应该随之变化');
      }
      if (!v0a || v0a.hidden !== true) interactAsserts.push('滚出视口后 id=0 的 hidden 期望 true,实得 ' + (v0a && v0a.hidden));
      if (!v1a || v1a.hidden !== true) interactAsserts.push('滚出视口后 id=1 的 hidden 期望 true,实得 ' + (v1a && v1a.hidden));
    }

    if (!r.states.some((s) => s === 'video_ended')) {
      interactAsserts.push('派发 onMpNativeEvent(ended)之后没有出现 STATE|video_ended');
    }
    if (r.states.some((s) => s.startsWith('controller_play_error'))) {
      interactAsserts.push('controller.play() 抛错: ' + r.states.find((s) => s.startsWith('controller_play_error')));
    } else if (!r.states.some((s) => s === 'controller_play_ok')) {
      interactAsserts.push('没有出现 STATE|controller_play_ok(controller.play() 可能没跑到/一直卡在 pending)');
    }

    if (checkSemantics) {
      if (!semantics || !Array.isArray(semantics) || semantics.length === 0) {
        interactAsserts.push('--check-semantics:page.data(\'mpSemantics\') 为空或不是数组');
      } else if (!semantics.some((e) => String(e && e.label || '').indexOf('已知文本') >= 0)) {
        interactAsserts.push('--check-semantics:mpSemantics 里没有找到验收工程的已知文本,实得 ' + JSON.stringify(semantics));
      }
    }

    const interactOk = interactAsserts.length === 0;

    console.log('无异常 [error]:', noErr.ok ? '✓' : '✗ ' + errs.join('; '));
    console.log('像素:', px.ok ? '✓' : '✗ ' + px.failures.join('; '));
    console.log('原生视图同步层几何(mpNative,MPNATIVE| 快照):', mpNative.ok ? '✓' : '✗ ' + mpNative.failures.join('; '));
    console.log('Task 4 交互验收(video_rect/滚动/事件回路/控制器' + (checkSemantics ? '/伴生层' : '') + '):',
      interactOk ? '✓' : '✗ ' + interactAsserts.join('; '));

    process.exit(noErr.ok && px.ok && mpNative.ok && interactOk ? 0 : 1);
  } finally {
    await server.close();
  }
})().catch((e) => {
  console.error('E2E 驱动失败:', e && (e.stack || e.message) || e);
  process.exit(1);
});
