'use strict';
/**
 * 同一份字体字节只解析一次(CanvasKit Typeface 复用)。
 *
 * 依据 Flutter 3.41.9 引擎源码(canvaskit/fonts.dart):
 *  · 每注册一批回退字体(`registerDownloadedFonts`)或业务 `loadFontFromList`,
 *    `_registerWithFontProvider()` 都新建一个 TypefaceFontProvider,把**迄今
 *    所有**已注册字体(清单字体 + 全部回退分片)逐个 `registerFont(bytes, family)`
 *    重新注册一遍;
 *  · CanvasKit 的 `registerFont` 内部是 `Typeface.MakeTypefaceFromData(bytes)`
 *    (拷进 wasm 堆 + FreeType 建 face,woff2 还要整份解压)→ `_registerFont`
 *    → `delete`;
 *  · 每个字体在此之前已经 `Typeface.MakeFreeTypeFaceFromData` 解析过一次。
 * 所以第 k 批注册要把前面所有字体再解析一遍,真机一批 43–48 次、每次约 9ms。
 *
 * 这里把 `Typeface.MakeTypefaceFromData` / `MakeFreeTypeFaceFromData` 换成
 * 按字节缓存的版本:键是底层 ArrayBuffer(+ 偏移/长度),同一份字节第二次
 * 起直接返回已解析 Typeface 的 `clone()`(embind 句柄共享同一个 sk_sp,调用方
 * `delete()` 只释放自己的句柄)。缓存里的主句柄常驻——引擎从不注销字体,
 * 字节本身也一直被引擎持有。registerFont 经 `g.Typeface.MakeTypefaceFromData`
 * 动态查找,换掉属性即生效。
 *
 * 只认 ArrayBuffer / TypedArray 入参;字节被改写的情况不存在(引擎拿到的是
 * 每次 fetch 新建的 buffer)。解析失败(返回 null)不缓存。
 */

// 不用 instanceof:wx API 可能交出别的 realm 的 ArrayBuffer
function isArrayBuffer(x) { return Object.prototype.toString.call(x) === '[object ArrayBuffer]'; }

function keyOf(data) {
  if (isArrayBuffer(data)) return { buf: data, sub: '0:' + data.byteLength };
  if (data && isArrayBuffer(data.buffer) && typeof data.byteOffset === 'number') {
    return { buf: data.buffer, sub: data.byteOffset + ':' + data.byteLength };
  }
  return null;
}

function byteLength(data) {
  return data && typeof data.byteLength === 'number' ? data.byteLength : 0;
}

/**
 * [opts.now]、[opts.onParse](可选,--perf-hud):每次真正解析时回调
 * `{ ms, bytes }`,命中缓存时回调 `{ hit: true, bytes }`。
 * 返回 `{ stats: { parses, hits }, uninstall() }`;CK 缺少这些 API 时返回 null。
 */
function installTypefaceMemo(CK, opts) {
  const o = opts || {};
  const TF = CK && CK.Typeface;
  if (!TF || typeof TF.MakeTypefaceFromData !== 'function') return null;
  const orig = TF.MakeTypefaceFromData;
  const origFree = TF.MakeFreeTypeFaceFromData;
  const now = o.now || (function () { return Date.now(); });
  const cache = typeof WeakMap === 'function' ? new WeakMap() : null;
  const stats = { parses: 0, hits: 0 };

  function memo(data) {
    const k = cache ? keyOf(data) : null;
    let slot = null;
    if (k) {
      slot = cache.get(k.buf);
      const master = slot && slot[k.sub];
      if (master && !(typeof master.isDeleted === 'function' && master.isDeleted())) {
        stats.hits++;
        if (o.onParse) { try { o.onParse({ hit: true, bytes: byteLength(data) }); } catch (e) { /* 忽略 */ } }
        return master.clone();
      }
    }
    const t0 = now();
    const tf = orig.call(TF, data);
    stats.parses++;
    if (o.onParse) { try { o.onParse({ ms: now() - t0, bytes: byteLength(data) }); } catch (e) { /* 忽略 */ } }
    if (!tf || !k || typeof tf.clone !== 'function') return tf;
    if (!slot) { slot = {}; cache.set(k.buf, slot); }
    slot[k.sub] = tf;
    return tf.clone();
  }

  TF.MakeTypefaceFromData = memo;
  // 上游把 MakeFreeTypeFaceFromData 定义成同一个函数的别名;不是别名时(版本变了)
  // 不去动它,避免把语义不同的入口也接过来
  const aliased = origFree === orig;
  if (aliased) TF.MakeFreeTypeFaceFromData = memo;
  return {
    stats: stats,
    uninstall: function () {
      TF.MakeTypefaceFromData = orig;
      if (aliased) TF.MakeFreeTypeFaceFromData = origFree;
    },
  };
}

module.exports = { installTypefaceMemo };
