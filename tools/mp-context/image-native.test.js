'use strict';
// 图片原生解码路径(image.js 文件头"原生解码"):微信 canvas.createImage 解码,
// 原生图片对象交给 CanvasKit 的 MakeLazyImageFromTextureSource;离屏 2d(cacheWidth /
// toByteData)用 wx 2d 离屏画布取像素;失败回退 wasm;同一份字节共用一次解码;解码交付限流。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');

const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

const JPEG = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
const GIF = () => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);

function fakeSk(ck, w, h, id) {
  return {
    id, width: () => w, height: () => h,
    isDeleted() { return !!this.dead; },
    delete() { ck.deleted++; this.dead = true; },
  };
}
// 假 CanvasKit:任何非空字节都能 wasm 解码成 64×48(用来观察回退)
function fakeCK(opts = {}) {
  const ck = { decoded: 0, deleted: 0, lazy: [], made: [], seq: 100, surfaces: [] };
  ck.MakeImageFromEncoded = (bytes) => {
    ck.decoded++;
    if (opts.wasmFailFor && opts.wasmFailFor(bytes)) return null;
    const sk = fakeSk(ck, 64, 48, ck.decoded);
    if (opts.clone) sk.clone = () => { ck.cloned = (ck.cloned || 0) + 1; return fakeSk(ck, 64, 48, 'c' + ck.cloned); };
    return sk;
  };
  ck.MakeLazyImageFromTextureSource = (src, info) => {
    ck.lazy.push({ src, info });
    const obj = { lazyOf: src, info, dead: false };
    obj.delete = () => { obj.dead = true; ck.lazyDeleted = (ck.lazyDeleted || 0) + 1; };
    return obj;
  };
  ck.MakeImage = (info, px, rowBytes) => { ck.made.push({ info, px, rowBytes }); return fakeSk(ck, info.width, info.height, ++ck.seq); };
  ck.XYWHRect = (x, y, w, h) => [x, y, x + w, y + h];
  ck.FilterMode = { Linear: 'fl' }; ck.MipmapMode = { Linear: 'ml', None: 'mn' }; ck.ClipOp = { Intersect: 'i' };
  ck.ColorType = { RGBA_8888: 'rgba' }; ck.AlphaType = { Unpremul: 'unpremul', Premul: 'premul' }; ck.ColorSpace = { SRGB: 'srgb' };
  ck.TRANSPARENT = 'transparent';
  ck.MakeSurface = (w, h) => {
    const s = { w, h, draws: [] };
    const canvas = {
      drawImageRectOptions: (img, src, dst, fm, mm) => s.draws.push({ img, src, dst, fm, mm }),
      readPixels: (x, y, info) => new Uint8Array(info.width * info.height * 4).fill(0x7f),
      clear() {}, save() {}, restore() {}, clipRect() {},
    };
    s.getCanvas = () => canvas;
    s.makeImageSnapshot = () => fakeSk(ck, w, h, ++ck.seq);
    s.dispose = () => {};
    ck.surfaces.push(s);
    return s;
  };
  return ck;
}

/**
 * 给 mp-context 的 wx / canvas 节点补上原生解码用到的 API。
 * [o.loadResult](src) → { w, h } | 'error' | 'never'(不回调)
 * [o.draw2d] 'ok' | 'throw' | 'blank' | 'mixThrow'(WebGL 图片画 2d 抛错,2d 自己的图片可以)
 */
function nativeEnv(c, o = {}) {
  const log = { created: [], created2d: [], written: [], unlinked: [], draws: [], mkdir: 0, rmdir: 0 };
  const makeImage = (bucket, kind) => () => {
    const img = { kind, onload: null, onerror: null, width: 0, height: 0 };
    let src = '';
    Object.defineProperty(img, 'src', {
      get: () => src,
      set(v) {
        src = v;
        const r = (o.loadResult || (() => ({ w: 640, h: 480 })))(v);
        if (r === 'never') return;
        setTimeout(() => {
          if (r === 'error') { img.onerror && img.onerror({ errMsg: 'load fail' }); return; }
          img.width = r.w; img.height = r.h;
          img.onload && img.onload();
        }, 1);
      },
    });
    bucket.push(img);
    return img;
  };
  c.canvas.createImage = makeImage(log.created, 'gl');
  const fsFiles = new Map();
  c.wx.env = { USER_DATA_PATH: 'wxfile://usr' };
  c.wx.getFileSystemManager = () => ({
    writeFile({ filePath, data, success, fail }) {
      log.written.push(filePath);
      if (o.writeFail) { setTimeout(() => fail({ errMsg: 'writeFile:fail no space' }), 0); return; }
      fsFiles.set(filePath, data);
      setTimeout(success, 0);
    },
    unlink({ filePath }) { log.unlinked.push(filePath); fsFiles.delete(filePath); },
    mkdirSync() { log.mkdir++; },
    rmdirSync() { log.rmdir++; },
    readFileSync(filePath) { return fsFiles.get(filePath) || null; },
  });
  c.wx.createOffscreenCanvas = (opt) => {
    assert.strictEqual(opt.type, '2d');
    const oc = { width: opt.width, height: opt.height };
    oc.createImage = makeImage(log.created2d, '2d');
    oc.getContext = (t) => (t === '2d' ? {
      clearRect() {},
      drawImage(img, ...a) {
        log.draws.push({ img, a });
        if (o.draw2d === 'throw') throw new Error('drawImage: invalid image');
        if (o.draw2d === 'mixThrow' && img.kind !== '2d') throw new Error('drawImage: image from webgl canvas');
      },
      getImageData(x, y, w, h) {
        const data = new Uint8ClampedArray(w * h * 4);
        if (o.draw2d !== 'blank') data.fill(200);
        return { width: w, height: h, data };
      },
    } : null);
    return oc;
  };
  return { log, fsFiles };
}

function setup(o = {}) {
  const c = createMpContext();
  const CK = fakeCK(o);
  const env = nativeEnv(c, o);
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({
    canvas: c.canvas, width: 366, height: 249, dpr: 3, CK,
    nativeImage: { mode: o.mode, maxTotalBytes: o.maxTotalBytes, timeoutMs: o.timeoutMs },
  });
  const { routeImageElements } = c.requireModule(path.join(RT, 'canvaskit-loader.js'));
  routeImageElements(CK, shim.images);
  return { c, CK, shim, w: shim.window, doc: shim.document, log: env.log, fsFiles: env.fsFiles };
}

function newImg(env, buf) {
  const url = env.w.URL.createObjectURL(new env.w.Blob([buf]));
  const img = env.doc.createElement('img');
  img.src = url;
  return { img, url };
}
async function decoded(env, bytes) {
  const r = newImg(env, bytes.buffer);
  await r.img.decode();
  return r;
}

function captureConsole(fn) {
  const out = { warn: [], error: [] };
  const ow = console.warn, oe = console.error;
  console.warn = (...a) => out.warn.push(a.join(' '));
  console.error = (...a) => out.error.push(a.join(' '));
  return Promise.resolve().then(fn).finally(() => { console.warn = ow; console.error = oe; }).then((v) => ({ v, out }));
}

test('JPEG 走原生:字节写临时文件 → 画布 createImage,宽高取自原生图片,不做 wasm 解码', async () => {
  const env = setup();
  const { img } = await decoded(env, JPEG());
  assert.strictEqual(env.CK.decoded, 0, '不走 wasm');
  assert.strictEqual(env.log.created.length, 1);
  assert.strictEqual(img.naturalWidth, 640);
  assert.strictEqual(img.naturalHeight, 480);
  assert.strictEqual(img.complete, true);
  assert.match(env.log.written[0], /^wxfile:\/\/usr\/mpf-img\/.+\.jpg$/);
  assert.strictEqual(env.log.created[0].src, env.log.written[0]);
  assert.strictEqual(env.log.rmdir, 1, '首次使用清掉上次运行残留的临时目录');
  assert.strictEqual(env.shim.images.nativeMode, 'file');
});

test('MakeLazyImageFromTextureSource:原生图片对象原样交给 CanvasKit 原实现(引擎的 info 透传)', async () => {
  const env = setup();
  const { img } = await decoded(env, PNG());
  const info = { width: 640, height: 480, alphaType: 'premul' };
  const sk = env.CK.MakeLazyImageFromTextureSource(img, info);
  assert.strictEqual(env.CK.lazy.length, 1);
  assert.strictEqual(env.CK.lazy[0].src, env.log.created[0], '交出去的是微信原生图片,不是垫片的 <img>');
  assert.strictEqual(env.CK.lazy[0].info, info);
  assert.strictEqual(sk.lazyOf, env.log.created[0]);
  // 可重复请求(引擎每次 getNextFrame 都要一份),每次都是新的惰性 SkImage
  env.CK.MakeLazyImageFromTextureSource(img, info);
  assert.strictEqual(env.CK.lazy.length, 2);
  assert.strictEqual(env.CK.decoded, 0);
});

test('dataurl 模式:src 为 base64 data URL,不写文件', async () => {
  const env = setup({ mode: 'dataurl' });
  await decoded(env, JPEG());
  assert.strictEqual(env.log.written.length, 0);
  assert.match(env.log.created[0].src, /^data:image\/jpeg;base64,/);
  assert.strictEqual(env.shim.images.nativeMode, 'dataurl');
});

test('GIF(及其他非 JPEG/PNG)照旧走 wasm,不创建原生图片', async () => {
  const env = setup();
  const { img } = await decoded(env, GIF());
  assert.strictEqual(env.CK.decoded, 1);
  assert.strictEqual(env.log.created.length, 0);
  assert.strictEqual(img.naturalWidth, 64);
});

test('cacheWidth 缩放:原生图片经 wx 2d 离屏画布缩放取像素 → MakeImage → 画进 SoftCanvas', async () => {
  const env = setup();
  const { img } = await decoded(env, JPEG());
  const oc = new env.shim.self.OffscreenCanvas(320, 240);
  oc.getContext('2d').drawImage(img, 0, 0, 640, 480, 0, 0, 320, 240);
  assert.strictEqual(env.CK.decoded, 0, '不回退 wasm');
  assert.strictEqual(env.log.draws.length, 1);
  assert.strictEqual(env.log.draws[0].img, env.log.created[0]);
  assert.deepStrictEqual(env.log.draws[0].a, [0, 0, 640, 480, 0, 0, 320, 240]);
  assert.strictEqual(env.CK.made.length, 1);
  const m = env.CK.made[0];
  assert.strictEqual(m.info.width, 320);
  assert.strictEqual(m.info.height, 240);
  assert.strictEqual(m.info.alphaType, 'unpremul', 'getImageData 是非预乘');
  assert.strictEqual(m.rowBytes, 320 * 4);
  const bitmap = oc.transferToImageBitmap();
  const sk = env.shim.images.takeImage(bitmap);
  assert.ok(sk, 'ImageBitmap 可交给引擎');
  assert.strictEqual(sk.width(), 320);
  assert.strictEqual(env.CK.deleted, 1, '中间的光栅 SkImage 画完即 delete');
});

test('toByteData:原生图片画到 2d <canvas>(原尺寸)再 getImageData', async () => {
  const env = setup();
  const { img } = await decoded(env, JPEG());
  const cv = env.doc.createElement('canvas');
  cv.width = 640; cv.height = 480;
  const g = cv.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, 640, 480);
  assert.strictEqual(d.data.length, 640 * 480 * 4);
  assert.deepStrictEqual(env.log.draws[0].a, [0, 0, 640, 480, 0, 0, 640, 480]);
  assert.strictEqual(env.CK.decoded, 0);
});

test('2d 画不出 WebGL 画布的图片(抛错):当次回退 wasm 按字节解码,warn 一次;之后每张图另加载一份 2d 图片', async () => {
  const env = setup({ draw2d: 'mixThrow' });
  const { out } = await captureConsole(async () => {
    const { img } = await decoded(env, JPEG());
    const oc = new env.shim.self.OffscreenCanvas(32, 24);
    oc.getContext('2d').drawImage(img, 0, 0, 640, 480, 0, 0, 32, 24);
    assert.strictEqual(env.CK.decoded, 1, '回退 wasm(字节在 revoke 前后都保留)');
    const s = env.CK.surfaces[0];
    assert.strictEqual(s.draws.length, 1);
    // 第二张:双图模式,2d 画布也 createImage 一份,缩放用它
    const two = await decoded(env, PNG());
    assert.strictEqual(env.log.created2d.length, 1);
    const oc2 = new env.shim.self.OffscreenCanvas(16, 12);
    oc2.getContext('2d').drawImage(two.img, 0, 0, 640, 480, 0, 0, 16, 12);
    assert.strictEqual(env.CK.decoded, 1, '双图模式下不再回退');
    assert.strictEqual(env.log.draws[env.log.draws.length - 1].img, env.log.created2d[0]);
  });
  assert.strictEqual(out.warn.length, 1, 'warn 只一次');
  assert.match(out.warn[0], /2d 离屏画布失败/);
});

test('2d 画出整块全透明:视为画不出,回退 wasm(结果正确优先)', async () => {
  const env = setup({ draw2d: 'blank' });
  await captureConsole(async () => {
    const { img } = await decoded(env, JPEG());
    const oc = new env.shim.self.OffscreenCanvas(32, 24);
    oc.getContext('2d').drawImage(img, 0, 0, 640, 480, 0, 0, 32, 24);
  });
  assert.strictEqual(env.CK.decoded, 1);
  assert.strictEqual(env.CK.made.length, 0);
});

test('revoke 之后 toByteData 仍可回退 wasm(原生图片的字节保留到元素回收)', async () => {
  const env = setup({ draw2d: 'throw' });
  await captureConsole(async () => {
    const { img, url } = await decoded(env, JPEG());
    env.w.URL.revokeObjectURL(url);
    const cv = env.doc.createElement('canvas');
    cv.width = 640; cv.height = 480;
    cv.getContext('2d').drawImage(img, 0, 0);
  });
  assert.strictEqual(env.CK.decoded, 1);
});

test('原生加载失败:回退 wasm 并 warn 一次;连续失败 3 次后不再尝试原生', async () => {
  const env = setup({ loadResult: () => 'error' });
  const { out } = await captureConsole(async () => {
    for (let i = 0; i < 4; i++) {
      const { img } = await decoded(env, JPEG());
      assert.strictEqual(img.naturalWidth, 64, '回退 wasm 仍能出图');
    }
  });
  assert.strictEqual(env.log.created.length, 3, '第 4 张直接走 wasm');
  assert.strictEqual(env.CK.decoded, 4);
  assert.strictEqual(out.warn.length, 1);
  assert.match(out.warn[0], /原生图片解码失败,回退 wasm 解码:加载失败/);
  assert.strictEqual(env.log.unlinked.length, 3, '失败的临时文件立即删除');
});

test('M4:图片本身损坏(原生 onerror 且 wasm 也解不出)不计入连续失败次数,不会误停用原生解码', async () => {
  const CORRUPT = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xc0]);
  const env = setup({ loadResult: () => 'error', wasmFailFor: (b) => b[b.length - 1] === 0xc0 });
  await captureConsole(async () => {
    for (let i = 0; i < 5; i++) {
      await assert.rejects(decoded(env, CORRUPT()));
    }
  });
  assert.strictEqual(env.log.created.length, 5, '5 张坏图都真的尝试过原生(没有被误计数停用)');
  await captureConsole(async () => {
    const { img } = await decoded(env, JPEG());
    assert.strictEqual(img.naturalWidth, 64, '正常图片原生失败(API/平台问题)后仍回退 wasm 成功');
  });
  assert.strictEqual(env.log.created.length, 6, '第 6 张(正常图片)仍然尝试了原生——没被前面 5 张坏图计数停用');
});

test('writeFile 失败 / 图片尺寸为 0:同样回退 wasm', async () => {
  const a = setup({ writeFail: true });
  await captureConsole(async () => { const { img } = await decoded(a, JPEG()); assert.strictEqual(img.naturalWidth, 64); });
  assert.strictEqual(a.log.created.length, 0);
  const b = setup({ loadResult: () => ({ w: 0, h: 0 }) });
  await captureConsole(async () => { const { img } = await decoded(b, JPEG()); assert.strictEqual(img.naturalWidth, 64); });
});

test('同一份字节(同一 ArrayBuffer 构造的两个 Blob,即 instantiateImageCodecWithSize 的两遍)只原生解码一次', async () => {
  const env = setup();
  const buf = JPEG().buffer;
  const a = newImg(env, buf);
  const b = newImg(env, buf);
  await Promise.all([a.img.decode(), b.img.decode()]);
  assert.strictEqual(env.log.created.length, 1);
  assert.strictEqual(env.log.written.length, 1);
  assert.strictEqual(b.img.naturalWidth, 640);
  env.CK.MakeLazyImageFromTextureSource(a.img, {});
  env.CK.MakeLazyImageFromTextureSource(b.img, {});
  assert.strictEqual(env.CK.lazy[0].src, env.CK.lazy[1].src, '两遍共用同一个原生图片');
  // 解完之后第二遍才来(引擎先 getNextFrame 拿宽高、再建第二个 codec)也命中
  const c = newImg(env, buf);
  await c.img.decode();
  assert.strictEqual(env.log.created.length, 1);
});

test('同一份字节走 wasm 时也只解一次:各元素拿 clone 出的句柄', async () => {
  const env = setup({ clone: true });
  const buf = GIF().buffer;
  const a = newImg(env, buf);
  await a.img.decode();
  const b = newImg(env, buf);
  await b.img.decode();
  assert.strictEqual(env.CK.decoded, 1);
  const s1 = env.CK.MakeLazyImageFromTextureSource(a.img, {});
  const s2 = env.CK.MakeLazyImageFromTextureSource(b.img, {});
  assert.notStrictEqual(s1, s2);
  assert.match(String(s1.id), /^c/);
});

test('内容不同的同一 ArrayBuffer(长度/指纹不符)不会误用缓存', async () => {
  const env = setup();
  const u8 = JPEG();
  const a = newImg(env, u8.buffer);
  await a.img.decode();
  u8[5] = 99;
  const b = newImg(env, u8.buffer);
  await b.img.decode();
  assert.strictEqual(env.log.created.length, 2);
});

test('限流:多张 wasm 解码每个时间片只解一张(中间让出给 rAF)', async () => {
  const env = setup();
  const imgs = [0, 1, 2, 3].map(() => newImg(env, GIF().buffer).img);
  const ps = imgs.map((i) => i.decode());
  await ps[0];
  assert.strictEqual(env.CK.decoded, 1, '第一张交付时后面的还没解');
  await Promise.all(ps);
  assert.strictEqual(env.CK.decoded, 4);
});

test('限流:原生解码完成后的交付每个时间片最多 3 张', async () => {
  const env = setup();
  const imgs = [0, 1, 2, 3, 4].map(() => newImg(env, JPEG().buffer).img);
  const done = [];
  const ps = imgs.map((i, k) => i.decode().then(() => done.push(k)));
  await ps[0];
  await Promise.resolve();
  assert.ok(done.length <= 3, '首片最多 3 张,实际 ' + done.length);
  await Promise.all(ps);
  assert.strictEqual(done.length, 5);
});

test('I1:引擎反复对同一个原生图片对象请求/丢弃惰性 SkImage(逐帧重新绑定纹理)——delete 一份之后仍能再请求到新的一份,不报错', async () => {
  // 真机上观察到的行为:引擎不是"解码一次、用到永远持有同一个 CkImage"，
  // 而是可能每次要画都重新问原生图片对象要一份新的惰性 SkImage、画完就
  // delete 掉上一份——没有真正意义上的"最后一次"。原生图片对象与它的临时
  // 文件不能因为某一份 SkImage 被 delete 就清空/删掉,否则下一次请求会失败
  // (曾经复现:[mp-flutter] 原生图片已释放...无法再次生成图像 → ImageCodecException)。
  const env = setup();
  const { img } = await decoded(env, JPEG());
  const info = {};
  const native = env.log.created[0];
  const file = env.log.written[0];
  for (let i = 0; i < 5; i++) {
    const sk = env.CK.MakeLazyImageFromTextureSource(img, info);
    assert.strictEqual(sk.lazyOf, native, '第 ' + i + ' 次请求仍拿到同一个原生图片对象');
    sk.delete();
    assert.strictEqual(native.src, file, '原生图片对象/文件都还在(不跟单份 SkImage 的 delete 绑定)');
    assert.strictEqual(env.log.unlinked.length, 0);
  }
  // 之后仍能正常用它画图(cacheWidth 缩放走 2d 离屏画布,不受之前几次 delete 影响)
  const oc = new env.shim.self.OffscreenCanvas(32, 24);
  oc.getContext('2d').drawImage(img, 0, 0, 640, 480, 0, 0, 32, 24);
  assert.strictEqual(env.CK.decoded, 0, '仍走原生,不回退 wasm');
  assert.strictEqual(env.CK.made.length, 1);
});

test('I2:文件生命周期跟图片对象绑定,不按数量/LRU 提前删(哪怕从没交给过引擎)', async () => {
  const env = setup();
  for (let i = 0; i < 50; i++) await decoded(env, JPEG());
  assert.strictEqual(env.log.written.length, 50);
  assert.strictEqual(env.log.unlinked.length, 0, '一张都没有因为数量被提前删');
});

test('I2:总字节数顶到上限时,只淘汰已交给引擎("上传")过、最久未用的文件;仍不够就这张直接走 wasm,不计入 NATIVE_FAIL_LIMIT', async () => {
  // 单张 JPEG() 固定 9 字节;上限设成刚好放得下 3 张。
  const env = setup({ maxTotalBytes: 27 });
  const a = await decoded(env, JPEG());
  env.CK.MakeLazyImageFromTextureSource(a.img, {});   // 标记"已上传"
  const b = await decoded(env, JPEG());
  env.CK.MakeLazyImageFromTextureSource(b.img, {});
  const c = await decoded(env, JPEG());
  // 三张都已写入且都"上传"过,总字节数刚好顶满;第四张需要腾地方,
  // 淘汰最久未用的(第一张)的文件,不算原生失败。
  const d = await decoded(env, JPEG());
  assert.strictEqual(env.log.written.length, 4);
  assert.deepStrictEqual(env.log.unlinked, [env.log.written[0]]);
  assert.strictEqual(d.img.naturalWidth, 640, '腾出地方后第四张仍走原生');
  assert.strictEqual(env.CK.decoded, 0, '没有因为淘汰而回退 wasm');
});

test('I2:淘汰完仍超总字节上限:这一张直接走 wasm,不计入连续失败次数(仍能继续走原生)', async () => {
  const env = setup({ maxTotalBytes: 5 });   // 比单张 9 字节还小,谁都放不下
  const { out } = await captureConsole(async () => {
    for (let i = 0; i < 5; i++) {
      const { img } = await decoded(env, JPEG());
      assert.strictEqual(img.naturalWidth, 64, '放不下时直接走 wasm');
    }
  });
  assert.strictEqual(env.log.created.length, 0, '一次原生 createImage 都没发生');
  assert.strictEqual(env.log.written.length, 0, '没写过临时文件');
  assert.strictEqual(env.CK.decoded, 5);
  assert.strictEqual(out.warn.length, 0, '容量兜底是预期内行为,不告警');
});

test('统计回调:native-decode 带同步耗时与等待耗时;失败有 native-fallback', async () => {
  const env = setup();
  const stats = [];
  env.shim.images.setStatsSink((e) => stats.push(e));
  const { img } = await decoded(env, JPEG());
  const d = stats.find((e) => e.type === 'native-decode');
  assert.ok(d, '有 native-decode');
  assert.strictEqual(typeof d.syncMs, 'number');
  assert.strictEqual(typeof d.waitMs, 'number');
  assert.strictEqual(d.w, 640);
  const oc = new env.shim.self.OffscreenCanvas(32, 24);
  oc.getContext('2d').drawImage(img, 0, 0, 640, 480, 0, 0, 32, 24);
  assert.ok(stats.some((e) => e.type === 'native-2d' && e.w === 32));
});

test('不传 nativeImage(单测/关闭):完全是原来的 wasm 路径', async () => {
  const c = createMpContext();
  const CK = fakeCK();
  nativeEnv(c);
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({ canvas: c.canvas, width: 366, height: 249, dpr: 3, CK });
  assert.strictEqual(shim.images.nativeMode, null);
  const url = shim.window.URL.createObjectURL(new shim.window.Blob([JPEG().buffer]));
  const img = shim.document.createElement('img');
  img.src = url;
  await img.decode();
  assert.strictEqual(CK.decoded, 1);
});
