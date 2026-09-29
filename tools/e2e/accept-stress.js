'use strict';
/**
 * 压测页验收/汇总:构建 `example`(带 `--dart-define=MP_STRESS=true`、
 * `--perf-hud`),在微信开发者工具里自动跑完整套 A~G 压测项(`example/lib/
 * stress/` 的入口在 MP_STRESS 下首帧自动开始,不用点「开始」),收集
 * `[mp-stress]`/`[mp-perf]` 两种遥测行,打印汇总表,并做基本断言:七项各
 * 有一行输出、末尾有 `[mp-stress] done`、过程无 console error。
 *
 *   node accept-stress.js [产物输出目录]
 *
 * 与别的 accept-*.js 不同:那些跑的是 `tools/e2e/apps/` 下的最小验收工程,
 * 由 `run.sh`/使用者预先构建好;这个脚本自己构建 `example`(任务要求「在
 * 模拟器里用 drive.js 构建 example」),所以不接入 `run.sh` 的
 * app_for_script 映射,单独跑:
 *
 *   node tools/e2e/accept-stress.js
 *   node tools/e2e/accept-stress.js tools/e2e/out/example-stress
 *
 * 环境变量:
 *   MP_APPID              appid,默认 touristappid
 *   FLUTTER_BIN            flutter 可执行文件路径,默认探测
 *                          $HOME/development/flutter/bin/flutter,否则 PATH
 *   STRESS_IMG/_N/_WIDTHS  透传给构建的图片来源 dart-define,默认指向本脚本
 *                          自带的 test-server(见下方「图片来源」),自动化
 *                          环境不拉外网图床、不产生长耗时网络等待。
 *   E2E_STRESS_TIMEOUT_MS  整体超时(含构建 + 驱动),默认 600000(10 分钟),
 *                          超时直接非零退出,不会无限期挂着。
 *
 * 图片来源(B 项/图片墙):默认用 `tools/e2e/test-server.js` 新增的
 * `/stress/redirect/{i}/{w}` 路由——先 302 跳到 `/stress/img/{i}/{w}`,验证
 * 图片解码在跟随跳转之后仍然正常(常见的签名 CDN 场景),同时本地现算 PNG,
 * 不长时间拉服务端的图。真机测量应换成 README/报告里说明的真实图床
 * (`--dart-define=STRESS_IMG=<url 模板>`)。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runE2E } = require('./drive');
const { startServer } = require('./test-server');

const REPO_ROOT = path.resolve(__dirname, '../..');
const MP_FLUTTER_BIN = path.join(REPO_ROOT, 'packages/mp_flutter/bin/mp_flutter.dart');
const EXAMPLE_DIR = path.join(REPO_ROOT, 'example');
const IMG_PORT = 18081; // 与 accept-net.js 的 18080 分开,允许两者同时跑。

const outDir = path.resolve(process.argv[2] || path.join(__dirname, 'out/example-stress'));
const appid = process.env.MP_APPID || 'touristappid';
const overallTimeoutMs = Number(process.env.E2E_STRESS_TIMEOUT_MS || 10 * 60 * 1000);

const EXPECTED_IDS = [
  'A_long_list',
  'B_image_wall',
  'C_long_text_single',
  'D_long_text_listview',
  'E_big_form',
  'F_effects',
  'G_native',
];

function resolveFlutterBin() {
  if (process.env.FLUTTER_BIN) return process.env.FLUTTER_BIN;
  const candidate = path.join(os.homedir(), 'development/flutter/bin/flutter');
  if (fs.existsSync(candidate)) return candidate;
  return 'flutter'; // 回退 PATH
}

function buildExample({ flutterBin, stressImg, stressImgN, stressImgWidths }) {
  const flutterDir = path.dirname(flutterBin);
  const dartBin = path.join(flutterDir, 'dart');
  const env = { ...process.env, PATH: `${flutterDir}${path.delimiter}${process.env.PATH || ''}` };
  delete env.FLUTTER_ROOT; // 见 tools/ci/check.sh/run.sh 同名注释:双 SDK 机器上的坑。

  fs.rmSync(outDir, { recursive: true, force: true });
  const args = [
    'run', MP_FLUTTER_BIN,
    '--project', EXAMPLE_DIR,
    '--output', outDir,
    '--appid', appid,
    '--flutter', flutterBin,
    '--perf-hud',
    '--dart-define', 'MP_STRESS=true',
    '--dart-define', `STRESS_IMG=${stressImg}`,
    '--dart-define', `STRESS_IMG_N=${stressImgN}`,
    '--dart-define', `STRESS_IMG_WIDTHS=${stressImgWidths}`,
  ];
  console.log('== 构建 example(MP_STRESS=true, --perf-hud) →', outDir, '==');
  const r = spawnSync(fs.existsSync(dartBin) ? dartBin : 'dart', args, {
    cwd: REPO_ROOT, env, stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error('构建 example 失败(exit ' + r.status + ')');
  }
}

// 从 drive.js 的原始 console 行(形如 `[log] [mp-stress] A_long_list first=...`)
// 里摘出压测/性能这两种遥测行,去掉开发者工具那层 `[log]`/`[error]` 前缀。
function extractTagged(lines, tag) {
  return lines
    .filter((l) => l.includes(tag))
    .map((l) => l.slice(l.indexOf(tag)));
}

function parseStressLine(line) {
  // [mp-stress] <id> first=1 fps=2 max=3 jank50=4 jank100=5 frames=6 extra=...
  const m = line.match(/^\[mp-stress\]\s+(\S+)\s+first=(\S+)\s+fps=(\S+)\s+max=(\S+)\s+jank50=(\S+)\s+jank100=(\S+)\s+frames=(\S+)\s+extra=(.*)$/);
  if (!m) return null;
  const [, id, first, fps, max, jank50, jank100, frames, extra] = m;
  return { id, first, fps, max, jank50, jank100, frames, extra };
}

async function main() {
  const flutterBin = resolveFlutterBin();
  const stressImg = process.env.STRESS_IMG || `http://127.0.0.1:${IMG_PORT}/stress/redirect/{i}/{w}?v={k}`;
  const stressImgN = process.env.STRESS_IMG_N || '23';
  const stressImgWidths = process.env.STRESS_IMG_WIDTHS || '160,320,480,640';

  buildExample({ flutterBin, stressImg, stressImgN, stressImgWidths });

  const server = await startServer({ port: IMG_PORT });
  try {
    // 压测页在 MP_STRESS 下首帧自动开始(见 stress_home.dart),不用交互
    // 驱动;A~G 全部跑完(含 500 行长列表/6000 字长文两次来回滚动等)在真机
    // 上可能明显慢于开发者工具里的模拟器(有 JIT),settleMs 给足余量,
    // 外层再套一个硬超时兜底(见 overallTimeoutMs)。
    const r = await runE2E({ projectPath: outDir, settleMs: 4 * 60 * 1000 });

    const stressLines = extractTagged(r.lines, '[mp-stress]');
    const perfLines = extractTagged(r.lines, '[mp-perf]');
    const parsed = stressLines.map(parseStressLine).filter(Boolean);
    const byId = new Map(parsed.map((p) => [p.id, p]));

    // `[AUTOMATOR]` 是 drive.js 自己的诊断信息(冷启动/reLaunch 重试之类),
    // 不少是正常路径上的提示(比如"已在入口页,跳过 reLaunch"),不能算作
    // 断言失败——只打印出来供人工核对;真正计入"有没有 error"断言的只有
    // `[error]`(console.error)和 `[EXCEPTION]`(未捕获异常)这两类。
    const notableLines = r.lines.filter((l) => /^\[(error|EXCEPTION|AUTOMATOR)\]/.test(l));
    notableLines.forEach((l) => console.log('  ' + l.split('\n')[0]));
    const errorLines = r.lines.filter((l) => /^\[(error|EXCEPTION)\]/.test(l));

    const checks = [];
    for (const id of EXPECTED_IDS) {
      checks.push([`${id} 有遥测输出`, byId.has(id)]);
    }
    checks.push(['收到 [mp-stress] done', stressLines.some((l) => l === '[mp-stress] done')]);
    checks.push(['过程无 console error', errorLines.length === 0]);

    console.log('\n== 汇总(模拟器,仅供参考——真机数字见 README/报告里的操作说明)==');
    console.log('id'.padEnd(22), 'first(ms)'.padEnd(10), 'fps'.padEnd(8), 'max(ms)'.padEnd(9), 'jank50'.padEnd(7), 'jank100'.padEnd(8), 'frames'.padEnd(7), 'extra');
    for (const id of EXPECTED_IDS) {
      const p = byId.get(id);
      if (!p) { console.log(id.padEnd(22), '(无输出)'); continue; }
      console.log(
        p.id.padEnd(22), p.first.padEnd(10), p.fps.padEnd(8), p.max.padEnd(9),
        p.jank50.padEnd(7), p.jank100.padEnd(8), p.frames.padEnd(7), p.extra,
      );
    }
    console.log(`\n[mp-perf] 行数: ${perfLines.length}${perfLines.length ? '(节选见下)' : ''}`);
    perfLines.slice(0, 5).forEach((l) => console.log('  ' + l));

    console.log();
    checks.forEach(([name, ok]) => console.log((ok ? '✓ ' : '✗ ') + name));
    process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
  } finally {
    await server.close();
  }
}

const watchdog = setTimeout(() => {
  console.error(`⏱️ accept-stress.js 超过 ${overallTimeoutMs}ms 未完成,强制退出`);
  process.exit(124);
}, overallTimeoutMs);
watchdog.unref();

main()
  .catch((e) => { console.error('压测验收驱动失败:', e && (e.stack || e.message)); process.exitCode = 1; })
  .finally(() => clearTimeout(watchdog));
