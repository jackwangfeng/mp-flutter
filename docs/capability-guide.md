# 能力边界与复杂页面指南

mp-flutter 把 Flutter Web(CanvasKit)编译成微信小程序,真机上的瓶颈主要在
iOS——`JavaScriptCore` 没有 JIT,wasm 只能解释执行,复杂页面的排版/绘制耗时
比有 JIT 的安卓/模拟器明显更高。本页汇总用仓库自带压测页在真机上跑出的数据,
以及一个真实电商小程序的线上基线,给"这样写页面撑不撑得住"提供可操作的经验
值。数字来自具体设备和具体页面结构,**不是精确上限,请以自己页面的真机实测
为准**。

## 1. 测试方法

**压测页**位于 `example/lib/stress`,只在编译时加
`--dart-define=MP_STRESS=true` 才会进最终产物(不加时对产物体积/行为零影响,
`main()` 按这个编译期常量二选一 `runApp`,dart2js 会摇树掉未选中的分支)。页
面首帧自动依次跑完 A→G 七项,每项跑完打印一行 `[mp-stress]`,全部结束打印
`[mp-stress] done`。

A–G 各项定义:

| id | 内容 |
|---|---|
| A | 长列表:500 行,每行缩略图 + 两行文字 + 一个粗体价格 |
| B | 图片墙:`GridView` 3 列、120 张不同图片(92 种 id×宽度组合,验证图片缓存按 URL 算 key 的淘汰行为) |
| C | 长图文一次性构建:`Column` 里 180 段、共 6036 字,`SingleChildScrollView` 包裹 |
| D | 与 C 相同内容,改用 `ListView.builder` 懒加载 |
| E | 大表单:30 个输入框(含 `Switch`/`Radio`/`Dropdown`),滚动后依次切换前 5 个输入框的焦点 |
| F | 效果:40 张卡片,`BoxShadow` + `Opacity` + `ClipRRect`,每 8 张叠一次 `BackdropFilter` 模糊 |
| G | 原生组件:`MpVideo` + `MpMap`(依赖 `mp_flutter_native`,小程序后台需已开通对应能力) |

**构建**(示例,真机建议把图片来源换成自己的图床):

```bash
cd example
dart run ../packages/mp_flutter/bin/mp_flutter.dart \
  --output build/weapp_stress \
  --appid <你的 appid> \
  --perf-hud \
  --dart-define=MP_STRESS=true \
  --dart-define=STRESS_IMG='https://<你的图床>/img/{i}?w={w}&v={k}' \
  --dart-define=STRESS_IMG_N=<图床实际 id 个数> \
  --dart-define=STRESS_IMG_WIDTHS=160,320,480,640
```

不传 `STRESS_IMG*` 时默认用 `https://picsum.photos/seed/{i}/{w}/{w}`(国内访问
可能慢)。用微信开发者工具打开 `build/weapp_stress`,「详情→本地设置」取消勾
选「将 JS 编译成 ES5」和「增强编译」;真机测量走「预览」/「真机调试」把二维
码发到手机,或提交体验版。真机上小程序首帧自动开始跑完 A→G,不用手动点击;
需要重跑某一类设备时,同一份产物直接在对应真机上再跑一遍即可(每次冷启动都
会重新走完整套)。

**测量工具**:

- `--perf-hud`(见 [`packages/mp_flutter/README.md`](../packages/mp_flutter/README.md)
  「真机性能测量」一节):每秒一行 `[mp-perf]`,字段为 `fps`、
  `frame(avg/p95/max ms)`、`gl(calls/frame, ms/frame)`、`decode(count, ms)`、
  `longTasks`(单帧超过 50ms 的次数)、`dart~=<ms>(est)`(粗略估算的
  Dart/框架耗时)。
- 压测页自身输出的 `[mp-stress]` 行,每项一条,格式为
  `[mp-stress] <id> first=<首帧ms> fps=<滚动期间 fps> max=<最长单帧ms>
  jank50=<>50ms 帧数> jank100=<>100ms 帧数> frames=<总帧数> extra=<各项自定义字段>`。

**测试设备**:iPhone 15(iOS 26.5)、Xiaomi 2206122SC(Android 15,API 35),
微信 8.0.78,基础库 3.17.3。使用 v0.2.1 默认配置(常用汉字合一字体
`cjk_font: full` + 真粗体 `cjk_font_bold`,未额外调整任何构建参数)。

## 2. 真机数据(iPhone 15)

| id | 首帧(ms) | fps | 最长帧(ms) | >50ms 帧 | >100ms 帧 | 备注 |
|---|---:|---:|---:|---:|---:|---|
| A 长列表(500 行) | 206 | 43.1 | 1061 | 5 | 2 | 最长帧里 946ms 是本次会话首次出现的着色器一次性编译,属于一次性开销 |
| B 图片墙(120 张,92 种组合) | 103 | 57.1 | 34.6 | 0 | 0 | 无 jank |
| C 长图文一次性构建(180 段/6036 字) | 592 | 59.7 | 23.5 | 0 | 0 | — |
| D 同内容 `ListView.builder` 懒加载 | 134 | 58.1 | 51 | 1 | 0 | 首帧比 C 快 4.4 倍 |
| E 大表单(30 输入框) | 265 | — | 125 | 6 | — | 切换聚焦期间 >100ms 帧 6 个;单次聚焦最长 61ms |
| F 效果(40 卡片,阴影/半透明/圆角裁剪+`BackdropFilter`) | 85 | 32.6 | 57.2 | — | — | — |
| G 原生组件(视频+地图) | 88 | 43.6 | 64.5 | — | — | — |

冷启动(iPhone 15):**3.76s**。

**安卓(Xiaomi 2206122SC,同一构建)**:A fps 55.3、最长帧 48ms、无 jank;
B fps 58、最长帧 22ms、无 jank。C–G 因真机调试链路延迟、日志未传完,本轮未
采集到;按 A、B 两项以及以往数据推断,安卓整体优于 iOS,大约快 2–2.5 倍。

**模拟器(有 JIT)**:全部七项均为 60fps。模拟器有 JIT,这个结果只能说明压
测页本身工作正常(无异常、无死循环),**不能代表真机表现**,真机容量请以上
表为准。

## 2.1 着色器预热 + 表单聚焦修复后复测(iPhone 15,同一台真机)

第 7 节列出的"着色器预热"与"表单聚焦卡顿"两项待优化已落地(空闲期着色器
预热 + iOS 光标默认常亮,见下文与 `packages/mp_flutter/runtime/shader-warmup.js`
文件头注释)。同一台 iPhone 15 复测:

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| A 长列表:最长帧(ms) | 1061 | 97 |
| A 长列表:>100ms 帧数 | 2 | 0 |
| A 长列表:fps | 43 | 56 |
| E 大表单:>100ms 帧数 | 6 | 4 |
| 冷启动 | 3.76s | 3.45s |

A 项最长帧从 1061ms 降到 97ms、>100ms 帧清零:着色器预热提前编译了长列表用
到的 program(见第 7 节),本次会话首次进入不再触发同步编译。E 项
`>100ms` 帧数从 6 降到 4:iOS 光标默认改为常亮(不再逐 vsync 闪烁动画),
消除了聚焦期间由光标动画驱动的持续整屏合成/光栅化;剩下的长帧来自框架
`EditableText`/`InputDecorator` 本身的构建/绘制开销,运行时层面已经降到头
(见下文"表单性能"与第 4/6 节)。冷启动 3.76s→3.45s 是本轮几个性能分支
(常用汉字合一字体去重、字体解析合并窗口、着色器预热等)叠加后的整体效果,
不只是本节两项改动单独贡献。

## 2.2 冷启动优化(开关与真机 A/B)

iPhone 15 预览模式首次下载的时间线(`--perf-hud` 的 `[mp-boot]`)显示,首帧前真正的关键路径是
"dart/wasm 分包全部就位 → 编译 CanvasKit → 执行 Dart → 初始化引擎(等常用汉字字体)→ 首帧",
而 7 个分包的 `require.async` 几乎同一时刻发出,粗体字体(约 1.2MB)从第一毫秒就在和它们抢带宽。
据此落地了五项,每项都能单独开关(见根 README「冷启动开关」):

| 开关 | 默认 | 预期收益(真机待测) |
|---|---|---|
| `cjk_font_bold_timing: after_first_frame` | 开 | 首帧前少下载约 1.2MB(首帧前字节的 17–24%),估计首次下载省 0.4–0.7s;首帧里粗体先合成加粗,空闲时补注册一次 |
| `early_wasm` | 开 | CanvasKit 编译不再等 dart 分包,估计 80ms 起(安卓 wasm 编译更慢,可能 150–300ms);缓存启动同样受益 |
| `preload: auto`(= dart 优先) | 开 | 0–300ms,取决于原生下载是否限并发 |
| `boot_assets: auto`(并进主包) | 开 | 少一个首帧前分包请求,取决于每个分包的固定开销(预览模式可能几百 ms) |
| `initial_rendering_cache` + `lazy_code_loading` | 开 | 第二次起冷启动,启动界面提前 100–300ms 上屏;不改首帧时间 |

**模拟器前后对比**(example,`--perf-hud`,各 5 次中位数,距 `App.onLaunch`):首帧 +574ms → +561ms,
dart-chunks +412 → +405、canvaskit +370 → +376,差异在噪声内;`pkg-assets-boot` 那一行消失,粗体
请求从 +100ms 挪到首帧之后(+633–644ms)。开发者工具里分包是本地文件、不走网络,"少抢带宽"类的
收益在这里体现不出来,只能验证顺序与正确性——**收益要以真机数据为准**。

**真机 A/B 怎么做**:同一份代码出两版,只差一个开关(例如 `--cjk-font-bold-timing=eager`、
`--no-early-wasm`、`--preload=wasm`、`--boot-assets=package`),每版扫码 3 次取中位数,iOS/安卓各一台;
预览版每次扫码都会重新下载(最坏情况),体验版再分别测首开与"最近使用"重开(缓存路径)。看:

- `[mp-boot] first-frame` / `total`;
- `[mp-boot] pkg <name> req=… dl=+a..+b inject=… ready=…`:`dl` 是 `wx.getPerformance` 给的真实下载窗,
  各包 `dl` 是否重叠能直接看出原生下载是否并发、每包固定开销多大;dart 分包的 `inject` 是 JS 注入(解析)
  耗时,缓存启动也存在;
- `[mp-boot] ck-wait-dart`:为正说明 wasm 编译已完全藏在 dart 分包后面;
- `[mp-boot] wx route(appLaunch)`、`firstRender`:onLaunch 之前与视图层的时间。

## 3. 真实电商小程序的基线(匿名)

以下数据来自一个真实电商小程序线上版本(与上面的压测页是两回事,压测页是
人工构造的极端场景,这里是业务真实页面):

- 冷启动:iOS 约 3.9s、安卓约 4.2s
- 首页网格稳态帧率:iOS 40–55fps、安卓 50–61fps
- 详情页首次打开(15 段内容):字体合成加粗时 layout 耗时 102–243ms,换成真
  粗体(`cjk_font_bold`)后降到 4–54ms;剩余的长帧(54–125ms)主要来自新路由
  的构建与绘制,与字体无关
- **经验教训**:早期版本中文靠按需回退字体分片,一屏文字命中多个分片时会
  连续触发 `fontsChange`,某次触发了 118 段全量重排,iOS 上耗时约 700ms;
  v0.2.x 起默认使用常用汉字合一字体(`cjk_font`)已解决这个问题(单文件字
  体,首屏基本不再触发按需分片)

## 4. 能撑多大(经验值,以你的页面实测为准)

- **列表**:用 `ListView.builder`/`GridView.builder` 懒加载时,行数基本不受
  限;iOS 稳态 40–55fps,安卓 55–60fps。一次性用 `Column` 铺开等价内容会显
  著拉长首帧(见上表 C vs D)。
- **图片**:原生解码,同屏十几张、全程累计上百张都没问题。缩略图请让服务端
  按实际显示尺寸出图,不要传 `cacheWidth` 让客户端缩放——Web 引擎会先按原尺
  寸解码一遍再缩放,内存峰值不会因为传了 `cacheWidth` 而降低,等于多花一次
  解码开销。
- **文字**:懒加载(逐段/逐 item 构建)时段落数不受限;一次性塞进一个
  `Column` 时,6000 字左右在 iOS 上首帧约 600ms(见上表 C)。按这个数据线性
  估算(**估算值**,不代表其他内容结构),建议单页一次性构建的文字控制在约
  1500 字 / 50 段以内,超过就改用 sliver/`ListView.builder` 分段懒加载。
- **表单**:iOS 上切换输入框焦点仍可能有长帧,但已比修复前显著减少(见 2.1
  小节);超过 10–15 个输入框的表单建议分步(多步表单)或分页,避免一次性
  铺开。大表单的列表部分(输入框整行整行铺开)用 `ListView(itemExtent: …)`
  或 `prototypeItem`,或给每个输入框包一层固定高度:标签浮动动画触发的重
  布局会被框定在该 relayout boundary 内,不再级联到整个可见视口重绘(压测
  页实测:每帧重绘的 `RepaintBoundary` 数从 10 降到 1)。不需要浮动标签效果
  时优先用 `hintText`,或把 `InputDecoration.floatingLabelBehavior` 设为
  `FloatingLabelBehavior.always`,省掉聚焦/失焦各约 10 帧的标签动画。
- **效果**:大面积 `BackdropFilter` 模糊或阴影会把 iOS 帧率拉到约 30fps
  (见上表 F),少用,尤其避免大面积/多处叠加使用。

## 5. 特别贵的写法

以下写法在真机(尤其无 JIT 的 iOS)上实测开销明显,应尽量避免:

- 一次性用 `Column`/`Row` 铺开长内容(整页一次性 layout,见上表 C)
- `IntrinsicHeight`/`IntrinsicWidth`:子树会被多布局一遍来量尺寸,相当于每
  行排两遍版
- 请求字重(≥600)但字体没有对应真实字重时的合成加粗(`SkFont embolden`):
  每个字形第一次出现都要逐点加粗轮廓、重算边界;v0.2.1 已为常用汉字提供真
  粗体(`cjk_font_bold`),自定义字体如果需要粗体,请自带真实的 Bold 字重文
  件,不要依赖合成加粗
- 频繁的整页 `setState` 重建(尤其是包含大量文字/复杂布局的页面)
- 大面积模糊、阴影、`saveLayer`(比如 `Opacity` 包裹复杂子树)
- 某个视觉效果(着色器)在本次会话里第一次出现时触发的着色器编译:一次性开
  销,约 1s 量级(见上表 A 的最长帧),已列入待优化(见第 7 节)
- 对缩略图传 `cacheWidth`/`cacheHeight`(见第 4 节「图片」)

## 6. 推荐写法和替代方案

- 列表和长内容一律用 `ListView.builder`/`GridView.builder`/`SliverList` 等
  懒加载组件,不要用 `Column` 一次性铺开
- 详情页富文本按段落拆成 sliver,而不是拼成一个大 `Column`
- 用 `RepaintBoundary` 隔离页面里不常变化的静态区域,避免它们跟着动态区域
  一起重绘
- 图片缩放交给服务端(按显示尺寸出图),客户端不做 `cacheWidth` 缩放
- 长表单拆成多步(分步表单/分页),减少同屏输入框数量;表单内的输入框列表
  用 `itemExtent`/`prototypeItem`(或固定高度),不需要浮动标签就用
  `hintText`(见第 4 节「表单」)
- 动画优先用 `Transform`/`Opacity` 这类可以走合成层的动画,避免逐帧触发
  layout/paint
- 转场动画期间不要排大段文字/复杂布局,等转场动画结束后再把数据/内容换上去

## 7. 已知待优化项(与已落地的修复)

- **着色器预热**(已落地,见 2.1 节):首帧之后、引擎空闲(最近 150ms 内没
  有 flush、也没有手指按着屏幕)时,在共享 `GrDirectContext` 的离屏渲染目标
  上把常见绘制组合逐个画一遍,提前编译对应的 GL program。按单个 program 的
  编译/链接开销分成"轻项"(文字、纯色矩形/圆角、图片、圆、描边、路径…)与
  "重项"(阴影、`BoxShadow`/`BackdropFilter` 模糊、颜色矩阵/混合——真机上单
  个 program 可达上百 ms):轻项一片最多画 8ms 就让出主线程,剩下的留到下一
  次空闲检查;重项没法再拆,要求最近 1s 内既没有画面刷新也没有手指按着才画,
  每片只画一个。`shader_warmup`(默认开)配置项可关闭;新增
  `shader_warmup_light`(默认关)只画轻项、跳过全部重项,给对预热本身占用主
  线程更敏感的场景用。详见
  [`packages/mp_flutter/runtime/shader-warmup.js`](../packages/mp_flutter/runtime/shader-warmup.js)
  文件头注释。
- **表单聚焦卡顿**(已定位根因并修复主要来源,见 2.1 节):真正的根因是 iOS
  目标平台下 `TextField` 光标的淡入淡出动画——`AnimationController` 每个
  vsync 都要 tick,聚焦期间因此持续 60fps 整屏合成+光栅化。运行时入口包装
  现在默认把 `EditableText.debugDeterministicCursor` 设为 `true`(光标常亮、
  不闪烁);如果产品确实需要闪烁光标,可以在自己的 `main()` 里显式设回
  `EditableText.debugDeterministicCursor = false`,代价是聚焦期间会恢复持续
  60fps 出帧。**密码框例外**(已修复,I1):`obscureText` 输完一个字符后短暂
  明文显示、随后自动隐藏,隐藏靠的正是光标 tick 计时,常亮光标会让这个计时
  永远不走、最后一位一直明文显示到下一次输入或失焦——入口包装监听密码框的
  聚焦/失焦(text-bridge.js 通知),聚焦期间临时恢复正常闪烁,不需要应用自己
  处理。这项改动之外,快速切换焦点场景(压测默认模式)单帧成本来自
  `EditableText`/`InputDecorator` 框架本身的 build/paint,运行时层面已经降
  到头;进一步收益要靠页面结构(见第 4/6 节的 `itemExtent`/`prototypeItem`/
  `hintText` 建议)。
- **`--perf-hud` 的 `other` 细分**:目前 `dart~=<ms>(est)` 是帧总耗时减去
  gl、decode 耗时后的粗略估算,还没有进一步拆分 layout/paint/其他框架开销,
  影响进一步定位卡顿具体来源的精度

## 相关文档

- [`packages/mp_flutter/README.md`](../packages/mp_flutter/README.md)「真机
  性能测量」一节 —— `--perf-hud` 的完整参数、字段含义、怎么在真机调试控制
  台看
- [`docs/support-matrix.md`](support-matrix.md) —— 工具链版本、平台桥验证状
  态、已知限制汇总
- [`example/`](../example/) —— 示例工程,`lib/stress` 是本页数据来源的压测
  页源码
