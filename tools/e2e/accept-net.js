'use strict';
/**
 * Phase 3 网络验收:
 *   node accept-net.js <产物目录>
 * 一键跑法见 tools/e2e/run.sh,例如 `tools/e2e/run.sh stable accept-net.js`。
 * 产物须由 tools/e2e/apps/mpf_net(附录 A)以 --verify 构建。连跑两次:第二次
 * 检查 shared_preferences 读到第一次写入的 token(冷启动后存储仍在)。
 */
const path = require('path');
const { runE2E } = require('./drive');
const { startServer } = require('./test-server');

const dir = process.argv[2];
if (!dir) { console.error('用法: node accept-net.js <产物目录>'); process.exit(2); }

(async () => {
  const server = await startServer({ port: 18080 });
  const tokenA = 'A' + Date.now(), tokenB = 'B' + Date.now();
  try {
    server.setToken(tokenA);
    const r1 = await runE2E({ projectPath: path.resolve(dir), settleMs: 20000 });
    server.setToken(tokenB);
    const r2 = await runE2E({ projectPath: path.resolve(dir), settleMs: 20000 });
    const has = (r, re) => r.states.some((s) => re.test(s));
    const px = {};
    r2.pixels.forEach((l) => { const [name, rgba] = l.split('|'); px[name] = rgba; });
    const checks = [
      ['package:http GET 中文 JSON', has(r1, /^http_get=你好😀\/1$/)],
      ['package:http POST 回显 + Authorization', has(r1, /^http_post=POST\|Bearer t1\|世界😀$/)],
      ['package:http 404 为正常响应', has(r1, /^http_404=404\|nope$/)],
      ['dio GET', has(r1, /^dio_get=你好😀$/)],
      ['dio 超时报超时类异常', has(r1, /^dio_timeout=.*[Tt]imeout/)],
      ['package:http close() 取消进行中的请求', has(r1, /^http_cancel=ok$/)],
      ['Image.network 解码并渲染(中心像素为红)', /^25[0-5],[0-5],[0-5],255$/.test(px.center || '')],
      ['Image cacheWidth:32 解码尺寸为 32', has(r1, /^cache_w=32$/)],
      ['toByteData(rawRgba) 长度 = 32×32×4 且像素为红', has(r1, /^bytes_len=4096$/) && has(r1, /^raw_px=25[0-5],[0-5],[0-5],255$/)],
      ['toByteData(png) 为可回解的同尺寸 PNG', has(r1, /^png_ok$/)],
      ['Image.network(cacheWidth) 渲染(左下角染绿的缩放图上屏)',
        !has(r1, /^img_cache=ERR/) && /^[0-5],25[0-5],[0-5],255$/.test(px.corner || '')],
      ['shared_preferences 第一次写入 token', has(r1, new RegExp('^prefs_set=' + tokenA + '$'))],
      ['shared_preferences 冷启动后读到上次 token', has(r2, new RegExp('^prefs_prev=' + tokenA + '$'))],
      ['15 路并发全部成功(wx.request 10 并发上限下的排队)', has(r1, /^http_concurrent=15$/)],
    ];
    const patchLine = r1.states.find((s) => /^http_patch=/.test(s));
    [...r1.lines, ...r2.lines].filter((l) => /^\[(error|EXCEPTION|AUTOMATOR)\]/.test(l))
      .forEach((l) => console.log('  ' + l.split('\n')[0]));
    checks.forEach(([n, ok]) => console.log((ok ? '✓ ' : '✗ ') + n));
    console.log('○ (记录) PATCH 是否可用:', patchLine || 'http_patch 未上报');
    console.log('  run1 STATE:', r1.states.join(' ; '));
    console.log('  run2 STATE:', r2.states.join(' ; '), '| center=', px.center, 'corner=', px.corner);
    process.exitCode = checks.every(([, ok]) => ok) && !process.exitCode ? 0 : 1;
  } finally {
    await server.close();
  }
})().catch((e) => { console.error('网络验收驱动失败:', e && (e.stack || e.message)); process.exit(1); });
