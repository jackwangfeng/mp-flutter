const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMpContext } = require('./context');

const RT = path.resolve(__dirname, '../../packages/mp_flutter/runtime');

// 假 CanvasKit:MakeImageFromEncoded 以首字节 0x89(PNG 签名)为"可解码",返回 64×48 的假 SkImage。
// MakeSurface 给出记录调用的假光栅 surface:readPixels 按请求尺寸返回 0x7f 填充,
// 快照是 surface 尺寸的假 SkImage,encodeToBytes 返回固定字节。
function fakeSk(ck, w, h, id) {
  return {
    id, width: () => w, height: () => h,
    isDeleted() { return !!this.dead; },
    encodeToBytes() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47, w, h]); },
    delete() { ck.deleted++; this.dead = true; },
  };
}
function fakeCK() {
  const ck = { decoded: 0, deleted: 0, lazyOrig: [], surfaces: [], seq: 100 };
  ck.MakeImageFromEncoded = (bytes) => {
    ck.decoded++;
    if (!bytes || bytes[0] !== 0x89) return null;
    return fakeSk(ck, 64, 48, ck.decoded);
  };
  ck.MakeLazyImageFromTextureSource = (src) => { ck.lazyOrig.push(src); return 'orig'; };
  ck.XYWHRect = (x, y, w, h) => [x, y, x + w, y + h];
  ck.FilterMode = { Linear: 'fl' }; ck.MipmapMode = { Linear: 'ml' }; ck.ClipOp = { Intersect: 'i' };
  ck.ColorType = { RGBA_8888: 'rgba' }; ck.AlphaType = { Unpremul: 'unpremul' }; ck.ColorSpace = { SRGB: 'srgb' };
  ck.TRANSPARENT = 'transparent';
  ck.MakeSurface = (w, h) => {
    const s = { w, h, draws: [], reads: [], disposed: false };
    const canvas = {
      drawImageRectOptions: (img, src, dst, fm, mm, paint) => {
        assert.ok(!img.dead, 'drawImage 的源不能是已 delete 的 SkImage');
        s.draws.push({ img, src, dst, fm, mm, paint });
      },
      readPixels: (x, y, info) => { s.reads.push({ x, y, info }); return new Uint8Array(info.width * info.height * 4).fill(0x7f); },
      clear() {}, save() {}, restore() {}, clipRect() {},
    };
    s.getCanvas = () => canvas;
    s.makeImageSnapshot = () => fakeSk(ck, w, h, ++ck.seq);
    s.dispose = () => { s.disposed = true; };
    ck.surfaces.push(s);
    return s;
  };
  return ck;
}
const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

// 捕获 console.error(沙箱与宿主共用同一个 console 对象)
function captureErrors(fn) {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  return Promise.resolve().then(fn).finally(() => { console.error = orig; }).then((v) => ({ v, errs }));
}

// 经真实垫片装好:document.createElement('img') 得到的是 withRecord 代理
function setup() {
  const c = createMpContext();
  const CK = fakeCK();
  const bom = c.requireModule(path.join(RT, 'bom-shim.js'));
  const shim = bom.install({ canvas: c.canvas, width: 366, height: 249, dpr: 3, CK });
  const { routeImageElements } = c.requireModule(path.join(RT, 'canvaskit-loader.js'));
  routeImageElements(CK, shim.images);
  return { c, CK, shim, w: shim.window, doc: shim.document };
}

async function decodedImg(env, bytes) {
  const url = env.w.URL.createObjectURL(new env.w.Blob([bytes.buffer]));
  const img = env.doc.createElement('img');
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return { img, url };
}

test('Blob/URL 同时挂在 window 与 self 上', () => {
  const { w, shim } = setup();
  assert.strictEqual(typeof w.Blob, 'function');
  assert.strictEqual(shim.self.Blob, w.Blob);
  assert.strictEqual(shim.self.URL, w.URL);
  assert.strictEqual(typeof w.URL.createObjectURL, 'function');
  assert.strictEqual(typeof w.URL.revokeObjectURL, 'function');
});

test('Blob 拼接 ArrayBuffer / TypedArray / 字符串 / Blob 各部分', async () => {
  const { w } = setup();
  const inner = new w.Blob(['z']);
  const b = new w.Blob([new Uint8Array([1, 2]).buffer, new Uint8Array([9, 3, 4]).subarray(1), 'é', inner], { type: 'Image/PNG' });
  assert.strictEqual(b.size, 2 + 2 + 2 + 1);
  assert.strictEqual(b.type, 'image/png');
  assert.deepStrictEqual(Array.from(new Uint8Array(await b.arrayBuffer())), [1, 2, 3, 4, 0xc3, 0xa9, 0x7a]);
  assert.strictEqual(await new w.Blob(['你好']).text(), '你好');
});

test('createObjectURL 只接受 Blob;返回 blob: 地址', () => {
  const { w } = setup();
  const u = w.URL.createObjectURL(new w.Blob([PNG().buffer]));
  assert.match(u, /^blob:/);
  assert.notStrictEqual(w.URL.createObjectURL(new w.Blob([])), u);
  assert.throws(() => w.URL.createObjectURL({}), /只支持 Blob/);
  assert.throws(() => new w.URL('https://a.com'), /暂不支持 new URL/);
});

test('<img>.decode():wasm 真解码,naturalWidth/naturalHeight 取自解码结果', async () => {
  const env = setup();
  const { img } = await decodedImg(env, PNG());
  assert.strictEqual(img.naturalWidth, 64);
  assert.strictEqual(img.naturalHeight, 48);
  assert.strictEqual(img.complete, true);
  assert.strictEqual(env.CK.decoded, 1);
});

test('MakeLazyImageFromTextureSource:本模块的 <img> 路由到解码结果,所有权交给引擎', async () => {
  const env = setup();
  const { img } = await decodedImg(env, PNG());
  const first = env.CK.MakeLazyImageFromTextureSource(img, { width: 64, height: 48 });
  assert.strictEqual(first.id, 1, '首次交出 decode 时解好的那一份,不重复解码');
  assert.strictEqual(env.CK.decoded, 1);
  const again = env.CK.MakeLazyImageFromTextureSource(img, {});
  assert.notStrictEqual(again, first, '再次请求按字节重新解码一份新的(旧的归引擎,可能已被 delete)');
  assert.strictEqual(env.CK.decoded, 2);
  assert.strictEqual(env.CK.deleted, 0, '交给引擎的 SkImage 不由我们 delete');
  // 其他来源(非本模块 <img>)照旧走 CanvasKit 原实现
  const other = env.doc.createElement('img');
  assert.strictEqual(env.CK.MakeLazyImageFromTextureSource(other, {}), 'orig');
  assert.strictEqual(env.CK.MakeLazyImageFromTextureSource({ videoFrame: 1 }, {}), 'orig');
  assert.strictEqual(env.CK.lazyOrig.length, 2);
});

test('decode 失败:数据不可解码 → reject 且带字节数/头部,并 console.error', async () => {
  const env = setup();
  const url = env.w.URL.createObjectURL(new env.w.Blob([new Uint8Array([1, 2, 3]).buffer]));
  const img = env.doc.createElement('img');
  img.src = url;
  const { v, errs } = await captureErrors(() => img.decode().then(() => null, (e) => e));
  assert.ok(v instanceof Error || (v && v.message), '必须 reject');
  assert.match(v.message, /无法解码图片\(3 字节,头部 01 02 03/);
  assert.ok(errs.some((l) => /无法解码图片/.test(l)), 'console.error 应有诊断');
  assert.strictEqual(img.naturalWidth, 0);
  assert.strictEqual(env.CK.owns, undefined);
  assert.strictEqual(env.shim.images.owns(img), false, '失败的元素不走路由');
});

test('decode 失败:src 不是有效 blob: 地址 → reject 并点出 src', async () => {
  const env = setup();
  const img = env.doc.createElement('img');
  img.src = 'https://a.com/x.png';
  const { v } = await captureErrors(() => img.decode().then(() => null, (e) => e));
  assert.match(v.message, /只支持由 URL\.createObjectURL 生成且未撤销的 blob: 地址\(src=https:\/\/a\.com\/x\.png\)/);
});

test('decode 失败:URL 撤销后再 decode 也 reject', async () => {
  const env = setup();
  const url = env.w.URL.createObjectURL(new env.w.Blob([PNG().buffer]));
  env.w.URL.revokeObjectURL(url);
  const img = env.doc.createElement('img');
  img.src = url;
  const { v } = await captureErrors(() => img.decode().then(() => null, (e) => e));
  assert.match(v.message, /未撤销的 blob: 地址/);
});

test('revokeObjectURL:未交出的 SkImage 由我们 delete,字节释放,之后不能再生成图像', async () => {
  const env = setup();
  const { img, url } = await decodedImg(env, PNG());
  env.w.URL.revokeObjectURL(url);
  assert.strictEqual(env.CK.deleted, 1, '未交给引擎的那份必须 delete,否则 wasm 内存泄漏');
  const { v, errs } = await captureErrors(() => env.CK.MakeLazyImageFromTextureSource(img, {}));
  assert.strictEqual(v, null);
  assert.strictEqual(env.CK.decoded, 1, '字节已释放,不会再解码');
  assert.ok(errs.some((l) => /已撤销/.test(l)));
});

test('revokeObjectURL:已交给引擎的 SkImage 不再 delete(所有权在引擎)', async () => {
  const env = setup();
  const { img, url } = await decodedImg(env, PNG());
  const sk = env.CK.MakeLazyImageFromTextureSource(img, {});
  env.w.URL.revokeObjectURL(url);
  assert.strictEqual(env.CK.deleted, 0);
  assert.strictEqual(sk.dead, undefined);
});

test('同一元素重复 decode:释放上一份未交出的 SkImage', async () => {
  const env = setup();
  const { img } = await decodedImg(env, PNG());
  await img.decode();
  assert.strictEqual(env.CK.deleted, 1);
  assert.strictEqual(env.CK.MakeLazyImageFromTextureSource(img, {}).id, 2);
});

test('cacheWidth 缩放(引擎 _scaleImageUsingDomCanvas 流程):OffscreenCanvas → drawImage → ImageBitmap → SkImage 归引擎', async () => {
  const env = setup();
  const { img } = await decodedImg(env, PNG());
  const orig = env.CK.MakeLazyImageFromTextureSource(img, {});      // 引擎 CkImage 持有的那份
  assert.strictEqual(env.w.OffscreenCanvas, undefined, 'window.OffscreenCanvas 仍 undefined(光栅器探测不变)');
  const oc = new env.shim.self.OffscreenCanvas(32, 24);
  oc.getContext('2d').drawImage(img, 0, 0, 64, 48, 0, 0, 32, 24);
  const s = env.CK.surfaces[0];
  assert.deepStrictEqual([s.w, s.h], [32, 24]);
  assert.strictEqual(s.draws[0].img, orig, '借用引擎那份 SkImage,不重复解码');
  assert.deepStrictEqual(s.draws[0].src, [0, 0, 64, 48]);
  assert.deepStrictEqual(s.draws[0].dst, [0, 0, 32, 24]);
  assert.strictEqual(env.CK.decoded, 1);
  const bitmap = oc.transferToImageBitmap();
  assert.deepStrictEqual([bitmap.width, bitmap.height], [32, 24]);
  assert.ok(s.disposed, 'transfer 后 surface 释放');
  oc.width = 0; oc.height = 0;                                      // 引擎随后置 0×0
  const sk = env.CK.MakeLazyImageFromTextureSource(bitmap, 0, true); // MakeLazyImageFromImageBitmap
  assert.deepStrictEqual([sk.width(), sk.height()], [32, 24]);
  orig.delete();                                                    // 引擎 image.dispose() 原图
  // 缩放后的图做 toByteData:源是这个 ImageBitmap
  const cv = env.doc.createElement('canvas');
  cv.width = 32; cv.height = 24;
  const ctx2 = cv.getContext('2d');
  ctx2.drawImage(bitmap, 0, 0);
  assert.strictEqual(ctx2.getImageData(0, 0, 32, 24).data.length, 32 * 24 * 4);
  cv.width = 0; cv.height = 0;
  const deletedBefore = env.CK.deleted;
  bitmap.close();                                                   // CkImage dispose → ImageBitmapImageSource.close
  assert.strictEqual(env.CK.deleted, deletedBefore, '已交给引擎的 SkImage 不由我们 delete');
  assert.strictEqual(sk.dead, undefined);
  assert.ok(env.CK.surfaces.every((x) => x.disposed), '所有离屏 surface 都已释放');
});

test('ImageBitmap 未交给引擎就 close:快照 SkImage 由我们 delete;重复交出给拷贝', async () => {
  const env = setup();
  const { img } = await decodedImg(env, PNG());
  const oc = new env.shim.self.OffscreenCanvas(16, 12);
  oc.getContext('2d').drawImage(img, 0, 0, 16, 12);
  const b1 = oc.transferToImageBitmap();
  const d0 = env.CK.deleted;
  b1.close();
  assert.strictEqual(env.CK.deleted, d0 + 1);
  assert.strictEqual(await captureErrors(() => env.CK.MakeLazyImageFromTextureSource(b1, 0, true)).then((r) => r.v), null);
  oc.getContext('2d').drawImage(img, 0, 0, 16, 12);
  const b2 = oc.transferToImageBitmap();
  const first = env.CK.MakeLazyImageFromTextureSource(b2, 0, true);
  const second = env.CK.MakeLazyImageFromTextureSource(b2, 0, true);
  assert.notStrictEqual(second, first, '第二次给一份新的(原件归第一个 CkImage)');
  assert.deepStrictEqual([second.width(), second.height()], [16, 12]);
});

test('toByteData(rawRgba):2d <canvas> 走 CanvasKit 光栅,getImageData 为非预乘 RGBA,全程不碰真实画布节点', async () => {
  const env = setup();
  const { c, doc } = env;
  c.canvas.width = 1098; c.canvas.height = 747;
  const { img } = await decodedImg(env, PNG());
  env.CK.MakeLazyImageFromTextureSource(img, {});
  const el = doc.createElement('canvas');
  el.width = 64; el.height = 48;                  // createDomCanvasElement(width, height)
  const ctx2 = el.getContext('2d');
  assert.strictEqual(el.getContext('2d'), ctx2, '同一元素的 2d 上下文复用');
  assert.strictEqual(el.getContext('webgl'), null, '已是 2d 画布则拿不到 webgl');
  ctx2.drawImage(img, 0, 0);
  const s = env.CK.surfaces[0];
  assert.deepStrictEqual([s.w, s.h], [64, 48]);
  assert.deepStrictEqual(s.draws[0].dst, [0, 0, 64, 48]);
  const id = ctx2.getImageData(0, 0, 64, 48);
  assert.strictEqual(id.data.length, 64 * 48 * 4);
  assert.strictEqual(id.data.buffer.byteLength, 64 * 48 * 4, '引擎取 imageData.data.buffer,必须恰好这么长');
  assert.strictEqual(id.data[0], 0x7f);
  assert.strictEqual(s.reads[0].info.alphaType, 'unpremul');
  el.width = 0; el.height = 0;
  assert.ok(s.disposed, '置 0×0 时释放 surface');
  assert.strictEqual(c.canvas.width, 1098, '真实画布节点尺寸从未被改(改一次就会清掉当前帧)');
  assert.strictEqual(c.canvas.height, 747);
});

test('toByteData(png):toDataURL 给出 CanvasKit 编码的 PNG(base64)', async () => {
  const env = setup();
  const { img } = await decodedImg(env, PNG());
  const el = env.doc.createElement('canvas');
  el.width = 64; el.height = 48;
  el.getContext('2d').drawImage(img, 0, 0);
  const url = el.toDataURL();
  assert.match(url, /^data:image\/png;base64,/);
  const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
  assert.deepStrictEqual(Array.from(bytes), [0x89, 0x50, 0x4e, 0x47, 64, 48]);
});

test('drawImage 源:引擎那份已 delete 时按字节临时解码(用完 delete);字节也没了则点名报错', async () => {
  const env = setup();
  const { img, url } = await decodedImg(env, PNG());
  const sk = env.CK.MakeLazyImageFromTextureSource(img, {});
  sk.delete();
  const el = env.doc.createElement('canvas');
  el.width = 64; el.height = 48;
  const ctx2 = el.getContext('2d');
  const d0 = env.CK.deleted;
  ctx2.drawImage(img, 0, 0);
  assert.strictEqual(env.CK.decoded, 2);
  assert.strictEqual(env.CK.deleted, d0 + 1, '临时解码的那份用完即 delete');
  env.w.URL.revokeObjectURL(url);
  const { errs } = await captureErrors(() => assert.throws(() => ctx2.drawImage(img, 0, 0), /mp-flutter: 离屏 2d 画布的 drawImage 只支持已解码的图片/));
  assert.ok(errs.length > 0, '要 console.error 一份');
});

// M4:drawImage 之后 getImageData/toDataURL 如果抛错(CanvasKit readPixels/
// encodeToBytes 失败),离屏 surface 不能半死不活地留着——必须在 catch/finally
// 里 drop(dispose 连同 malloc 的像素),下次调用按当前尺寸重新创建一个干净的。
test('M4:getImageData 时 CanvasKit readPixels 返回空——drop 离屏 surface,下次调用重新创建', async () => {
  const env = setup();
  const { img } = await decodedImg(env, PNG());
  const el = env.doc.createElement('canvas');
  el.width = 64; el.height = 48;
  const ctx2 = el.getContext('2d');
  ctx2.drawImage(img, 0, 0);
  const s = env.CK.surfaces[0];
  s.getCanvas().readPixels = () => null;   // 模拟 CanvasKit 失败
  const { errs } = await captureErrors(
    () => assert.throws(() => ctx2.getImageData(0, 0, 64, 48), /getImageData 失败:CanvasKit readPixels 返回空/));
  assert.ok(errs.some((l) => /readPixels 返回空/.test(l)));
  assert.ok(s.disposed, 'readPixels 失败后应该 drop 掉这个 surface');

  // 下次调用不能复用已 dispose 的 surface,应该重新创建一个干净的
  ctx2.drawImage(img, 0, 0);
  assert.strictEqual(env.CK.surfaces.length, 2);
  assert.notStrictEqual(env.CK.surfaces[1], s);
  const id = ctx2.getImageData(0, 0, 64, 48);
  assert.strictEqual(id.data.length, 64 * 48 * 4);
  assert.strictEqual(id.data[0], 0x7f);
});

test('M4:toDataURL 编码失败(CanvasKit encodeToBytes 返回空)——drop 离屏 surface', async () => {
  const env = setup();
  const { img } = await decodedImg(env, PNG());
  const el = env.doc.createElement('canvas');
  el.width = 64; el.height = 48;
  el.getContext('2d').drawImage(img, 0, 0);
  const s = env.CK.surfaces[0];
  const origSnapshot = s.makeImageSnapshot;
  s.makeImageSnapshot = () => {
    const sk = origSnapshot();
    sk.encodeToBytes = () => null;
    return sk;
  };
  const deletedBefore = env.CK.deleted;
  const { errs } = await captureErrors(() => assert.throws(() => el.toDataURL(), /toDataURL 失败:CanvasKit 无法编码 PNG/));
  assert.ok(errs.some((l) => /无法编码 PNG/.test(l)));
  assert.ok(s.disposed, '编码失败后应该 drop 掉这个 surface');
  assert.strictEqual(env.CK.deleted, deletedBefore + 1, '编码失败的快照 SkImage 仍然要 delete(finally 里)');
});

test('已作为 WebGL 画布用过的元素拿不到 2d 上下文', () => {
  const { c, doc } = setup();
  const el = doc.createElement('canvas');
  el.getContext('webgl');
  el.width = 300;
  assert.strictEqual(el.getContext('2d'), null);
  assert.strictEqual(c.canvas.width, 300);
});

test('base64 与 Buffer 一致', () => {
  const { base64 } = require(path.join(RT, 'image.js'));
  for (let n = 0; n < 8; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 97 + 13) & 255);
    assert.strictEqual(base64(b), Buffer.from(b).toString('base64'));
  }
});
