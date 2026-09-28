# 架构与设计原理

本页说明 mp-flutter 如何让**未经任何改动**的 Flutter Web/CanvasKit 产物在微信小程序环境里跑起来,
以及几个关键工程决策背后的"为什么"。更详细的能力清单与已知限制见
[`support-matrix.md`](support-matrix.md);面向用户的功能说明见仓库根 [README](../README.md)。

## 1. 问题的形状

Flutter 官方的 `flutter build web` 产物假设自己跑在浏览器里:有 `window`/`document`,有 DOM 合成多块
`<canvas>`,有 `fetch`/`XMLHttpRequest`,有 `Intl`。微信小程序的逻辑层是一个**没有 DOM 的 JS 沙箱**
(V8/JSCore,视平台而定),视图层的 `<canvas>` 之间**没有浏览器式的层叠合成**。整个项目的核心工作
就是在构建期与运行时两侧,把这两个假设之间的落差补上——**不改 Flutter 引擎代码,不改主工程 Dart
代码**。

## 2. 构建管线:两次变换 + 分包

`dart run mp_flutter` 内部调用标准的 `flutter build web`,然后对产物做两处结构化变换(不是逐行改写,
用 AST/正则做结构匹配,上游产物结构变化时会主动报错而不是产出错误结果):

- `canvaskit.js`:ESM → CJS,摘除不适用于小程序运行时的 Safari workaround。
- `main.dart.js`(dart2js 输出):注入模块级 preamble,把 `window`/`document`/`navigator`/`self`/
  `location` 遮蔽成垫片对象,而不是试图去改写 `globalThis`(小程序里 `globalThis.window` 等是
  getter-only,写不进去)。

**main.dart.js 分包切分**:微信小程序单个分包(含主包)源码体积上限 2048KB,而典型 Flutter 应用编译
出的 `main.dart.js` 常常是几 MB。构建期按预算(留出运行时开销余量)把它切成 `pkg-dart-0..N` 多个分
包,每片注入共享的顶层作用域声明,分片之间靠主包里一段生成的"共享作用域"模块传递 dart2js 的顶层
名;体积校验在构建期跑一遍,超限直接失败并指出该挪哪个文件,而不是把一个会在小程序后台被拒绝上传
的产物交给用户。

其余资源按"首帧前是否一定用到"分类下包:`pkg-wasm`(CanvasKit)与首帧必需的字体/AssetManifest 在启
动早期并行加载;NOTICES、其余图片资源、简体中文回退字体分片按需下载,只有真正用到时才触发。

## 3. BOM/DOM 垫片:严格模式

运行时垫片(`runtime/bom-shim.js` 等)提供 dart2js 产物需要的最小 `window`/`document`/`navigator`/
`self` 表面。核心纪律是**严格模式**:未知属性一律返回真正的 `undefined`,绝不返回可调用/可索引的
宽容 Proxy stub。原因是 dart2js 会在互操作对象上探测内部的 dispatch-record 标记,一个"看起来存在"
的 stub 会被误判为已建立派发记录而读出垃圾数据;引擎自身也大量使用 `x != null` 做能力降级,宽容
的 stub 会让所有降级分支失效。垫片内置访问记录(`report()`),用于在升级 Flutter 版本时快速定位
新增的宿主 API 依赖。

`ResizeObserver`、`PointerEvent`、`style.setProperty`、`fetch` 的 `body.getReader()` 流式接口等是引擎
硬依赖、没有降级分支的部分,必须真实实现;`MutationObserver`、`OffscreenCanvas`(在图片解码路径外)、
`FontFace` 等则刻意保持 `undefined`,让引擎自然走无 DOM 降级路径。

## 4. 单 Surface 与原生组件同层叠加

Flutter Web 引擎默认会为 platform view 分配多块逻辑 `<canvas>`,依赖浏览器 DOM 层叠去合成;小程序
没有这种合成机制,多个 CanvasKit Surface 各自刷新同一块物理 WebGL 画布时,后刷新的会整页覆盖先刷
新的。解决方式是在引擎初始化时显式传 `canvasKitMaximumSurfaces: 1`,强制所有内容画进同一块画布。

视频、地图、相机这类无法用 canvas 模拟的原生能力,不走 platform view 的浏览器语义,而是映射成微信
的原生组件(`<video>`/`<map>`/`<camera>`),由一层 WXML 按 Dart 侧的实际布局叠加在 Flutter 画布之
上——即"单 Flutter surface + 原生组件同层叠加"。代价是原生组件只能整体位于 Flutter 图层栈之上,不能
插入图层栈中间,这一限制直接写进了各包文档。触摸与文本输入复用同一条 WXML 位置同步链路:触摸靠
`bind:touchstart/move/end/cancel` 合成 `PointerEvent` 喂给引擎;文本输入靠一个跟随光标位置、双向绑
定的原生 `<input>`。

## 5. CanvasKit 完整版与 ICU 瘦身

标准 Web 部署通常使用不含 ICU 的 chromium 变体 CanvasKit,把断词/断行交给浏览器的
`Intl.Segmenter`/`Intl.v8BreakIterator`。这两个 API 在微信小程序的 JS 引擎上不可靠:iOS 小程序跑在
JavaScriptCore 上,没有 V8 专有的 `v8BreakIterator`,首次排版即抛 `UnimplementedError` 导致白屏;
部分 Android 微信的 JS 引擎连 `Intl` 本身都没有实现,直接启动失败。

解决方式是改用**自带 ICU 数据、断行不依赖任何 Intl API** 的完整版 CanvasKit wasm。代价是体积:完整
版 brotli 压缩后约 2175KB,超过单分包 2048KB 上限。构建期在 wasm 的 ICU 公共数据里,把占体积大头
但使用频率低的泰文/老挝文/高棉文/缅甸文断词词典**清零**(不是删除——ICU 数据按目录表偏移寻址,清
零不改变任何偏移,wasm 结构原封不动),brotli 后降到约 1822KB。ICU 加载这些条目时因数据头校验失
败而按"不存在"处理,这几种文字退化为仅在空格处换行,不影响中/日/韩/拉丁文。

## 6. 常用汉字合一字体

引擎的简体中文回退字体默认被切成约 100 个小分片,一屏中文常常需要拉齐几十个分片,每批到齐都触发
一次全量重排版(`fontsChange`),真机上可能是好几次几百毫秒的重排。对此的优化是随包内置一个按
GB2312 固定字表(一级 3755 字 / 一二级 6763 字两档)切出的单文件字体,构建时对 `main.dart.js` 打两
处结构化补丁,让引擎把它当作 Roboto 之后的第一个回退字体、缺字检测时把它算进已覆盖码点,只把真正
缺失的字交给原有的按需分片机制。字体本身放进独立分包,启动早期就用小程序原生的
`FileSystemManager.readCompressedFile`(代码包文件 + 原生 brotli 解压)直接读出字节——之所以不用
`readFile`,是因为开发者工具与真机上用它读代码包内字体文件会报 `permission denied`;也不再用旧方
案的 base64 内嵌 JS 模块(真机上首次取字体需要 `require.async` 一两个 1MB+ 的模块再解码,延迟很
高)。读取与 wasm 编译、Dart 分片加载并行,CanvasKit 一就绪就立即解析一次并缓存,引擎真正初始化取
字体时直接命中。

## 7. 冷启动关键路径与原生启动界面

首帧提交前必须完成的工作被严格限定为:Dart 分片执行 + CanvasKit(wasm)初始化 + 引擎读取
`FontManifest`/`AssetManifest` 所需的字体与清单 + 合一字体读取。这几项并行加载,其余一切(图片、
着色器、按需字体分片、许可证文本)都推迟到真正被引擎请求时才下载。承载页在 Flutter 首帧提交前显示
一层原生 WXML 启动界面(应用名、背景色、一条按启动阶段估算的进度条),首帧提交后移除;启动失败时
显示错误文案而不是停留黑屏。

## 8. 性能可观测性:`--perf-hud`

构建时开启 `--perf-hud` 会在运行时插入一套按 vsync 归并的性能采样:GL 调用统计、长帧拆解(字体
fetch/解析、排版、着色器编译、纹理上传、原生图片解码各占多少)、字体到达与 `fontsChange` 次数、字
体解析复用次数等,直接输出到控制台。这是定位"哪一步该优化"的主要手段,也是本文档第 6、7 节里给出
的各项数据的采集方式。

## 9. 其余平台桥要点

- **网络/存储**:`package:http`/`dio`/`NetworkImage`/`shared_preferences` 在垫片层被透明替换为
  `wx.request`/`wx.*StorageSync`,主工程无需感知;因为 Flutter Web 产物本身不含 `dart:io`,用的就是
  浏览器式 API,替换点是确定的。
- **图片解码**:小程序画布拿不到通用的离屏 2D 上下文,`cacheWidth`/`toByteData()` 等需要离屏 2D 画
  布的能力,由 CanvasKit 的 CPU 光栅 surface 实现;静态 JPEG/PNG 改由微信原生解码接口解码,同一份
  字节只解一次并做交付限流,避免解码峰值内存与主线程阻塞叠加。
- **随机数**:`Random.secure()`/`crypto.getRandomValues` 在没有 `window.crypto` 的小程序逻辑层里,
  启动时用一次 `wx.getRandomValues` 取真随机种子,喂给 ChaCha20 作确定性随机数发生器,之后本地同步
  产出,不再逐次跨进程往返。

## 10. 已知的硬约束

- 绑定 CanvasKit;若上游 Flutter 转向 skwasm/Impeller Web,渲染接入这部分需要重做。
- 原生组件恒在 Flutter 画布之上,无法插入 Flutter 图层栈中间。
- `main.dart.js` 单个顶层作用域超出分片预算上限时目前无解,依赖 dart2js 侧配合(如 `deferred as`)
  才能进一步拆分。
- 泰文/老挝文/高棉文/缅甸文词内不再有断词换行点(见第 5 节)。

完整的能力矩阵、验证状态与逐项已知限制见 [`support-matrix.md`](support-matrix.md)。
