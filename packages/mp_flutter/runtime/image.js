'use strict';
/**
 * 图片解码(Phase 3 Task 4):让引擎的"静态图"解码路径在小程序里走通。
 *
 * 引擎(CanvasKit 渲染器)在没有 ImageDecoder(WebCodecs)时:动图走 wasm
 * (CkAnimatedImage);静态 PNG/JPEG 走
 *   new Blob([bytes]) → URL.createObjectURL(blob) → <img>.src = url → img.decode()
 *   → 读 naturalWidth/naturalHeight → CanvasKit.MakeLazyImageFromTextureSource(img, info)
 * 小程序没有 Blob/URL/<img>。这里的替代实现:
 *   - 最小 Blob(只把各部分拼成字节)与 URL.createObjectURL/revokeObjectURL(登记表)
 *   - <img> 元素的 decode() 用 CanvasKit 自带的 wasm 解码器 MakeImageFromEncoded 真解码,
 *     成功才 resolve(并给出 naturalWidth/naturalHeight),失败 reject 并带出可诊断信息
 *   - canvaskit-loader 的 routeImageElements 把这类元素的 MakeLazyImageFromTextureSource
 *     路由到同一份解码结果(不做纹理上传,不需要任何 wx 图片 API)
 *
 * SkImage 所有权:decode() 解出的 SkImage 先由我们持有(pending);第一次
 * MakeLazyImageFromTextureSource 时原样交给引擎 —— 引擎把它包进 CkImage,
 * dispose 时由引擎 delete。若在交出之前 URL 就被撤销(或元素重复 decode),
 * 由我们 delete。之后再次请求(引擎重复 getNextFrame)按字节重新解码一份新的
 * 交给引擎。revokeObjectURL 后释放持有的字节。
 *
 * 离屏 2d 画布(runtime-gaps Task 3):引擎的 cacheWidth/cacheHeight 缩放
 * (CkResizingCodec._scaleImageUsingDomCanvas:new OffscreenCanvas → 2d drawImage →
 * transferToImageBitmap → MakeLazyImageFromImageBitmap)与 toByteData
 * (readPixelsFromDomImageSource:<canvas>.getContext('2d') → drawImage →
 * getImageData / toDataURL)都要 2d 画布。小程序的 canvas 节点是 WebGL 画布,
 * 这里不用任何 wx 画布:SoftCanvas 用 CanvasKit 的 CPU 光栅 surface(MakeSurface)
 * 实现引擎用到的那几个 2d 调用,drawImage 的源是上面 decode 出的 SkImage 或
 * 本模块造的假 ImageBitmap(持有一份快照 SkImage)。
 *   - surface 在画布尺寸被改(引擎事后置 0×0)时 dispose(连同 malloc 的像素)
 *   - 假 ImageBitmap 的 SkImage 交给引擎(MakeLazyImageFromImageBitmap)后归引擎;
 *     未交出前 close() 由我们 delete
 * 只实现引擎用到的 drawImage / getImageData / clearRect / toDataURL /
 * transferToImageBitmap;其余 2d 调用不存在(直接 TypeError)。
 *
 * 原生解码(opts.native,boot 默认开):iOS 小程序的 wasm 没有 JIT,
 * MakeImageFromEncoded 解一张 640×640 JPEG 要 64–100ms,新图进屏整帧卡住。
 * 静态 JPEG/PNG 改由微信原生解码:
 *   字节 → 临时文件(USER_DATA_PATH/mpf-img,异步 writeFile)→ 承载页 WebGL
 *   画布节点的 createImage() → onload → naturalWidth/naturalHeight 成功后
 *   立即释放 st.bytes(按需时从临时文件读回,见 ensureBytes);
 *   MakeLazyImageFromTextureSource 把这个原生图片对象原样交给 CanvasKit 自己
 *   的实现(画的时候 texImage2D 直接上传,不经 wasm 解码、不经 JS 像素拷贝)。
 *   引擎可能反复对同一个原生图片对象请求/丢弃惰性 SkImage(比如逐帧重新
 *   绑定纹理),没有真正意义上的"最后一次"——原生图片对象与它的临时文件
 *   不跟某一份 SkImage 的 delete() 绑定生命周期,一直留到总字节数顶到
 *   NATIVE_MAX_TOTAL_BYTES 时才兜底淘汰已经"上传"过且最久未用的文件(I2);
 *   文件被淘汰后原生图片对象本身依然可用(纹理上传不需要文件),只有需要
 *   按字节回退(2d 确认失败 / M5)且文件已被淘汰时才会退化为解不出。
 *   离屏 2d 画布(cacheWidth 缩放 / toByteData)以原生图片为源时,用
 *   wx.createOffscreenCanvas({type:'2d'}) 原生缩放 + getImageData,再
 *   CK.MakeImage 成光栅 SkImage 画进 SoftCanvas。微信文档说不能混用 WebGL
 *   画布与 2d 画布创建的图片:先试直接画(模拟器可以),画不出(抛错)就切到
 *   "双图"模式——之后每张图同时用 2d 离屏画布的 createImage 再加载一份;
 *   画出"整块全透明"时先用 wasm 解一遍源图确认是不是真的全透明(M5,避免
 *   把本来就透明的真图误判成 2d 坏);确认失败(2d 真画不出)当次回退 wasm
 *   按字节解码(字节按需从临时文件读回)。
 *   原生路径失败(API 不可用、加载失败/超时、尺寸为 0)回退 wasm 解码并
 *   warn 一次;只有 API/平台错误计入 NATIVE_FAIL_LIMIT(图片本身损坏——原生
 *   onerror 且 wasm 也解不出——不计数),连续计满后本次运行不再尝试原生。
 *   GIF/WebP/BMP 等其余格式照旧走 wasm。
 */

/** 点名报错:console.error 一份(release 模式下引擎不打印图片错误),返回 Error 由调用方抛出。 */
function namedError(msg) {
  const e = new Error('mp-flutter: ' + msg);
  try { console.error('[mp-flutter] ' + e.message); } catch (_) { /* 无 console 不影响抛出 */ }
  return e;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const two = i + 1 < bytes.length;
    const n = (bytes[i] << 16) | ((two ? bytes[i + 1] : 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (two ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}

/** 画布尺寸:同浏览器,非负整数(负数/NaN 当 0)。 */
function toDim(v) {
  const n = Math.floor(Number(v));
  return n > 0 && isFinite(n) ? n : 0;
}

/** embind 对象是否已 delete(没有 isDeleted 的假对象视为存活)。 */
function isDead(sk) {
  if (!sk) return true;
  try { return typeof sk.isDeleted === 'function' && sk.isDeleted(); } catch (e) { return true; }
}

function isArrayBuffer(p) {
  // 跨 realm 的 ArrayBuffer 不是 instanceof ArrayBuffer,按内部标签判断
  return p instanceof ArrayBuffer || Object.prototype.toString.call(p) === '[object ArrayBuffer]';
}

function partBytes(p, Encoder) {
  if (isArrayBuffer(p)) return new Uint8Array(p);
  if (ArrayBuffer.isView(p)) return new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
  if (p && typeof p === 'object' && blobBytesOf(p)) return blobBytesOf(p);
  return new Encoder().encode(String(p));
}

// Blob → 字节。模块级,Blob 可跨 createImageSupport 实例拼接
const blobBytes = new WeakMap();
function blobBytesOf(b) { return blobBytes.get(b) || null; }

function hexHead(bytes) {
  return Array.prototype.map.call(bytes.subarray(0, 8), (b) => (b < 16 ? '0' : '') + b.toString(16)).join(' ');
}

const NATIVE_FAIL_LIMIT = 3;
/**
 * 解码调度:解码完成后的交付(以及 wasm 解码本身)排队,按时间片放行,
 * 每片最多 SLOT_UNITS 个单位(原生交付 1、wasm 解码 SLOT_UNITS),片间隔 SLOT_MS。
 * 首屏同时进来十几张图时,引擎在 decode() 之后同步做的 MakeLazy/缩放/建 CkImage
 * 被摊到多个任务里,中间让出给 rAF,不再堆成一个几百 ms 的长任务。
 */
const SLOT_UNITS = 3;
const SLOT_MS = 16;
/**
 * 同一份字节的解码结果缓存:instantiateImageCodecWithSize(带 cacheWidth /
 * getTargetSize)先完整解一遍拿宽高、再按目标尺寸解第二遍,两遍的 Blob 都由
 * 同一个 ArrayBuffer(list.buffer)构造。按来源 ArrayBuffer(+长度与抽样指纹
 * 校验)共用一次解码。条目 DECODE_CACHE_TTL_MS 后或超过 DECODE_CACHE_MAX 条时淘汰。
 */
const DECODE_CACHE_MAX = 8;
const DECODE_CACHE_TTL_MS = 3000;
const NATIVE_TIMEOUT_MS = 8000;
/**
 * 临时文件总字节上限兜底(I2):引擎可能反复对同一个原生图片对象请求/丢弃
 * 惰性 SkImage(没有真正意义上的"最后一次",见文件头"原生解码"),文件不
 * 跟某一份 SkImage 的 delete() 绑定生命周期,不按数量/LRU 提前删——否则
 * 可能删掉一张引擎还会再次用到的图的文件(纹理上传本身不需要文件,但 2d
 * 确认/回退需要)。只有总字节数顶到这个上限时才兜底淘汰已经交给过引擎
 * ("上传")过、且最久未用的文件;淘汰完仍超限,这一张直接放弃原生、走
 * wasm(不计入 NATIVE_FAIL_LIMIT——不是原生解码坏了)。
 */
const NATIVE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** 原生解码只接静态 JPEG / PNG(按签名判断);其余返回 null 走 wasm。 */
function sniffNative(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

function ownBuffer(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer : bytes.slice().buffer;
}

/**
 * 微信原生图片解码。[n.node] 承载页 WebGL 画布节点(createImage);[n.wx];
 * [n.mode] 'file'(默认,临时文件)| 'dataurl'(base64 data URL);
 * [n.onStat] 统计回调(perf-hud);[n.statActive] 统计是否开着(false 时不
 * 构造统计对象,只做一次布尔判断);[n.warn] 一次性告警。
 */
function createNativeDecoder(n) {
  const wxo = n.wx, node = n.node;
  const now = n.now || Date.now;
  const timeoutMs = n.timeoutMs || NATIVE_TIMEOUT_MS;
  const maxTotalBytes = n.maxTotalBytes || NATIVE_MAX_TOTAL_BYTES;
  const mode = n.mode === 'dataurl' ? 'dataurl' : 'file';
  const sid = now().toString(36);
  let fs = null, dir = null, fseq = 0;
  // 每个临时文件的元信息(I2):bytes(占用)、deleted(所属图片已 delete,
  // 随时可淘汰)、uploaded(已交给过引擎)、lastUsed(用于挑"最久未用")。
  const fileMeta = new Map();
  let totalBytes = 0;
  let fails = 0, disabled = false;
  let oc2d = null, dual = false, broken2d = false;

  function available() {
    return !disabled && !!node && typeof node.createImage === 'function' && !!wxo;
  }

  /** 按需从临时文件读回字节(I1/M5):图片对象仍在但 bytes 已释放时,现读一次。 */
  function readFile(file) {
    if (!fs || !file || typeof fs.readFileSync !== 'function') return null;
    try {
      const raw = fs.readFileSync(file);
      return raw ? new Uint8Array(raw) : null;
    } catch (e) { return null; }
  }

  /** 图片对象已 delete(I1):文件立即释放(不用等淘汰),更新总字节数。 */
  function releaseFile(file) {
    if (!file) return;
    const m = fileMeta.get(file);
    fileMeta.delete(file);
    if (m) totalBytes -= m.bytes;
    unlink(file);
  }

  /** 图片交给过引擎一次("上传"):供淘汰时判断是否可以放心删文件(I2)。 */
  function markUploaded(file) {
    const m = fileMeta.get(file);
    if (m) { m.uploaded = true; m.lastUsed = now(); }
  }

  /** 总字节超限时的兜底淘汰:只淘汰已上传过、最久未用的;不够就放弃。 */
  function evictFor(need) {
    if (totalBytes + need <= maxTotalBytes) return true;
    const candidates = Array.from(fileMeta.entries())
      .filter(([, m]) => m.uploaded)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [file] of candidates) {
      releaseFile(file);
      if (totalBytes + need <= maxTotalBytes) return true;
    }
    return totalBytes + need <= maxTotalBytes;
  }

  function ensureDir() {
    if (dir) return dir;
    fs = wxo.getFileSystemManager();
    if (!fs || typeof fs.writeFile !== 'function') throw new Error('没有 FileSystemManager.writeFile');
    const base = wxo.env && wxo.env.USER_DATA_PATH;
    if (!base) throw new Error('没有 wx.env.USER_DATA_PATH');
    const d = base + '/mpf-img';
    try { fs.rmdirSync(d, true); } catch (e) { /* 不存在则忽略:清掉上次运行残留 */ }
    try { fs.mkdirSync(d, true); } catch (e) { /* 已存在则忽略,下面 writeFile 失败会回退 */ }
    dir = d;
    return dir;
  }

  function unlink(f) {
    try { fs.unlink({ filePath: f, fail() {} }); } catch (e) { /* 忽略 */ }
  }

  /** 源地址:{ src(Promise<string>), file, syncMs }。 */
  function makeSrc(bytes, kind) {
    const t0 = now();
    if (mode === 'dataurl') {
      const src = 'data:image/' + kind + ';base64,' + wxo.arrayBufferToBase64(ownBuffer(bytes));
      return { src: Promise.resolve(src), file: null, syncMs: now() - t0 };
    }
    const d = ensureDir();
    if (!evictFor(bytes.length)) {
      // 淘汰已上传/已 delete 的文件后仍超总字节上限:这一张直接放弃原生,
      // 走 wasm——不算原生解码失败(I2)。
      const e = new Error('临时文件总字节数达到上限(' + maxTotalBytes + '),放弃原生解码走 wasm');
      e.mpfCountable = false;
      e.mpfSilent = true;
      return { src: Promise.reject(e), file: null, syncMs: now() - t0 };
    }
    const file = d + '/' + sid + '-' + (++fseq) + (kind === 'jpeg' ? '.jpg' : '.png');
    const src = new Promise((resolve, reject) => {
      fs.writeFile({
        filePath: file, data: ownBuffer(bytes),
        success: () => resolve(file),
        fail: (e) => {
          const err = new Error('writeFile 失败:' + ((e && e.errMsg) || e));
          // 空间不足:同样不算原生失败(I2)——设备存储状态问题,不是原生
          // 解码机制本身坏了。
          if (/no space|space not enough|enospc|空间不足/i.test(String((e && e.errMsg) || e))) {
            err.mpfCountable = false;
          }
          reject(err);
        },
      });
    });
    return { src, file, syncMs: now() - t0 };
  }

  function loadImage(factory, src) {
    return new Promise((resolve, reject) => {
      const img = factory.createImage();
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('加载超时 ' + timeoutMs + 'ms')); } }, timeoutMs);
      img.onload = () => {
        if (done) return;
        done = true; clearTimeout(timer);
        const w = img.width | 0, h = img.height | 0;
        if (!w || !h) reject(new Error('尺寸为 0'));
        else resolve(img);
      };
      img.onerror = (e) => {
        if (done) return;
        done = true; clearTimeout(timer);
        reject(new Error('加载失败:' + ((e && (e.errMsg || e.message)) || e)));
      };
      img.src = src;
    });
  }

  function get2d(w, h) {
    if (!oc2d) {
      oc2d = wxo.createOffscreenCanvas({ type: '2d', width: w, height: h });
      if (!oc2d || typeof oc2d.getContext !== 'function') { oc2d = null; throw new Error('没有 2d 离屏画布'); }
    } else if (oc2d.width !== w || oc2d.height !== h) {
      oc2d.width = w; oc2d.height = h;
    }
    return oc2d;
  }

  /** 解码一张:resolve { img, img2d, w, h, file };reject 表示应回退 wasm。 */
  function load(bytes, kind) {
    const t0 = now();
    let sync = 0;
    let s;
    try { s = makeSrc(bytes, kind); } catch (e) { return Promise.reject(e); }
    sync += s.syncMs;
    return s.src.then((src) => {
      const t1 = now();
      const p = [loadImage(node, src)];
      if (dual && !broken2d) {
        try { p.push(loadImage(oc2d || get2d(1, 1), src).catch(() => null)); } catch (e) { /* 双图可选 */ }
      }
      sync += now() - t1;
      return Promise.all(p);
    }).then((imgs) => {
      const t2 = now();
      const img = imgs[0];
      const r = { img, img2d: imgs[1] || null, w: img.width | 0, h: img.height | 0, file: s.file };
      // 登记总字节数(I2):不按数量/LRU 提前删,只有 evictFor 在总字节数
      // 顶到上限时才淘汰已经交给过引擎("上传")过、且最久未用的文件。
      if (s.file) {
        fileMeta.set(s.file, { bytes: bytes.length, uploaded: false, lastUsed: now() });
        totalBytes += bytes.length;
      }
      fails = 0;
      sync += now() - t2;
      if (n.onStat && n.statActive()) n.onStat({ type: 'native-decode', syncMs: sync, waitMs: now() - t0 - sync, bytes: bytes.length, w: r.w, h: r.h });
      return r;
    }, (e) => {
      if (s.file) releaseFile(s.file);
      throw e;
    });
  }

  /**
   * 原生路径失败一次:warn 一次。[countable] 是否计入 NATIVE_FAIL_LIMIT——
   * 只有 API/平台错误才算(M4);图片本身损坏(错误上带 mpfCountable=false,
   * 或调用方确认 wasm 也解不出)、临时文件总字节超限、写文件空间不足都不算。
   * 错误对象上的 mpfCountable / mpfSilent 优先于调用方传入的 countable。
   */
  function fail(e, countable) {
    const forced = e && e.mpfCountable === false;
    if (countable && !forced) {
      fails++;
      if (fails >= NATIVE_FAIL_LIMIT) disabled = true;
    }
    const silent = e && e.mpfSilent;
    if (!silent) {
      if (n.warn) n.warn('原生图片解码失败,回退 wasm 解码:' + ((e && e.message) || e));
      if (n.onStat && n.statActive()) {
        n.onStat({ type: 'native-fallback', reason: String((e && e.message) || e), countable: !!(countable && !forced) });
      }
    }
  }

  /** 2d 画布确认画不出(抛错,或调用方确认过"整块全透明"不是源图本身的):记一次,警告一次。 */
  function markBroken(isImg2d, detail) {
    if (isImg2d) broken2d = true;        // 2d 自己的图片也画不出:2d 路径不可用
    else dual = true;                    // WebGL 画布的图片不能画到 2d:之后同时加载一份 2d 图片
    if (n.warn) n.warn('原生图片画到 2d 离屏画布失败(' + (detail || '整块全透明') + '),本次回退 wasm'
      + (broken2d ? ';之后缩放/读像素都走 wasm' : ';之后每张图另用 2d 画布加载一份'));
  }

  /**
   * 把原生图片 [sx,sy,sw,sh] 缩放画成 dw×dh,返回 { data }(非预乘 RGBA);
   * 画不出(抛错)返回 null(调用方回退 wasm,已记为 2d 不可用)。
   *
   * M5:整块 alpha 全 0 时不在这里下结论——可能是 2d 真画不出,也可能源图
   * 本来就是全透明的真图;返回 { data, maybeBlank: true },由调用方(拿得到
   * CanvasKit)用 wasm 解一遍源图确认后再决定是否 markBroken。
   */
  function pixels(st, sx, sy, sw, sh, dw, dh) {
    if (broken2d) return null;
    const t0 = now();
    const src = st.img2d || st.img;
    let data = null;
    try {
      const g = get2d(dw, dh).getContext('2d');
      g.clearRect(0, 0, dw, dh);
      g.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
      data = g.getImageData(0, 0, dw, dh).data;
    } catch (e) {
      markBroken(!!st.img2d, (e && e.message) || e);
      return null;
    }
    if (n.onStat && n.statActive()) n.onStat({ type: 'native-2d', ms: now() - t0, w: dw, h: dh });
    let any = false;
    for (let i = 3; i < data.length; i += 4) { if (data[i]) { any = true; break; } }
    return any ? { data } : { data, maybeBlank: true, img2d: !!st.img2d };
  }

  return {
    available, load, fail, pixels, markBroken, readFile, markUploaded, releaseFile,
    get mode() { return mode; }, get dual() { return dual; },
  };
}

/**
 * [opts.getCK] 取 CanvasKit 对象(装垫片时 CanvasKit 已加载);[opts.TextEncoder] 编码字符串部分。
 * [opts.native] { node, wx, mode? }:给出则静态 JPEG/PNG 走微信原生解码(见文件头)。
 */
function createImageSupport(opts) {
  const getCK = opts.getCK;
  const Encoder = opts.TextEncoder || TextEncoder;
  let statSink = null;          // perf-hud:setStatsSink 注入
  let warned = false;
  const nat = opts.native ? createNativeDecoder(Object.assign({}, opts.native, {
    statActive: () => !!statSink,
    onStat: (e) => { try { statSink(e); } catch (_) { /* 统计失败不影响解码 */ } },
    warn: (msg) => {
      if (warned) return;
      warned = true;
      try { console.warn('[mp-flutter] ' + msg + '(只提示一次)'); } catch (_) { /* 忽略 */ }
    },
  })) : null;
  const blobSource = new WeakMap(); // Blob → 构造它的唯一 ArrayBuffer(单段 ArrayBuffer 构造时)
  const decodeCache = new Map();    // ArrayBuffer → { len, fp, promise, res, timer }
  const queue = [];
  let queueTimer = null;

  function drain() {
    queueTimer = null;
    let used = 0;
    while (queue.length && (used === 0 || used + queue[0].units <= SLOT_UNITS)) {
      const job = queue.shift();
      used += job.units;
      try { job.fn(); } catch (e) { /* 单个任务异常不影响后续 */ }
    }
    if (queue.length) queueTimer = setTimeout(drain, SLOT_MS);
  }
  function enqueue(units, fn) {
    queue.push({ units, fn });
    if (queueTimer == null) queueTimer = setTimeout(drain, 0);
  }

  function fingerprint(bytes) {
    const n = bytes.length;
    let h = n;
    const step = Math.max(1, Math.floor(n / 61));
    for (let i = 0; i < n; i += step) h = (Math.imul(h, 31) + bytes[i]) | 0;
    if (n) h = (Math.imul(h, 31) + bytes[n - 1]) | 0;
    return h;
  }
  function dropEntry(key) {
    const e = decodeCache.get(key);
    if (!e) return;
    decodeCache.delete(key);
    clearTimeout(e.timer);
    retire(e);
  }
  /** 缓存持有的原件 SkImage 延到下一个宏任务再 delete:已拿到 Promise 的等待者先在微任务里 clone 完。 */
  function retire(e) {
    e.dead = true;
    if (e.res && e.res.sk && e.res.shared) {
      const sk = e.res.sk;
      setTimeout(() => { try { sk.delete(); } catch (_) { /* 已删除则忽略 */ } }, 0);
    }
  }
  /**
   * 取/建同一份字节的解码,Promise 解出 { native } 或 { sk, shared }(shared:
   * 原件归缓存,使用者各自 clone;不能 clone 时只给第一个使用者)。key 为 null 不缓存。
   */
  function sharedDecode(key, bytes, start) {
    if (key) {
      const e = decodeCache.get(key);
      if (e && e.len === bytes.length && e.fp === fingerprint(bytes)) return e.promise;
      if (e) dropEntry(key);
    }
    const promise = start();
    if (!key) return promise.then((r) => (r && r.sk ? { sk: r.sk, shared: false } : r));
    const e = { len: bytes.length, fp: fingerprint(bytes), promise, res: null, timer: null, dead: false };
    decodeCache.set(key, e);
    while (decodeCache.size > DECODE_CACHE_MAX) dropEntry(decodeCache.keys().next().value);
    promise.then((r) => {
      e.res = r;
      if (e.dead) { retire(e); return; }
      e.timer = setTimeout(() => { if (decodeCache.get(key) === e) dropEntry(key); }, DECODE_CACHE_TTL_MS);
      if (e.timer && typeof e.timer.unref === 'function') e.timer.unref();   // Node 单测:不拖住进程
    }, () => { if (decodeCache.get(key) === e) dropEntry(key); });
    return promise;
  }

  const urls = new Map();       // blob: 地址 → Blob
  const states = new WeakMap(); // <img> 元素 → { url, bytes, pending, given }
  const bitmaps = new WeakMap(); // 假 ImageBitmap → { sk, handed }
  const byUrl = new Map();      // blob: 地址 → Set<state>,撤销时释放
  let seq = 0;

  function Blob(parts, options) {
    if (!(this instanceof Blob)) throw new TypeError("Failed to construct 'Blob': Please use the 'new' operator");
    const chunks = Array.from(parts || [], (p) => partBytes(p, Encoder));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    chunks.forEach((c) => { out.set(c, off); off += c.length; });
    blobBytes.set(this, out);
    if (parts && parts.length === 1 && isArrayBuffer(parts[0])) blobSource.set(this, parts[0]);
    this.size = total;
    this.type = options && options.type ? String(options.type).toLowerCase() : '';
  }
  Blob.prototype.arrayBuffer = function () { return Promise.resolve(blobBytes.get(this).slice().buffer); };
  Blob.prototype.text = function () {
    const b = blobBytes.get(this);
    return Promise.resolve(new (opts.TextDecoder || TextDecoder)().decode(b));
  };

  function release(st) {
    if (st.pending) {
      try { st.pending.delete(); } catch (e) { /* 已删除则忽略 */ }
      st.pending = null;
    }
    // 原生图片:bytes 早已在解码成功那一刻释放(I1),revoke 不用再管;
    // 原生图片对象与它的临时文件不跟 blob: 地址撤销绑定,也不跟某一份
    // SkImage 的 delete() 绑定(引擎可能反复请求,没有真正意义上的
    // "最后一次"),文件只由 evictFor 在总字节数顶到上限时兜底淘汰(I2)。
    if (!st.native) st.bytes = null;
  }

  // 只提供静态方法;new URL(...) 小程序里没有可依赖的实现,明确报错
  function URL() {
    throw new TypeError('mp-flutter: 暂不支持 new URL()(仅提供 URL.createObjectURL/revokeObjectURL)');
  }
  URL.createObjectURL = function (blob) {
    if (!blobBytes.has(blob)) {
      throw new TypeError('mp-flutter: URL.createObjectURL 只支持 Blob');
    }
    const url = 'blob:mpf/' + (++seq);
    urls.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    const key = String(url);
    urls.delete(key);
    const set = byUrl.get(key);
    if (set) { set.forEach(release); byUrl.delete(key); }
  };

  function fail(reject, msg) {
    const e = new Error(msg);
    try { console.error('[mp-flutter] ' + msg); } catch (_) { /* 无 console 不影响 reject */ }
    reject(e);
  }

  /** 给 makeElement('img') 的元素(包代理之前)装上 <img> 的字段与 decode()。 */
  function initImageElement(el) {
    Object.assign(el, { src: '', crossOrigin: null, decoding: 'auto', complete: false, naturalWidth: 0, naturalHeight: 0 });
    el.decode = function () {
      const img = this;   // 经代理调用时即代理本身 —— 与引擎传给 MakeLazyImageFromTextureSource 的是同一对象
      return new Promise((resolve, reject) => {
        const url = String(img.src == null ? '' : img.src);
        const blob = urls.get(url);
        if (!blob) {
          return fail(reject, '<img>.decode 失败:只支持由 URL.createObjectURL 生成且未撤销的 blob: 地址(src='
            + url.slice(0, 200) + ')');
        }
        const bytes = blobBytes.get(blob);
        const adopt = (st) => {
          const prev = states.get(img);
          if (prev) release(prev);   // 重复 decode:释放上一份未交出的
          states.set(img, st);
          if (!byUrl.has(url)) byUrl.set(url, new Set());
          byUrl.get(url).add(st);
          img.naturalWidth = st.width;
          img.naturalHeight = st.height;
          img.complete = true;
          resolve();
        };
        const kind = nat && nat.available() ? sniffNative(bytes) : null;
        const start = () => (kind
          ? nat.load(bytes, kind).then((r) => ({ native: r }), (e) =>
              // M4:先看 wasm 解不解得出同一份字节再定"算不算原生失败"——wasm
              // 也解不出说明是图片本身坏了(不计数),wasm 解得出说明确实是
              // 原生这条路(API/平台)出了问题(计数)。真正的"不算失败"场景
              // (总字节超限、写文件空间不足)已由 e.mpfCountable=false 强制,
              // nat.fail 内部会优先认它。
              wasmDecode().then((wr) => { nat.fail(e, true); return wr; }, (we) => { nat.fail(e, false); throw we; }))
          : wasmDecode());
        sharedDecode(blobSource.get(blob) || null, bytes, start).then((r) => {
          if (r.native) {
            const n = r.native;
            // I1:原生加载成功后立即释放 st.bytes(file 模式下按需时从临时
            // 文件读回,见 ensureBytes);dataurl 模式没有文件可读回,继续保留。
            const keepBytes = nat.mode !== 'file';
            // 同一份字节(cacheWidth 的两遍解码)共用同一份原生解码结果 n——
            // n 可能被多个 <img> 元素(多个 st)共享,记一份引用(res)方便
            // ensureBytes/markUploaded 找到共享的文件路径。
            enqueue(1, () => adopt({
              url, bytes: keepBytes ? bytes : null, pending: null, given: [], native: n.img, native2d: n.img2d,
              width: n.w, height: n.h, res: n,
            }));
            return;
          }
          let sk = null;
          if (r.shared) sk = r.sk.clone();            // 原件归缓存,各自一份句柄(同一份像素)
          else if (!r.claimed) { r.claimed = true; sk = r.sk; } else {
            enqueue(SLOT_UNITS, () => {               // 不能 clone(只有测试替身):另解一份
              const again = decodeNow();
              if (again.sk) adopt({ url, bytes, pending: again.sk, given: [], native: null, width: again.sk.width(), height: again.sk.height() });
              else fail(reject, again.error);
            });
            return;
          }
          adopt({ url, bytes, pending: sk, given: [], native: null, width: sk.width(), height: sk.height() });
        }, (e) => fail(reject, (e && e.message) || String(e)));

        /** 同步 wasm 解码:{ sk } 或 { error }。 */
        function decodeNow() {
          const CK = getCK && getCK();
          if (!CK || typeof CK.MakeImageFromEncoded !== 'function') {
            return { error: '<img>.decode 失败:CanvasKit 未就绪(没有 MakeImageFromEncoded)' };
          }
          let sk = null;
          try { sk = CK.MakeImageFromEncoded(bytes); } catch (e) { sk = null; }
          if (!sk) {
            return { error: '<img>.decode 失败:CanvasKit 无法解码图片(' + bytes.length + ' 字节,头部 '
              + hexHead(bytes) + ';可能不是受支持的图片格式或数据损坏)' };
          }
          return { sk };
        }
        /** 排队的 wasm 解码(每个时间片最多一张):Promise<{ sk, shared }>。 */
        function wasmDecode() {
          return new Promise((res, rej) => {
            enqueue(SLOT_UNITS, () => {
              const r = decodeNow();
              if (r.sk) res({ sk: r.sk, shared: typeof r.sk.clone === 'function' });
              else rej(new Error(r.error));
            });
          });
        }
      });
    };
    return el;
  }

  function needCK(where) {
    const CK = getCK && getCK();
    if (!CK || typeof CK.MakeSurface !== 'function') throw namedError(where + ' 失败:CanvasKit 未就绪(没有 MakeSurface)');
    return CK;
  }

  /**
   * 原生图片:字节可能已在解码成功后释放(I1),这里按需从临时文件读回一次
   * 并缓存到 st.bytes(dataurl 模式没有临时文件,st.bytes 本来就一直留着)。
   */
  function ensureBytes(st) {
    if (st.bytes) return st.bytes;
    if (st.native && st.res && st.res.file && nat) {
      const b = nat.readFile(st.res.file);
      if (b) { st.bytes = b; return b; }
    }
    return null;
  }

  /**
   * drawImage 的源 → 借用一份 SkImage(不转移所有权)。<img>:未交出的 pending,
   * 或交给引擎且仍存活的某一份(同一图片各份像素相同),都没有则按字节临时解码
   * (temp,用完 delete);假 ImageBitmap:它持有的快照。
   */
  function borrow(src) {
    const st = src != null && typeof src === 'object' ? states.get(src) : null;
    if (st) {
      if (!isDead(st.pending)) return { sk: st.pending, temp: false };
      st.given = st.given.filter((g) => !isDead(g));
      if (st.given.length) return { sk: st.given[st.given.length - 1], temp: false };
      const bytes = ensureBytes(st);
      if (bytes) {
        const sk = getCK().MakeImageFromEncoded(bytes);
        if (sk) return { sk, temp: true };
      }
      return null;
    }
    const b = src != null && typeof src === 'object' ? bitmaps.get(src) : null;
    if (b && !isDead(b.sk)) return { sk: b.sk, temp: false };
    return null;
  }

  /** 把 sk 画到新的 w×h 光栅 surface 上并取快照(拷贝/缩放用);surface 当场释放。 */
  function redraw(CK, sk, w, h) {
    const surface = CK.MakeSurface(w, h);
    if (!surface) return null;
    try {
      surface.getCanvas().drawImageRectOptions(sk, CK.XYWHRect(0, 0, sk.width(), sk.height()),
        CK.XYWHRect(0, 0, w, h), CK.FilterMode.Linear, CK.MipmapMode.Linear, null);
      return surface.makeImageSnapshot();
    } finally {
      surface.dispose();
    }
  }

  /**
   * M5:确认 [sk] 缩放到 [sx,sy,sw,sh]→pw×ph 是不是真的整块透明(源图本来
   * 就是全透明的真图),还是我们自己没画对。CanvasKit 没就绪 / 建不出光栅
   * surface 时确认不了,保守当"是全透明"(不判 2d 坏)。
   */
  function isBlank(CK, sk, sx, sy, sw, sh, pw, ph) {
    if (!CK || typeof CK.MakeSurface !== 'function') return true;
    const surface = CK.MakeSurface(pw, ph);
    if (!surface) return true;
    try {
      surface.getCanvas().drawImageRectOptions(sk, CK.XYWHRect(sx, sy, sw, sh), CK.XYWHRect(0, 0, pw, ph),
        CK.FilterMode.Linear, CK.MipmapMode.None, null);
      const px = surface.getCanvas().readPixels(0, 0, {
        width: pw, height: ph, colorType: CK.ColorType.RGBA_8888,
        alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB,
      });
      if (!px) return true;
      for (let i = 3; i < px.length; i += 4) { if (px[i]) return false; }   // 有非透明像素:确实不是全透明
      return true;
    } finally {
      surface.dispose();
    }
  }

  /**
   * 源是原生解码的 <img>:原生 2d 离屏画布缩放取像素 → 光栅 SkImage → 画进本画布。
   * 返回 false 表示没画(不是原生图片,或原生 2d 画不出),调用方走 wasm 路径。
   *
   * M5:原生 2d 画出"整块全透明"时不直接当成画不出——borrow() 一份 wasm
   * 解出的源图确认:确认过真的不是全透明才 markBroken(并直接用这份 sk
   * 画掉,不用调用方再兜底解一次);确认不了或确实是全透明源图,就仍然用
   * 原生给出的(正确的)全透明像素,不判 2d 坏。
   */
  function drawNative(src, a, ensure) {
    const st = src != null && typeof src === 'object' ? states.get(src) : null;
    if (!st || !st.native || !nat) return false;
    const sw0 = st.width, sh0 = st.height;
    let sx = 0, sy = 0, sw = sw0, sh = sh0, dx, dy, dw, dh;
    if (a.length >= 8) [sx, sy, sw, sh, dx, dy, dw, dh] = a;
    else if (a.length >= 4) [dx, dy, dw, dh] = a;
    else { [dx, dy] = a; dw = sw0; dh = sh0; }
    const pw = Math.max(1, Math.round(+dw)), ph = Math.max(1, Math.round(+dh));
    const c = ensure('drawImage');
    if (!c) return true;   // 画布 0×0:同浏览器,什么也不画
    const r = nat.pixels({ img: st.native, img2d: st.native2d }, +sx, +sy, +sw, +sh, pw, ph);
    if (!r) return false;
    const CK = getCK();
    if (r.maybeBlank) {
      const b = borrow(src);
      if (b) {
        const reallyBlank = isBlank(CK, b.sk, +sx, +sy, +sw, +sh, pw, ph);
        if (!reallyBlank) {
          nat.markBroken(r.img2d, '整块全透明(源图 wasm 解码确认非透明)');
          try {
            c.drawImageRectOptions(b.sk, CK.XYWHRect(+sx, +sy, +sw, +sh), CK.XYWHRect(+dx || 0, +dy || 0, +dw, +dh),
              CK.FilterMode.Linear, CK.MipmapMode.Linear, null);
          } finally {
            if (b.temp) { try { b.sk.delete(); } catch (e) { /* 忽略 */ } }
          }
          return true;
        }
        if (b.temp) { try { b.sk.delete(); } catch (e) { /* 忽略 */ } }
      }
      // 拿不到字节确认,或确认过源图真的是全透明:用原生给出的全透明像素继续
    }
    const sk = CK.MakeImage({
      width: pw, height: ph, colorType: CK.ColorType.RGBA_8888,
      alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB,
    }, r.data, pw * 4);
    if (!sk) return false;
    try {
      c.drawImageRectOptions(sk, CK.XYWHRect(0, 0, pw, ph), CK.XYWHRect(+dx || 0, +dy || 0, +dw, +dh),
        CK.FilterMode.Linear, CK.MipmapMode.None, null);
    } finally {
      try { sk.delete(); } catch (e) { /* 忽略 */ }
    }
    return true;
  }

  function makeBitmap(sk, w, h) {
    const bitmap = {
      width: w, height: h,
      close() {
        const b = bitmaps.get(bitmap);
        if (b && b.sk && !b.handed) { try { b.sk.delete(); } catch (e) { /* 已删除则忽略 */ } }
        if (b) b.sk = null;
        bitmap.width = 0; bitmap.height = 0;
      },
    };
    bitmaps.set(bitmap, { sk, handed: false });
    return bitmap;
  }

  /**
   * 引擎用到的那部分 2d 画布,像素在 CanvasKit 的 CPU 光栅 surface 里。
   * surface 懒创建;改尺寸即丢弃(浏览器改尺寸也清空画布)。
   */
  function SoftCanvas(w, h) {
    let width = toDim(w), height = toDim(h);
    let surface = null, canvas = null, ctx2d = null;
    const drop = () => {
      if (surface) { try { surface.dispose(); } catch (e) { /* 已释放则忽略 */ } }
      surface = null; canvas = null;
    };
    const ensure = (where) => {
      if (surface) return canvas;
      if (!width || !height) return null;
      const CK = needCK(where);
      surface = CK.MakeSurface(width, height);
      if (!surface) throw namedError(where + ' 失败:无法创建 ' + width + '×' + height + ' 的离屏光栅画布');
      canvas = surface.getCanvas();
      return canvas;
    };
    const snapshot = (where) => (ensure(where) ? surface.makeImageSnapshot() : null);

    this.getWidth = () => width;
    this.getHeight = () => height;
    this.setWidth = (v) => { width = toDim(v); drop(); };
    this.setHeight = (v) => { height = toDim(v); drop(); };
    this.release = drop;
    this.isLive = () => surface != null;

    this.getContext = function (type) {
      if (type !== '2d') return null;
      if (ctx2d) return ctx2d;
      ctx2d = {
        drawImage(src, ...a) {
          if (drawNative(src, a, ensure)) return;
          const b = borrow(src);
          if (!b) {
            throw namedError('离屏 2d 画布的 drawImage 只支持已解码的图片(本框架的 <img> / ImageBitmap)');
          }
          try {
            const sw0 = b.sk.width(), sh0 = b.sk.height();
            let sx = 0, sy = 0, sw = sw0, sh = sh0, dx, dy, dw, dh;
            if (a.length >= 8) [sx, sy, sw, sh, dx, dy, dw, dh] = a;
            else if (a.length >= 4) [dx, dy, dw, dh] = a;
            else { [dx, dy] = a; dw = sw0; dh = sh0; }
            const c = ensure('drawImage');
            if (!c) return;
            const CK = getCK();
            c.drawImageRectOptions(b.sk, CK.XYWHRect(+sx, +sy, +sw, +sh), CK.XYWHRect(+dx || 0, +dy || 0, +dw, +dh),
              CK.FilterMode.Linear, CK.MipmapMode.Linear, null);
          } finally {
            if (b.temp) { try { b.sk.delete(); } catch (e) { /* 忽略 */ } }
          }
        },
        clearRect(x, y, cw, ch) {
          if (!surface) return;   // 从未画过 = 全透明
          if (x <= 0 && y <= 0 && x + cw >= width && y + ch >= height) { canvas.clear(getCK().TRANSPARENT); return; }
          const CK = getCK();
          canvas.save();
          canvas.clipRect(CK.XYWHRect(x, y, cw, ch), CK.ClipOp.Intersect, false);
          canvas.clear(CK.TRANSPARENT);
          canvas.restore();
        },
        /**
         * 同浏览器:非预乘(straight)RGBA。
         *
         * M4:CanvasKit readPixels 抛错/返回空(如 surface 已因某种原因失效)不能
         * 让离屏 surface 就此半死不活地留着——drop() 掉(dispose 连同 malloc 的
         * 像素),下次调用 ensure() 会按当前 width/height 重新创建一个干净的。
         */
        getImageData(x, y, iw, ih) {
          iw = toDim(iw); ih = toDim(ih);
          const data = new Uint8ClampedArray(iw * ih * 4);
          const c = iw && ih ? ensure('getImageData') : null;
          if (c) {
            try {
              const CK = getCK();
              const px = c.readPixels(x | 0, y | 0, {
                width: iw, height: ih, colorType: CK.ColorType.RGBA_8888,
                alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB,
              });
              if (!px) throw namedError('getImageData 失败:CanvasKit readPixels 返回空');
              data.set(px);
            } catch (e) {
              drop();
              throw e;
            }
          }
          return { width: iw, height: ih, data, colorSpace: 'srgb' };
        },
      };
      return ctx2d;
    };

    /**
     * 仅支持 PNG(引擎只用默认参数)。
     *
     * M4:encodeToBytes 抛错/返回空同样要 drop() 离屏 surface(见 getImageData
     * 注释),不能留着一个编码失败过的 surface 供下次调用复用。
     */
    this.toDataURL = function () {
      if (!width || !height) return 'data:,';
      const snap = snapshot('toDataURL');
      let bytes = null;
      try {
        bytes = snap.encodeToBytes();
        if (!bytes) throw namedError('toDataURL 失败:CanvasKit 无法编码 PNG');
      } catch (e) {
        drop();
        throw e;
      } finally {
        snap.delete();
      }
      return 'data:image/png;base64,' + base64(bytes);
    };

    this.transferToImageBitmap = function () {
      if (!width || !height) throw namedError('transferToImageBitmap 失败:画布尺寸为 0');
      const sk = snapshot('transferToImageBitmap');
      drop();   // 同浏览器:转移后画布回到全透明
      return makeBitmap(sk, width, height);
    };
  }

  /** self.OffscreenCanvas(引擎只用于 cacheWidth/cacheHeight 缩放)。 */
  function OffscreenCanvas(w, h) {
    if (!(this instanceof OffscreenCanvas)) throw new TypeError("Failed to construct 'OffscreenCanvas': Please use the 'new' operator");
    const sc = new SoftCanvas(w, h);
    Object.defineProperty(this, 'width', { get: sc.getWidth, set: sc.setWidth, enumerable: true });
    Object.defineProperty(this, 'height', { get: sc.getHeight, set: sc.setHeight, enumerable: true });
    this.getContext = (type) => sc.getContext(type);
    this.transferToImageBitmap = () => sc.transferToImageBitmap();
  }

  return {
    Blob, URL, initImageElement, SoftCanvas, OffscreenCanvas,
    /** perf-hud:原生解码统计回调(null 取消)。 */
    setStatsSink(fn) { statSink = typeof fn === 'function' ? fn : null; },
    /** 原生解码是否开启(诊断用)。 */
    get nativeMode() { return nat ? nat.mode : null; },
    /** 是否是本模块 decode 成功过的 <img> 元素,或本模块造的 ImageBitmap。 */
    owns: (src) => src != null && typeof src === 'object' && (states.has(src) || bitmaps.has(src)),
    /**
     * 交给引擎一份 SkImage(所有权归引擎)。首次交出 decode 时解好的那份;
     * 之后按字节重新解码;URL 已撤销(字节已释放)则 console.error 并返回 null
     * (引擎据此抛 ImageCodecException)。
     */
    takeImage(src, info, makeLazy) {
      const b = bitmaps.get(src);
      if (b) {
        if (isDead(b.sk)) {
          try { console.error('[mp-flutter] ImageBitmap 已 close,无法生成图像'); } catch (_) { /* 忽略 */ }
          return null;
        }
        if (!b.handed) { b.handed = true; return b.sk; }
        // 同一 ImageBitmap 再次请求:给引擎一份拷贝(原件已归上一个 CkImage)
        return redraw(getCK(), b.sk, b.sk.width(), b.sk.height());
      }
      const st = states.get(src);
      if (!st) return null;
      if (st.native) {
        // 原生图片原样交给 CanvasKit 自己的 MakeLazyImageFromTextureSource(画时
        // texImage2D 上传)。引擎可能反复对同一个原生图片对象请求/丢弃惰性
        // SkImage(逐帧重新绑定纹理等),这里不做引用计数——原生图片对象与它
        // 的临时文件一直留到 evictFor 按总字节数兜底淘汰(I2),纹理上传本身
        // 不需要文件,可以放心反复请求。
        if (typeof makeLazy !== 'function') return null;
        const raw = makeLazy(st.native, info || {
          width: st.width, height: st.height, colorType: getCK().ColorType.RGBA_8888,
          alphaType: getCK().AlphaType.Premul, colorSpace: getCK().ColorSpace.SRGB,
        });
        if (nat && st.res && st.res.file) nat.markUploaded(st.res.file);
        return raw;
      }
      let sk = null;
      if (st.pending) { sk = st.pending; st.pending = null; } else if (!st.bytes) {
        try { console.error('[mp-flutter] 图片的 blob: 地址已撤销,无法再次生成图像(' + st.url + ')'); } catch (_) { /* 忽略 */ }
        return null;
      } else sk = getCK().MakeImageFromEncoded(st.bytes);
      if (sk) st.given = st.given.filter((g) => !isDead(g)).concat([sk]);   // 借用登记(toByteData 的 drawImage 源)
      return sk;
    },
  };
}

module.exports = { createImageSupport, namedError, base64, sniffNative };
