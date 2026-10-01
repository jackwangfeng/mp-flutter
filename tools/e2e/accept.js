'use strict';
/**
 * Phase 1 验收(计划 Task 14 Step 9):在开发者工具里跑 `--verify` 构建的产物,
 * 断言渲染像素、垫片覆盖与文本排版(含文字的首帧画出来且控制台无 error)。
 *
 *   node accept.js <产物目录>
 *
 * 一键跑法见 tools/e2e/run.sh(自动构建 tools/e2e/apps/mpf_accept 并调用本
 * 脚本),例如 `tools/e2e/run.sh stable accept.js`。
 *
 * 产物须由验收工程 tools/e2e/apps/mpf_accept 构建:橙色底(0xFFFF7A3D)+ 居中
 * 120×120 绿色方块(0xFF6EE7A8)。像素上报由 `--verify` 注入,紧贴
 * Surface.flush 读取。
 *
 * Phase 2(main.dart.js 分片,Task 2):验收构建带 `--dart-chunk-kb 400` 强制
 * main.dart.js 切成多片(pkg-dart-0..N),用来覆盖"多片按序 require.async"
 * 的路径,例如(run.sh 默认不传 --dart-chunk-kb,这条要手动跑):
 *
 *   dart run packages/mp_flutter/bin/flutter_miniprogram.dart \
 *     --project tools/e2e/apps/mpf_accept \
 *     --output tools/e2e/out/mpf_accept_split --verify --appid <appid> \
 *     --dart-chunk-kb 400
 *   node tools/e2e/accept.js tools/e2e/out/mpf_accept_split
 *
 * 不加 `--dart-chunk-kb` 时正常构建通常只会产出 1 片(pkg-dart-0),同一份
 * accept.js 断言逻辑对 1 片和多片都适用。
 */
const path = require('path');
const { runE2E } = require('./drive');
const { assertPixels } = require('./assert-render');
const { assertShimCoverage } = require('./assert-shim-coverage');

const projectPath = process.argv[2];
if (!projectPath) {
  console.error('用法: node accept.js <产物目录>');
  process.exit(2);
}

runE2E({ projectPath: path.resolve(projectPath), settleMs: 30000 }).then((r) => {
  const notable = r.lines.filter((l) => /^\[(error|EXCEPTION|AUTOMATOR)\]/.test(l));
  notable.forEach((l) => console.log('  ' + l.split('\n')[0]));
  const px = assertPixels(r.pixels, { center: [110, 231, 168, 255], corner: [255, 122, 61, 255] });

  // 垫片覆盖必须拿到完整上报(以 __end__ 结尾)才算数:没数据不等于没问题
  const ended = r.touchedApis.some((l) => /^__end__ \d+$/.test(l));
  const reportErr = r.touchedApis.find((l) => /^__error__/.test(l));
  const apis = r.touchedApis.filter((l) => !/^__(end|error)__/.test(l));
  const cov = reportErr ? { ok: false, message: '垫片上报失败:' + reportErr }
    : !ended ? { ok: false, message: '没收到完整的垫片上报(缺 __end__ 标记):页面可能没启动到首帧,或 settleMs 不够' }
    : assertShimCoverage(apis, path.join(__dirname, 'baseline/shim-report.json'));
  console.log('像素:', px.ok ? '✓' : '✗ ' + px.failures.join('; '));
  console.log('垫片覆盖:', cov.ok ? '✓' : '✗ ' + cov.message);

  // K4(crypto.getRandomValues):main.dart 打印两次 STATE|rand=<Random.secure()
  // .nextInt(1<<32)>——两次都要非空,且不能相同(相同就说明 DRBG 没真的在产
  // 出新数据,例如误接了常量或没播种成功)。
  const randValues = r.states.filter((l) => /^rand=/.test(l)).map((l) => l.slice('rand='.length));
  const rand = randValues.length < 2
    ? { ok: false, message: '没收到两条 STATE|rand=(实际 ' + randValues.length + ' 条):' + JSON.stringify(randValues) }
    : randValues.some((v) => !v)
      ? { ok: false, message: '存在空值: ' + JSON.stringify(randValues) }
      : new Set(randValues).size !== randValues.length
        ? { ok: false, message: '两次取值相同,DRBG 可能没有真的产出新数据: ' + JSON.stringify(randValues) }
        : { ok: true };
  console.log('crypto.getRandomValues:', rand.ok ? '✓' : '✗ ' + rand.message);

  // 文本排版(iOS 白屏回归):含文字的首帧必须画出来,且本次运行控制台不能有 error
  // (chromium 版 CanvasKit 在没有 Intl.v8BreakIterator 的运行时首次排版即抛异常)
  r.errors.forEach((l) => console.log('  [ERROR|] ' + l.slice(0, 300)));
  const laidOut = r.states.some((l) => l === 'text=laidout');
  const flutterErrors = r.states.filter((l) => /^flutterError=/.test(l));
  flutterErrors.forEach((l) => console.log('  [STATE|] ' + l.slice(0, 300)));
  const text = flutterErrors.length ? { ok: false, message: '框架捕获到 ' + flutterErrors.length + ' 个异常(见上)' }
    : !laidOut ? { ok: false, message: '没收到 STATE|text=laidout(含文字的首帧没画出来)' }
    : r.errors.length ? { ok: false, message: '控制台有 ' + r.errors.length + ' 条 error(见上)' }
    : { ok: true };
  console.log('文本排版:', text.ok ? '✓' : '✗ ' + text.message);

  // drive.js 遇到非超时的 unhandled rejection 会置 exitCode,不能被这里覆盖掉
  process.exit(px.ok && cov.ok && rand.ok && text.ok && !process.exitCode ? 0 : 1);
}).catch((e) => {
  console.error('E2E 驱动失败:', e && (e.stack || e.message) || e);
  process.exit(1);
});
