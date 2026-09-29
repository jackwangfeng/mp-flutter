'use strict';
/**
 * 着色器预热(`shader_warmup`,默认开;`--no-shader-warmup` 关)。
 *
 * ## 为什么要做、为什么只能在 JS 侧做
 *
 * Skia 的 GL 后端把编译好的 GL program 缓存在 GrDirectContext 里(内存缓存,
 * CanvasKit 没有持久化缓存)。某种"几何 × 片元处理器 × 裁剪 × 混合"组合第一
 * 次出现时,当帧同步 compileShader + linkProgram;iOS 小程序的 WebGL 没有 JIT,
 * 首次编译一个 program 真机实测上百 ms(iPhone 15 长列表首次进入:6 个
 * program、shader=946ms)。
 *
 * 框架自带的 `PaintingBinding.shaderWarmUp` 在 Web 上帮不上忙:它默认就是
 * null;即便设置,也是录一张 picture 再 `toImage`——CanvasKit 渲染器的
 * `toImageSync` 画在 `pictureToImageSurface` 上,那是另一个 CkSurface,构造时
 * 自己 `MakeGrContext`,program 缓存与屏幕 Surface 的不是同一份(Flutter 3.41
 * `canvaskit/picture.dart` `toImageSync`、`compositing/multi_surface_rasterizer.dart`
 * `createPictureToImageSurface`)。所以入口包装里"录 picture + toImage"(候选 a)
 * 预热的是错的缓存;只能在 JS 侧拿到引擎真正上屏用的 GrDirectContext 直接画
 * (候选 b)。
 *
 * ## 做法
 *
 * 1. 共享 GrDirectContext:小程序里所有逻辑 <canvas> 共用一个真实 WebGL 上下文
 *    (bom-shim.js 的 ctx.glContext),引擎却给每个 CkSurface 各建一个
 *    GrDirectContext(屏幕 Surface、pictureToImageSurface 各一个),各自缓存
 *    GL 状态、各自编译 program。这里包一层 `CK.MakeGrContext`:第一个创建出来
 *    之后,后续调用都交回同一个(上下文丢失后才放行新建)——预热的 program
 *    屏幕与 toImage 路径都命中;顺带消除两个 GrDirectContext 在同一 GL 上下文
 *    上互相踩状态缓存的隐患。
 * 2. 时机:首帧之后、空闲时。首帧前预热(串行)实测代价太大:模拟器里 42 组
 *    组合、60 个 program 就要 2.5s,真机按每个 program 百 ms 级估算是数秒,
 *    冷启动不能接受。改成首帧 flush 之后,只在"最近 IDLE_MS 内引擎没有 flush
 *    过、也没有手指按着屏幕"时才画;用户一开始滚动/有动画/触摸就暂停,空闲
 *    再继续。典型场景是首页静止展示的头几秒,正好把进入下一个页面要用的
 *    program 编好。真机上单个 program 的编译/链接开销差异很大(见下面
 *    HEAVY_IDLE_MS/SLICE_BUDGET_MS):文字/纯色/图片/圆/描边/路径这类"轻项"
 *    一片最多攒 SLICE_BUDGET_MS 就让出主线程;阴影/模糊/颜色矩阵/混合这类
 *    自带专用 program、单个可达上百 ms 的"重项"没法再拆,改为要求更长的连续
 *    空闲(HEAVY_IDLE_MS)才画,每片只画一个,`light` 模式下整批跳过。
 * 3. 画在哪:同一个共享 GrDirectContext 上的离屏 RenderTarget
 *    (`CK.MakeRenderTarget`)。首帧之后不能画到默认帧缓冲——preserveDrawingBuffer
 *    为 false,帧外的绘制会被当成新的一帧合成上屏(闪一下)。离屏与屏幕上的
 *    program 是同一个:读 sk_FragCoord 的片元(圆角裁剪等)用 `u_skRTFlip` uniform
 *    处理原点翻转,program key 不含渲染目标原点(模拟器实测:离屏预热后,
 *    长列表的圆角裁剪图片等 program 不再重新编译,见 perf-hud 的
 *    `[mp-perf] program` 行)。
 *    画布先 `scale(dpr)`,清单里全用逻辑像素的整数坐标——与框架的绘制一致(根
 *    变换是 dpr 缩放、布局落在整数逻辑像素上):对齐像素的矩形/图片走不带覆盖率
 *    的 program,阴影/模糊的 sigma、圆角半径、字号换算到设备像素后与应用相同
 *    (高斯模糊的 program 随核宽变化)。
 *    预热自己用安装时保存的原始 `Surface.getCanvas/flush`,不经过 boot 的首帧
 *    钩子与 --verify/--perf-hud 的外层包装。
 *
 * ## 清单
 *
 * 按 Flutter CanvasKit 渲染器(`canvaskit/canvas.dart`、`painting.dart`、
 * `util.dart`)实际发给 SkCanvas 的调用构造,参数取框架默认值:抗锯齿开、
 * 图片默认 FilterQuality.medium(线性 + 线性 mipmap)、渐变开 dither、阴影用引擎
 * 的光源参数与 flags、BoxShadow 的 sigma = blurRadius×0.57735+0.5、BackdropFilter
 * 模糊 mirror 平铺。项目按常见程度排序(越靠前越可能在下一个页面用到)。清单
 * 来源:压测页 A~F 在 --perf-hud 下记录的 `[mp-perf] program` 摘要(attribute/
 * uniform 名 + 源码哈希,见 perf-hud.js 的 programDigest)。
 */

/** 最近这么久内引擎 flush 过(有帧在画)就不预热,让给交互。 */
const IDLE_MS = 150;
/**
 * "重"组合(shadow/boxShadow/backdropBlur/imageFilter——软阴影、模糊、颜色
 * 矩阵/混合这类自带专用 GL program、真机上单个编译/链接可达上百 ms 的清单
 * 项,见文件头 `heavy` 标注)要求这么长的连续空闲(无 flush、无按下)才画,
 * 比普通项的 IDLE_MS 更保守——真机上一片就可能是几百 ms,不能赌用户刚停手
 * 指就立刻画。
 */
const HEAVY_IDLE_MS = 1000;
/**
 * 一片(一次 tick)最多在"轻"项上花这么久:轻项每画完一个就检查累计耗时,
 * 超过预算就停下让出主线程,剩下的轻项留到下一次空闲检查再画,而不是一次
 * 性画到清单末尾。重项(单个 program 编译/链接本身就长,没法再拆)不受这个
 * 预算约束——拆无可拆,只能整项一起算一片(见 HEAVY_IDLE_MS 与 `light`)。
 */
const SLICE_BUDGET_MS = 8;
/** 空闲检查间隔。 */
const TICK_MS = 40;
/** 首帧之后等这么久再开始(首帧后常有紧接着的几帧布局/图片到达)。 */
const START_DELAY_MS = 300;
/** 离屏渲染目标边长(设备像素)。 */
const RT_SIZE = 512;
/** 超过这么久还没做完就放弃(一直在动画/滚动)。 */
const GIVE_UP_MS = 120000;

function safe(fn) {
  try { return fn(); } catch (e) { return null; }
}

/** 构造一张 w×h 的光栅图(不透明 JPEG 解码 / 预乘 PNG 解码两种 alphaType)。 */
function makeImage(CK, w, h, opaque) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = (i * 37) & 255;
    px[i * 4 + 1] = (i * 91) & 255;
    px[i * 4 + 2] = (i * 13) & 255;
    px[i * 4 + 3] = opaque ? 255 : 128 + (i & 127);
  }
  return CK.MakeImage({
    width: w, height: h, colorType: CK.ColorType.RGBA_8888,
    alphaType: opaque ? CK.AlphaType.Opaque : CK.AlphaType.Premul,
    colorSpace: CK.ColorSpace.SRGB,
  }, px, w * 4);
}

/**
 * 预热清单:[{ name, run(c, k) }],c 已 scale(dpr),坐标是逻辑像素;k 是共享
 * 资源(图片、字体、路径)。每项独立 try,失败只影响自己。
 */
function buildCombos(CK) {
  const R = function (x, y, w, h) { return CK.XYWHRect(x, y, w, h); };
  const RR = function (x, y, w, h, r) { return CK.RRectXY(CK.XYWHRect(x, y, w, h), r, r); };
  const paint = function (color, style, strokeWidth) {
    const p = new CK.Paint();
    p.setAntiAlias(true);
    p.setColor(color || CK.Color(33, 150, 243, 1));
    if (style) p.setStyle(style);
    if (strokeWidth != null) p.setStrokeWidth(strokeWidth);
    return p;
  };
  const del = function () { for (let i = 0; i < arguments.length; i++) { const o = arguments[i]; if (o && o.delete) o.delete(); } };
  const clipRRect = function (c, r) { c.clipRRect(RR(0, 0, 100, 100, r || 6), CK.ClipOp.Intersect, true); };
  const img = function (c, k, im, x, y, filter, mip, p0) {
    if (!im) return;
    const p = p0 || paint();
    c.drawImageRectOptions(im, R(0, 0, im.width(), im.height()), R(x, y, 64, 64), filter, mip, p);
    if (!p0) del(p);
  };
  const medium = function (c, k, im, x, y, p) { img(c, k, im, x, y, CK.FilterMode.Linear, CK.MipmapMode.Linear, p); };
  const text = function (c, k, color) {
    if (!k.font) return;
    const p = paint(color || CK.Color(0, 0, 0, 0.87));
    c.drawText('预热文字 Warm 123', 4, 20, p, k.font);
    if (k.fontBold) c.drawText('粗体 Bold ¥9.90', 4, 44, p, k.fontBold);
    del(p);
  };
  const tonal = function () {
    return CK.computeTonalColors({ ambient: CK.Color(0, 0, 0, 0.039), spot: CK.Color(0, 0, 0, 0.25) });
  };

  // 轻项(单个 program 编译通常 ≤ 个位数 ms,模拟器实测 1~5ms)按原顺序排在
  // 前面;重项(单个 program 真机上可达上百 ms,见 HEAVY_IDLE_MS 注释)统一挪
  // 到清单末尾——不影响"重项之间"或"轻项之间"的相对顺序,只是让空闲的头几百
  // ms 先把常见的轻项画完,重项等到 HEAVY_IDLE_MS 那种更长的静止期才开始,
  // `light` 模式下则整批跳过。
  const light = [];
  const heavy = [];
  const add = function (name, run) { light.push({ name: name, heavy: false, run: run }); };
  const addHeavy = function (name, run) { heavy.push({ name: name, heavy: true, run: run }); };

  // —— 最常见:文字、纯色矩形/圆角、图片、圆 ——
  add('text', function (c, k) { text(c, k); text(c, k, CK.WHITE); });
  add('rect', function (c) { const p = paint(); c.drawRect(R(0, 0, 40, 30), p); p.setColor(CK.Color(0, 0, 0, 0.5)); c.drawRect(R(0, 40, 40, 30), p); del(p); });
  add('rrect', function (c) { const p = paint(); c.drawRRect(RR(0, 0, 60, 40, 8), p); c.drawRRect(RR(0, 50, 60, 40, 20), p); del(p); });
  add('image', function (c, k) { medium(c, k, k.imgOpaque, 0, 0); medium(c, k, k.imgAlpha, 70, 0); });
  add('image@rrect', function (c, k) {   // 圆角图片(ClipRRect > Image,长列表缩略图)
    c.save(); c.clipRRect(RR(0, 0, 64, 64, 6), CK.ClipOp.Intersect, true); medium(c, k, k.imgOpaque, 0, 0); c.restore();
    c.save(); c.clipRRect(RR(70, 0, 64, 64, 6), CK.ClipOp.Intersect, true); medium(c, k, k.imgAlpha, 70, 0); c.restore();
  });
  add('text@rect', function (c, k) { c.save(); c.clipRect(R(0, 0, 100, 30.5), CK.ClipOp.Intersect, true); text(c, k); c.restore(); });
  add('circle', function (c) {   // Radio / Switch 滑块 / 水波纹
    const p = paint();
    c.drawCircle(20, 20, 10, p);
    p.setStyle(CK.PaintStyle.Stroke); p.setStrokeWidth(2);
    c.drawCircle(50, 20, 9, p);
    del(p);
  });
  add('stroke', function (c) {   // OutlineInputBorder、Divider、描边矩形
    const p = paint(CK.Color(0, 0, 0, 0.38), CK.PaintStyle.Stroke, 1);
    c.drawRRect(RR(0.5, 0.5, 100, 48, 4), p);
    p.setStrokeWidth(2);
    c.drawRRect(RR(1, 60, 100, 48, 4), p);
    c.drawLine(0, 120, 100, 120, p);
    p.setStrokeWidth(1);
    c.drawRect(R(0.5, 130.5, 40, 20), p);
    del(p);
  });
  add('path', function (c, k) {   // 图标、勾选框、下拉箭头
    const p = paint();
    c.drawPath(k.path, p);
    p.setStyle(CK.PaintStyle.Stroke); p.setStrokeWidth(2);
    p.setStrokeCap(CK.StrokeCap.Round); p.setStrokeJoin(CK.StrokeJoin.Round);
    c.drawPath(k.check, p);
    del(p);
  });
  add('rect@rrect', function (c, k) { c.save(); clipRRect(c, 16); const p = paint(); c.drawRect(R(0, 0, 100, 100), p); del(p); text(c, k); c.restore(); });
  add('image@rect', function (c, k) { c.save(); c.clipRect(R(0, 0, 50.5, 50.5), CK.ClipOp.Intersect, true); medium(c, k, k.imgOpaque, 0, 0); c.restore(); });
  // —— 阴影(重:软阴影 program 按"不透明/透明遮挡" flags 分两种,拆成两个
  // 独立清单项各画一遍——elev/path 只是同一个 program 的不同 uniform,不必
  // 再拆;每项单独一片,真机上一个软阴影 program 就可能是一整片的耗时)——
  addHeavy('shadow-opaque', function (c, k) { shadowFlag(c, k, 4); });   // Material elevation(PhysicalModel/Card/AppBar):不透明遮挡
  addHeavy('shadow-transparent', function (c, k) { shadowFlag(c, k, 5); });   // 透明遮挡(引擎 drawSkShadow 的另一种 flags)
  function shadowFlag(c, k, flags) {
    const t = tonal();
    [1, 4].forEach(function (elev) {
      [k.shadowRRect, k.shadowRect].forEach(function (path) {
        c.drawShadow(path, [0, 0, k.dpr * elev], [0, -1, 1], 800 / 600, t.ambient, t.spot, flags);
      });
    });
  }
  // BoxShadow:模糊蒙版画圆角/矩形/圆,每个模糊半径一个 program(核宽变
  // program 变)——半径 10 是最常见的默认 Material 高度,单独占一项;另外两个
  // 常见半径见清单末尾的 boxShadow4/boxShadow20。
  addHeavy('boxShadow', function (c) {
    const mf = CK.MaskFilter.MakeBlur(CK.BlurStyle.Normal, 10 * 0.57735 + 0.5, true);
    const p = paint(CK.Color(0, 0, 0, 0.25));
    p.setMaskFilter(mf);
    c.drawRRect(RR(20, 20, 80, 60, 16), p);
    c.drawRRect(RR(20, 20, 80, 60, 8), p);
    c.drawRect(R(20, 100, 80, 40), p);
    c.drawCircle(140, 50, 20, p);
    del(p, mf);
  });
  // —— 渐变(每种一组:一组一两个 program,单次占用主线程短)——
  const grad = function (c, colors, rrect) {
    const s = CK.Shader.MakeLinearGradient([0, 0], [0, 40], colors, null, CK.TileMode.Clamp);
    const p = paint(); p.setShader(s); p.setDither(true);
    c.drawRect(R(0, 0, 80, 40), p);
    if (rrect) c.drawRRect(RR(90, 0, 80, 40, 8), p);
    del(p, s);
  };
  add('gradient2', function (c) { grad(c, [CK.RED, CK.BLUE], true); });
  add('imageDown', function (c, k) {   // 大图缩小显示(网络图片常见:原图比显示尺寸大)
    medium(c, k, k.imgBig, 0, 0);
    c.save(); c.clipRRect(RR(70, 0, 64, 64, 6), CK.ClipOp.Intersect, true); medium(c, k, k.imgBig, 70, 0); c.restore();
  });
  add('gradient3', function (c) { grad(c, [CK.RED, CK.GREEN, CK.BLUE], false); });
  add('radialGradient', function (c) {
    const r = CK.Shader.MakeRadialGradient([40, 40], 30, [CK.RED, CK.BLUE], null, CK.TileMode.Clamp);
    const p = paint(); p.setShader(r); p.setDither(true);
    c.drawRect(R(0, 0, 80, 80), p);
    del(p, r);
  });
  // —— 半透明层(Opacity / 路由淡入淡出)——
  add('saveLayerAlpha', function (c, k) {
    const lp = new CK.Paint();
    lp.setAlphaf(0.8);
    c.saveLayer(lp, R(0, 0, 140, 140), null, null, CK.TileMode.Clamp);
    const p = paint(); c.drawRRect(RR(0, 0, 100, 60, 16), p); del(p); text(c, k); medium(c, k, k.imgOpaque, 0, 70);
    c.restore();
    c.save(); clipRRect(c, 16);
    c.saveLayer(lp, R(0, 0, 100, 100), null, null, CK.TileMode.Clamp);
    const p2 = paint(); c.drawRect(R(0, 0, 100, 100), p2); del(p2);
    c.restore(); c.restore();
    del(lp);
  });
  // —— BackdropFilter 模糊(引擎:saveLayer(paint, bounds, blurFilter, 0, mirror))——
  // 核宽(sigma)不同是不同 program,拆成两个独立清单项,各画一遍就够(裁剪/
  // 不裁剪两种 saveLayer 共用同一个模糊 program,不必再拆)。
  [5, 10].forEach(function (sigma) {
    addHeavy('backdropBlur' + sigma, function (c, k) {
      const f = CK.ImageFilter.MakeBlur(sigma * k.dpr, sigma * k.dpr, CK.TileMode.Mirror, null);
      c.save(); clipRRect(c, 16);
      c.saveLayer(null, R(0, 0, 100, 100), f, 0, CK.TileMode.Mirror);
      const p = paint(CK.Color(255, 255, 255, 0.3)); c.drawRect(R(0, 0, 100, 100), p); del(p);
      c.restore(); c.restore();
      c.save(); c.clipRect(R(0, 0, 100, 100), CK.ClipOp.Intersect, true);
      c.saveLayer(null, R(0, 0, 100, 100), f, 0, CK.TileMode.Mirror);
      c.restore(); c.restore();
      del(f);
    });
  });
  // —— 不太常见的收尾(重:模糊/颜色矩阵/混合各自一个 program,拆成三个独立
  // 清单项)——
  addHeavy('imageFilter-blur', function (c, k) {   // ImageFiltered 模糊(decal)
    const f = CK.ImageFilter.MakeBlur(4 * k.dpr, 4 * k.dpr, CK.TileMode.Decal, null);
    const lp = new CK.Paint(); lp.setImageFilter(f);
    c.saveLayer(lp, R(0, 0, 100, 100), null, null, CK.TileMode.Clamp);
    const p = paint(); c.drawRRect(RR(10, 10, 60, 60, 8), p); del(p);
    c.restore();
    del(lp, f);
  });
  addHeavy('imageFilter-colorMatrix', function (c, k) {   // ColorFiltered(矩阵,如灰度)
    const cf = CK.ColorFilter.MakeMatrix([0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0.33, 0.33, 0.33, 0, 0, 0, 0, 0, 1, 0]);
    const p1 = paint(); p1.setColorFilter(cf); medium(c, k, k.imgOpaque, 0, 0, p1); del(p1, cf);
  });
  addHeavy('imageFilter-blend', function (c, k) {   // ColorFiltered(混合,如着色图标)
    const bf = CK.ColorFilter.MakeBlend(CK.Color(255, 0, 0, 1), CK.BlendMode.SrcIn);
    const p2 = paint(); p2.setColorFilter(bf); medium(c, k, k.imgAlpha, 70, 0, p2); del(p2, bf);
  });
  [4, 20].forEach(function (blurRadius) {
    addHeavy('boxShadow' + blurRadius, function (c) {
      const mf = CK.MaskFilter.MakeBlur(CK.BlurStyle.Normal, blurRadius * 0.57735 + 0.5, true);
      const p = paint(CK.Color(0, 0, 0, 0.25));
      p.setMaskFilter(mf);
      c.drawRRect(RR(20, 20, 80, 60, 8), p);
      c.drawRect(R(20, 100, 80, 40), p);
      del(p, mf);
    });
  });
  add('imageSampling', function (c, k) {   // FilterQuality none/low/high
    img(c, k, k.imgOpaque, 0, 0, CK.FilterMode.Nearest, CK.MipmapMode.None);
    img(c, k, k.imgOpaque, 70, 0, CK.FilterMode.Linear, CK.MipmapMode.None);
    if (k.imgOpaque) {
      const p = paint();
      c.drawImageRectCubic(k.imgOpaque, R(0, 0, k.imgOpaque.width(), k.imgOpaque.height()), R(140, 0, 64, 64), 1 / 3, 1 / 3, p);
      del(p);
    }
  });
  return light.concat(heavy);
}

/** 共享资源(图片、字体、路径);用完 dispose。 */
function makeKit(CK, typefaceData, dpr) {
  const k = { own: [], dpr: dpr };
  const keep = function (o) { if (o) k.own.push(o); return o; };
  // 不是 2 的幂(真实图片大多如此;WebGL1 下 NPOT 的 mipmap 走另一条路径)
  k.imgOpaque = keep(safe(function () { return makeImage(CK, 48, 40, true); }));
  k.imgAlpha = keep(safe(function () { return makeImage(CK, 48, 40, false); }));
  k.imgBig = keep(safe(function () { return makeImage(CK, 300, 220, true); }));
  // 3.41 的 CanvasKit:SkPath 不可变,用 PathBuilder 构造再 snapshot()
  const mk = function (fn) {
    if (typeof CK.PathBuilder === 'function') {
      const b = new CK.PathBuilder();
      try { fn(b); return keep(b.snapshot()); } finally { b.delete(); }
    }
    const p = keep(new CK.Path());
    fn(p);
    return p;
  };
  k.path = mk(function (p) {
    p.moveTo(5, 20); p.lineTo(15, 30); p.lineTo(35, 6);
    p.quadTo(40, 30, 20, 38); p.cubicTo(10, 40, 4, 34, 5, 20); p.close();
  });
  k.check = mk(function (p) { p.moveTo(50, 20); p.lineTo(58, 28); p.lineTo(74, 10); });
  k.shadowRRect = mk(function (p) { p.addRRect(CK.RRectXY(CK.XYWHRect(20, 20, 80, 50), 4, 4)); });
  k.shadowRect = mk(function (p) { p.addRect(CK.XYWHRect(20, 90, 80, 30)); });
  if (typefaceData) {
    const tf = safe(function () { return CK.Typeface.MakeTypefaceFromData(typefaceData); });
    if (tf) {
      keep(tf);
      k.font = keep(new CK.Font(tf, 14));
      const b = keep(new CK.Font(tf, 16));
      safe(function () { b.setEmbolden(true); });
      k.fontBold = b;
    }
  }
  return k;
}

function disposeKit(k) {
  k.own.forEach(function (o) { safe(function () { if (o && o.delete) o.delete(); }); });
}

/**
 * 装上共享 GrDirectContext 与首帧后空闲预热。[opts]:
 *   - gl:真实 WebGL 上下文(判断上下文是否丢失;丢失后不再复用、停止预热)
 *   - dpr:设备像素比(清单用逻辑像素画,画布先 scale(dpr))
 *   - typefaceData():返回一份字体字节(ArrayBuffer/TypedArray)或 null,文字项用;
 *     为 null 时用引擎首帧前注册的第一份字体
 *   - light:true 时只画轻项(见 buildCombos 的 heavy 标注),重项(阴影/模糊/
 *     颜色矩阵/混合——真机上单个 program 可达上百 ms 且没法再拆)整批跳过,
 *     算进 stats.skipped,不占用任何一片的时间。给低端机/`shader_warmup_light`
 *     用,预热本身占的主线程时间大幅降低,代价是这些效果仍会在用户第一次
 *     用到时同步编译。
 *   - pointerState:{ down } 形式的共享可变对象(承载页在 onMpTouch 里维护,
 *     见 boot.js/pipeline.dart),down > 0 表示至少有一根手指按着屏幕——即使
 *     引擎这一刻还没因为按下就 flush(比如长按、手势识别中),也要整体暂停,
 *     不抢用户正在做的交互的主线程。
 *   - log(line):--perf-hud 明细;有的话每画完一项就打一行(见下),预热结束
 *     再打一行汇总(可缺省)。
 *   - now/setTimeout:单测注入
 * 返回 { stats }:done/combos(成功画完的项数)/busyMs(预热本身占主线程的总
 * 耗时)/maxSliceMs(单次 tick 里最长的一次,即一片的上限)/elapsedMs/failed/
 * shared(交回共享 GrDirectContext 的次数)/skipped(light 模式跳过的重项数)/
 * heavyRun(实际画掉的重项数)。
 *
 * ## 分片策略(见文件头 SLICE_BUDGET_MS/HEAVY_IDLE_MS)
 * 轻项:一片(一次 tick)可以连着画好几个,直到累计耗时超过 SLICE_BUDGET_MS
 * (8ms)才让出主线程——单个轻项模拟器实测 1~5ms,不这样批量画完 17 个轻项
 * 空等的调度间隔(TICK_MS×17)比实际工作量还长。
 * 重项:天生没法再拆的单个 program 编译/链接,预算管不住——每片只画一个,
 * 且要求最近 HEAVY_IDLE_MS(1s)内都没有 flush、也没有手指按着,比轻项的
 * IDLE_MS(150ms)更保守;真机上一片可能就是几百 ms,不能赌用户刚松手/停
 * 滚动就立刻画一个大的。
 */
function installShaderWarmup(CK, opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const setT = o.setTimeout || setTimeout;
  const log = typeof o.log === 'function' ? o.log : null;
  const dpr = o.dpr > 0 ? o.dpr : 2;
  const light = !!o.light;
  const pointerState = o.pointerState || null;
  const stats = { started: false, done: false, combos: 0, busyMs: 0, elapsedMs: 0, maxSliceMs: 0, failed: [], shared: 0, skipped: 0, heavyRun: 0 };
  const proto = CK && CK.Surface && CK.Surface.prototype;
  if (!CK || typeof CK.MakeGrContext !== 'function' || typeof CK.MakeRenderTarget !== 'function' ||
      !proto || typeof proto.flush !== 'function' || typeof proto.getCanvas !== 'function') {
    return { stats: stats };
  }
  const gl = o.gl || null;
  const lost = function () { return !!(gl && typeof gl.isContextLost === 'function' && gl.isContextLost()); };

  // 1. 共享 GrDirectContext(见文件头)
  const origMakeGr = CK.MakeGrContext;
  let shared = null;
  CK.MakeGrContext = function () {
    if (shared && !(typeof shared.isDeleted === 'function' && shared.isDeleted()) && !lost()) {
      stats.shared++;
      return shared;
    }
    const g = origMakeGr.apply(this, arguments);
    if (g) shared = g;
    return g;
  };

  // 文字项要一份字体:优先调用方给的(常用汉字合一字体),否则记下引擎首帧前
  // 注册的第一份字体字节(清单字体 / Roboto),只留引用不拷贝
  let seenFont = null;
  const TFP = CK.TypefaceFontProvider && CK.TypefaceFontProvider.prototype;
  const origReg = TFP && TFP.registerFont;
  let regWrap = null;
  if (typeof origReg === 'function') {
    regWrap = function (data) {
      if (!seenFont && data) seenFont = data;
      return origReg.apply(this, arguments);
    };
    TFP.registerFont = regWrap;
  }
  // 只在自己仍是最外层时还原(--perf-hud 可能又包了一层)
  const restoreReg = function () { if (regWrap && TFP.registerFont === regWrap) TFP.registerFont = origReg; };

  // 2. 记下引擎最近一次 flush(= 画了一帧);第一次 flush 之后开始空闲预热。
  //    预热自己用原始 getCanvas/flush,不经过这里与外层包装。
  const rawFlush = proto.flush;
  const rawGetCanvas = proto.getCanvas;
  let lastFlush = 0;
  let t0 = 0;
  proto.flush = function () {
    lastFlush = now();
    if (!stats.started) {
      stats.started = true;
      t0 = lastFlush;
      setT(tick, START_DELAY_MS);
    }
    return rawFlush.apply(this, arguments);
  };

  let combos = null, kit = null, rt = null, idx = 0;
  function finish(reason) {
    stats.done = true;
    stats.elapsedMs = now() - t0;
    if (kit) disposeKit(kit);
    kit = null;
    if (rt) safe(function () { rt.delete(); });
    rt = null;
    restoreReg();
    if (log) {
      try {
        log('[mp-perf] shader-warmup ' + (reason || 'done') + ' combos=' + stats.combos + '/' + (combos ? combos.length : 0) +
          ' busy=' + stats.busyMs + 'ms maxSlice=' + stats.maxSliceMs + 'ms elapsed=' + stats.elapsedMs + 'ms' +
          ' heavy=' + stats.heavyRun + ' skipped=' + stats.skipped +
          (stats.failed.length ? ' failed=' + stats.failed.join(';').slice(0, 300) : ''));
      } catch (e) { /* 忽略 */ }
    }
  }
  // 画一项、单独 flush、记时;失败只影响这一项(program 在 flush 时才真正
  // 编译——每项独立 flush 才能量出"这一项对应哪个 program、编译花了多久",
  // 对得上 perf-hud 的 `[mp-perf] program` 行)。返回耗时(ms)。
  function runOne(cb) {
    const t = now();
    const canvas = rawGetCanvas.call(rt);
    canvas.save();
    canvas.scale(dpr, dpr);
    try { cb.run(canvas, kit); stats.combos++; if (cb.heavy) stats.heavyRun++; } catch (e) {
      stats.failed.push(cb.name + ':' + ((e && e.message) || e));
    }
    safe(function () { canvas.restoreToCount(1); });
    rawFlush.call(rt);
    const d = now() - t;
    stats.busyMs += d;
    if (d > stats.maxSliceMs) stats.maxSliceMs = d;
    if (log) {
      try { log('[mp-perf] shader-warmup item ' + cb.name + ' ' + d.toFixed(1) + 'ms' + (cb.heavy ? ' heavy' : '')); } catch (e) { /* 忽略 */ }
    }
    return d;
  }
  function tick() {
    if (stats.done) return;
    if (lost() || !shared) { finish('abort'); return; }
    const t = now();
    if (t - t0 > GIVE_UP_MS) { finish('timeout'); return; }
    if (pointerState && pointerState.down > 0) { setT(tick, TICK_MS); return; }   // 手指按着:整体暂停
    if (t - lastFlush < IDLE_MS) { setT(tick, TICK_MS); return; }   // 有帧在画:让给交互
    try {
      if (!combos) {
        combos = buildCombos(CK);
        let td = null;
        try { td = typeof o.typefaceData === 'function' ? o.typefaceData() : null; } catch (e) { td = null; }
        kit = makeKit(CK, td || seenFont, dpr);
        rt = CK.MakeRenderTarget(shared, RT_SIZE, RT_SIZE);
        if (!rt) { finish('no-render-target'); return; }
      }
      let sliceBusy = 0;
      while (idx < combos.length) {
        const cb = combos[idx];
        if (cb.heavy) {
          if (light) { stats.skipped++; idx++; continue; }   // light 模式:整批跳过,不占时间
          if (now() - lastFlush < HEAVY_IDLE_MS) break;   // 空闲还不够长,这片先不画,等下次再看
          idx++;
          runOne(cb);
          break;   // 重项独占一片,不再往后批
        }
        if (sliceBusy >= SLICE_BUDGET_MS) break;   // 轻项攒够一片预算,让出主线程
        idx++;
        sliceBusy += runOne(cb);
      }
    } catch (e) {
      stats.failed.push('tick:' + ((e && e.message) || e));
    }
    if (!combos || idx >= combos.length) { finish('done'); return; }
    setT(tick, TICK_MS);
  }

  return { stats: stats };
}

module.exports = { installShaderWarmup, buildCombos, IDLE_MS, HEAVY_IDLE_MS, SLICE_BUDGET_MS };
