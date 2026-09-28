'use strict';
const fs = require('fs');

/**
 * 比对垫片 report() 的"未实现 API"快照。
 *
 * 这是 Flutter 版本升级时唯一的早期预警:新版引擎可能触达垫片没实现的宿主 API,
 * 表现是一块静默黑屏 —— 没有这道比对就只能靠肉眼发现。
 *
 * 基线里记录的是**已知会被触达且确认安全**的 undefined 访问
 * (比如 window.Window —— dart2js 有降级分支)。
 * 出现基线之外的新条目必须让测试失败。
 */
function assertShimCoverage(touchedApis, baselinePath) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const known = new Set(baseline.knownUndefined);

  // TOUCH 行的已知完整格式:形如 "1× window.Window →undefined"
  // ★ 重要:先格式校验、后内容判断。先过滤内容会导致格式变更时预警失效。
  // 对包含 →undefined 或其他 → 标记的行做格式校验;对格式可疑的行(含→但不完整)进 malformed;
  // 对完全不同格式的行也进 malformed;只有完全无关的行(不含 →)才忽略。
  const FULL_TOUCH_FORMAT = /^\d+×\s*\S+\s+→undefined$/;
  const SUSPICIOUS_FORMAT = /→/;  // 包含 →但格式异常
  const malformed = [];
  const recognized = [];

  for (const line of touchedApis) {
    if (!line || !line.trim) continue;  // 过滤 null/undefined 和非字符串
    const trimmed = line.trim();
    if (!trimmed) continue;  // 空行忽略

    if (FULL_TOUCH_FORMAT.test(trimmed)) {
      // 符合完整格式,放进 recognized 供后续比对
      recognized.push(trimmed);
    } else if (SUSPICIOUS_FORMAT.test(trimmed)) {
      // 包含 → 但格式不完整,说明可能是格式变异或尾部垃圾
      malformed.push(line);
    } else if (trimmed.includes('undefined')) {
      // 包含 undefined 但不含 →,可能是格式完全变了(如"window.foo = undefined")
      malformed.push(line);
    }
    // 其他行(不含 → 也不含 undefined)视为无关,忽略
  }

  // 再从 recognized 里挑 →undefined 的做基线比对
  const undefinedHits = recognized
    .map((l) => l.replace(/^\d+×\s*/, '').replace(/\s*→undefined$/, '').trim());

  const novel = [...new Set(undefinedHits)].filter((a) => !known.has(a));

  // 如果 malformed 非空,说明垫片格式可能变了 —— 这是严重问题,区别对待
  const ok = novel.length === 0 && malformed.length === 0;
  let message;
  if (malformed.length > 0) {
    message = '⚠️ 垫片 report() 的输出格式可能已变更,预警机制失效。请检查 runtime/bom-shim.js 的 report() 实现。无法识别的行:\n' +
              malformed.map((m) => '  - ' + m).join('\n');
  } else if (novel.length > 0) {
    message = '引擎触达了基线之外的未实现宿主 API(很可能导致静默黑屏):\n' +
              novel.map((a) => '  - ' + a).join('\n') +
              '\n请在 runtime/bom-shim.js 中实现它们,或确认引擎有降级分支后加入基线。';
  } else {
    message = '垫片覆盖完整,无新增未实现 API';
  }

  return {
    ok,
    novel,
    malformed,
    message,
  };
}

module.exports = { assertShimCoverage };
