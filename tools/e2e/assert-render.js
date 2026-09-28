'use strict';

/**
 * 断言页面上报的像素与期望颜色一致。
 *
 * 页面侧必须在 surface.flush() 之后、同一个 JS turn 内调用 gl.readPixels,
 * 并以 `PIXEL|<name>|r,g,b,a` 的形式 console.log 出来。
 * 绝不能用截图:开发者工具的 screenshot API 抓不到 GPU 合成层,WebGL 恒为全黑。
 */
function assertPixels(reported, expected, tolerance) {
  const tol = tolerance == null ? 3 : tolerance;
  const map = {};
  for (const line of reported) {
    const [name, rgba] = line.split('|');
    map[name] = rgba.split(',').map(Number);
  }
  const failures = [];
  for (const name of Object.keys(expected)) {
    const got = map[name];
    if (!got) { failures.push(`${name}: 没有上报像素`); continue; }
    const want = expected[name];
    const off = want.some((v, i) => Math.abs(v - got[i]) > tol);
    if (off) failures.push(`${name}: 期望 ${want.join(',')} 实际 ${got.join(',')}`);
    if (got.every((v) => v === 0)) {
      failures.push(`${name}: 全零 —— 很可能读得太晚(preserveDrawingBuffer 默认 false,` +
                    `readPixels 必须紧贴 flush)`);
    }
  }
  return { ok: failures.length === 0, failures };
}

module.exports = { assertPixels };
