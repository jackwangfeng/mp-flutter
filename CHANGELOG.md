# Changelog

## 0.2.3 — 2026-09-30

新增着色器预热与表单/输入体验优化,减少长列表、大表单等场景的卡顿,并修复真机
复测中发现的密码框、多指触控、文本桥唤醒等问题。

- **着色器预热**(`shader_warmup`,默认开;`--no-shader-warmup` 关):首帧之后趁空闲(最近
  150ms 引擎没有出帧,也没有手指按着屏幕),在引擎的 GrDirectContext 上的离屏目标里逐组画
  常见绘制组合(文字、圆角裁剪图片、阴影、BoxShadow 模糊、渐变、半透明层、BackdropFilter…),
  让 GL program 提前编译;有动画/滚动/触摸即暂停。引擎各 CkSurface 的 GrDirectContext 合并
  成一个(小程序里它们本就共用一个 WebGL 上下文),预热与 toImage 路径共享 program 缓存。
  框架的 `PaintingBinding.shaderWarmUp` 在 Web 上画在 pictureToImageSurface 的另一个
  GrDirectContext 上,预热不到屏幕用的缓存。
- **每片时间预算 + 重组合拆分**:按单个 program 的编译/链接开销把绘制组合分成"轻项"
  (文字、纯色矩形/圆角、图片、圆、描边、路径…)与"重项"(阴影按遮挡 flags 拆成
  opaque/transparent 两项、`BoxShadow`/`BackdropFilter` 按核宽拆、颜色矩阵/混合各一项)——
  真机上重项单个 program 可达上百 ms,拆开后一项只对应一个 program。轻项一片(一次
  空闲检查)最多画 8ms 就让出主线程,剩下的留到下一次空闲检查;重项没法再拆,改为要求
  最近 1s 内既没有画面刷新也没有手指按着才画,每片只画一个,解决了真机实测单片 426ms
  的长任务。新增 `shader_warmup_light`(默认关;`--shader-warmup-light`)只画轻项、
  跳过全部重项,给对预热占用主线程更敏感的场景用。
- **iOS 光标常亮**:iOS 目标平台下 TextField 光标的淡入淡出动画让聚焦期间一直以 60fps 出帧
  (每帧整屏合成 + 光栅化);入口包装改成光标常亮不闪(`EditableText.debugDeterministicCursor`),
  聚焦后没有别的动画就不出帧。应用可在 `main()` 里设回 `false` 恢复闪烁。
- **修复密码框最后一位明文常驻**:上面这项常亮光标关掉了 iOS 光标 tick,而
  `obscureText` 输完一个字符后短暂明文显示、再自动隐藏,恰恰是靠这个 tick 计时——
  停用后最后一位会一直明文显示,直到下一次输入或失焦。text-bridge.js 在检测到聚焦/
  失焦元素是 `password:true` 的密码框时通知入口包装(`self.__mpPasswordFocus`),聚焦时
  临时把标志切回 `false`、失焦后恢复 `true`,不影响其余 iOS 输入框仍然常亮。
- 文本输入桥:聚焦后 500ms 内几何/值没有变化,轮询从 16ms 退到 100ms,有变化立即恢复;
  新增触摸画布(`touchstart`)、键盘高度变化(`wx.onKeyboardHeightChange`)
  时主动 `wake()`,缩短退避后引擎侧变化同步到原生框的最坏延迟。
- **修复着色器预热的多指触控计数**:`pointerState.down` 以前按 touchstart/touchend
  事件次数 ±1,两个手指分两次按下、一个 touchend 一起抬起(`changedTouches` 含 2 个)会让
  计数卡在 1、预热一直暂停到 120s 超时。改成直接取 `e.touches.length`(当前仍停留在屏幕
  上的触摸点数),没有 `touches` 字段时按 0 处理。
- `--perf-hud`:长帧明细拆出框架各阶段(`dart=(build/layout/paint/comp/…)`,入口包装经
  `self.__mpFrameProf` 上报)、光栅化 `raster=`(并入 rAF 之后的异步光栅化)、文本桥
  `tb=`/`setData=`、`resize=`;每个 GL program 一行 `[mp-perf] program`(编译耗时 +
  attribute/uniform 摘要 + 源码哈希);着色器预热每画完一项打一行
  `[mp-perf] shader-warmup item`,汇总行加 heavy/skipped 计数;有原生 `performance`
  时用亚毫秒时钟。
- 真机(iPhone 15)复测:长列表(A)最长帧 1061→97ms、>100ms 帧 2→0、fps 43→56;
  大表单(E)>100ms 帧 6→4;冷启动 3.76→3.45s。详见
  [`docs/capability-guide.md`](docs/capability-guide.md) 2.1 节。
- `docs/capability-guide.md`:补充大表单 `itemExtent`/`prototypeItem`、优先 `hintText`、
  长表单分步、iOS 光标常亮与如何恢复闪烁的指南。

## 0.2.2 — 2026-09-30

新增仓库自带的真机压测页与测量工具,并把首批真机压测数据整理成一篇能力边界
文档;不涉及运行时/构建管线代码改动。

### 压测页与测量工具

- **压测页**(`example/lib/stress`):只在编译时加 `--dart-define=MP_STRESS=true`
  才会进最终产物,不加时对产物体积/行为零影响(`main.dart` 按这个编译期常量
  二选一 `runApp`,dart2js 会摇树掉未选中的分支)。首帧自动依次跑完七项场景:
  长列表(A)、图片墙(B)、长图文一次性构建(C)与懒加载对照(D)、大表单
  (E)、视觉效果(F)、原生组件(G),每项打印一行 `[mp-stress]`(首帧、fps、
  最长帧、jank 帧数等)
- **`tools/e2e/accept-stress.js`**:自动构建 `example`(带 `MP_STRESS=true` 与
  `--perf-hud`)、在微信开发者工具里跑完整套 A–G,收集 `[mp-stress]`/
  `[mp-perf]` 遥测行并打印汇总表,断言七项均有输出、无 console error
- **`tools/e2e/test-server.js`**:新增 `/stress/img/:id/:w`(按 id/宽度确定性
  生成纯色 PNG,压测页图片墙用,不依赖外网图床)与 `/stress/redirect/:id/:w`
  (302 跳转到前者,验证图片跳转后仍能正常解码)

### 文档

- 新增 [`docs/capability-guide.md`](docs/capability-guide.md)「能力边界与复杂
  页面指南」:iPhone 15 / 安卓真机压测数据(七项场景的首帧/fps/最长帧)、一
  个真实电商小程序的线上基线、"能撑多大"的可操作经验值(懒加载列表行数不受
  限、一次性构建文字建议控制在约 1500 字/50 段以内、表单超过 10–15 个输入框
  建议分步、大面积 `BackdropFilter`/阴影会把 iOS 帧率拉到约 30fps 等)、特别
  贵的写法与推荐替代方案
- README、`docs/support-matrix.md` 补充指向新指南的链接

## 0.2.1 — 2026-09-28

在 0.2.0 的基础上给常用汉字合一字体补上真粗体子集,并修复 E2E 交互回归脚本在新版
基础库下的一处 RPC 兼容问题。

### 合成加粗

- **合一字体粗体**(`cjk_font_bold: level1 | full | false`,`--cjk-font-bold=...`,默认跟随 `cjk_font`,
  必须与它同档):Noto Sans SC v37 Bold 子集(同一字表,OFL 1.1,入库),与常规合一字体同一 family、
  字重 700 注册,w≥600 的中文(标题、价格)不再由 CanvasKit 合成加粗。起因:iOS 真机进商品详情页那一帧
  200–400ms,layout 占大头(15 段、每段 10–16ms)。真实 CanvasKit(完整版 wasm)基准,30 个没出现过的
  汉字、22px:JSC 关 JIT(近似 iOS 小程序)常规 7.3ms / 合成加粗 30.5ms / 真粗体 7.4ms;先用 w400
  预热同一字符串再测 w700 仍是 30.5ms——开销在逐字形加粗轮廓,不在 shaping;字形缓存热了之后三者
  都是 0.2ms。V8 JIT 下 0.32 / 1.05 / 0.27ms。粗体放独立分包 `pkg-cjkb`(full 约 1.17MB,level1 约
  660KB br;与 full 常规合包会超 2048KB),boot 在 dart/wasm 分包请求之后才读;只要不晚于常规字体到
  就随 FontManifest 一起注册(零额外等待、不发 fontsChange,模拟器实测引擎取用等待 0–1ms),晚到则
  先 404、首帧照常,到了再经入口包装 `ui.loadFontFromList` 补注册(一次 fontsChange;模拟器该真实电商小程序首页
  54 段重排 13ms,字形缓存是热的)。不同档会出豆腐块(同一 family 下 SkParagraph 按字重只选一个字体,
  而引擎缺字检测按家族取并集),构建期直接报错。该真实电商小程序总包 +1.17MB
- `--perf-hud`:长帧/间隔明细里的 `fakeBold=N`(本帧 build 的合成加粗段落数:字重 ≥600 而字体列表里
  没有注册过粗体的家族),每秒行 `layout=…(fakeBold n)`;首帧前诊断行 `cjk-bold pkg/read/parse`、
  `cjk-bold 随常规字体注册` / `未就绪,首帧不等(404)` / `补注册`
- **实测**:该真实电商小程序 iOS 真机详情页首次打开的 layout 长帧从 102–243ms 降到 4–7ms
  (典型值),冷启动耗时不受影响(约 3.9s,与 0.2.0 持平)

### E2E

- `tools/e2e/drive.js`:微信开发者工具基础库升级到 3.17.4 后,`Page.callMethod` 这条
  自动化 RPC 本身坏了(`No context found for objectId`),导致 `accept-interact.js`/
  `accept-wx.js` 偶发报错;绕开为改走始终正常的 `mp.evaluate()`(`App.callFunction`),
  在 App Service 层用 `getCurrentPages()` 拿到当前页面真实实例后直接调用同名方法,
  效果与框架原生派发等价;同时补充"句柄过期自动重取重试"的通用兜底,两者互不影响

## 0.2.0 — 2026-09-28

在 0.1.0 的基础上补齐三类运行时缺口(随机数、路由切换崩溃、图片离屏解码)、修复两处
真机启动/渲染问题(iOS 白屏、部分安卓启动失败),并完成一轮包体积与冷启动性能收尾
(分包重组、常用汉字合一字体、原生图片解码、字体缓存)。

### 运行时缺口补齐

- **`Random.secure()` / `crypto.getRandomValues` / `crypto.randomUUID`**:小程序逻辑层没有
  `window.crypto`,之前直接抛 `Unsupported`。现在启动时用 `wx.getRandomValues` 取一次真随机
  种子,喂给 ChaCha20(RFC 8439)当确定性随机数发生器,之后本地同步产出;重播种失败自动换钥、
  取熵 10 秒超时、计数器回绕前换钥;播种提前到 `loadSubpackages` 阶段与 CanvasKit 加载并行发
  起,不阻塞启动关键路径,播种失败/超时按浏览器无该 API 的标准语义处理,不伪造安全性
- **路由切换崩溃修复**:滚动帧密集时 push/pushReplacement 偶发触发
  `Null check operator used on a null value` / `Cannot read properties of null (reading
  'cullRect')`(CanvasKit 渲染管线内部)。根因是垫片缺 `self.scheduleImmediate`,导致 Dart
  微任务退化为 `setTimeout` 调度,下一帧得以插进 `draw()` 的 `await` 与 preroll 之间,读到一张
  在途 dispose 的 `SkPicture`。已修复;复测未再复现该崩溃
- **`Image.cacheWidth`/`cacheHeight` 与 `toByteData()`**:小程序画布拿不到通用离屏 2D 上下文,
  改由 `runtime/image.js` 的 SoftCanvas 用 CanvasKit CPU 光栅 surface 实现(`drawImage`/
  `getImageData`/`toDataURL`/`transferToImageBitmap`);`toByteData(rawRgba)` 返回非预乘
  RGBA 像素(与浏览器一致,与 Flutter 原生平台预乘不同);大图 `toByteData` 峰值内存约为
  `宽×高×4` 的 3 倍,压在 wasm 堆上

### 微信隐私接口

- `--private-info=<接口名>`(可重复)/ `mp_flutter.yaml` 的 `private_infos`:按需声明任意
  隐私接口(`getLocation`/`chooseLocation`/`choosePoi` 等),写入 `app.json` 的
  `requiredPrivateInfos` 与对应权限说明;`--require-location` 保留为等价于
  `--private-info=getLocation` 的历史开关

### 体积与冷启动

- **首帧前只加载必需分包**:以前 boot 在首帧前并行拉取全部分包(某真实电商小程序约 10MB);现在
  只拉 `pkg-dart-*`、`pkg-wasm` 与新的启动资源包 `pkg-assets-boot`(FontManifest/
  AssetManifest、清单里声明的字体、回退 Roboto),其余资源按需下载。该真实电商小程序首帧前阻塞
  下载 10.04MB → 6.33MB(不在预下载里的 8.26MB → 4.45MB;当前默认 `cjk_font: full`
  下的数字,含独立分包 `pkg-cjk` 的约 1.1MB——见下方"常用汉字合一字体")
- **资源分包重组**:NOTICES 单独放 `pkg-notices`;简体中文回退字体分片按"常用字优先 +
  码位邻近"分进约 512KB 的 `pkg-fonts-*`;其余资源按路径分进约 512KB 的 `pkg-assets-*`
- `--no-licenses` / `licenses: false`:NOTICES 换成空占位(许可证页仍可打开,只是不列出
  第三方包)
- `font_base_url` / `--font-base-url`:实际移到远端的是 `notosanssc`(简体中文回退,全部
  101 个分片)——`roboto` 始终留在包内;emoji/日文/韩文/繁体等其余家族本来就不打包(不受
  这个开关影响,一直是 404)。运行时从 CDN 拉取并缓存到本地文件(10MB 上限,LRU);产物下
  输出待上传目录 `mp-fonts-remote/`
- 原生启动界面:首帧前显示应用名(`splash_title`)、背景色(`splash_color`)与进度条,
  启动失败时显示错误文案
- 构建成功提示里提醒:开发者工具界面打开产物时需取消「将 JS 编译成 ES5」「增强编译」

### 字体到达引发的整体重排

- **常用汉字合一字体**(`cjk_font: level1 | full | false`,`--cjk-font=level1|full` / `--no-cjk-font`,
  默认 full):Noto Sans SC v37 子集(level1 = GB2312 一级 + 标点/全角/Latin-1/常用符号,TTF 1.2MB;
  full = 一二级,2.2MB;入库,`tools/fonts/gen_cjk_common.py` 可复现),brotli 后放独立分包 `pkg-cjk`,
  boot 一开始就用 `readCompressedFile` 读出、CanvasKit 就绪即预解析,引擎初始化时直接应答;
  `main.dart.js` 构建期补丁让引擎把它当作 Roboto 之后的第一个回退字体、缺字检测时算上它并只把
  真正缺的码点交给选字体算法。该真实电商小程序(开发者工具,full)首屏回退分片 fetch 20→0、fontsChange 5→0、
  >50ms 长帧 3–4→0。真机数据显示 `full` 不在首帧关键路径上(字体读取 28–30ms,首帧 354/533ms),
  而 `level1` 会因服务端下发文案命中二级字/常用符号触发额外回退分片下载与 fontsChange,因此把
  默认从 level1 改为 full。**注意**:`cjk_font` 默认开启会给总包增加约 1.1MB(`pkg-cjk`,brotli
  后约 1.15MB,该真实电商小程序实测总包 10.05MB → 11.21MB);服务商代开发小程序总包上限 20MB,总包已经
  接近上限的应用升级前请确认还有余量,或用 `--cjk-font=level1` / `--no-cjk-font` 收窄/关闭
- **常用符号子集扩充**:iPhone 真机首屏仍触发一次 NotoSansSC v37 分片 119(`NexQ2w.119.woff2`)
  下载并引发一次 fontsChange、215ms 长帧;字表补充通用标点 U+2000–206F、箭头 U+2190–21FF、
  €℃№™、常用数学运算符(∑√∞∫≈≠≤≥)、带圈数字 ①–⑳、制表符小集合(┌┐└┘├┤┬┴┼─│)与
  几何图形/五角星(●○■□▲△▼▽◆◇★☆);level1 TTF 1,152,356→1,166,672 字节(br 662,319→664,089),
  full TTF 2,149,868→2,170,200 字节(br 1,171,426→1,173,234),仍远低于单分包 2MB 上限
- 同一份字体字节只解析一次(引擎每注册一批回退字体都重注册全部字体,不再重复解析)
- 回退字体响应按 100ms 窗口合并,窗口内的多批缺字只触发一次 fontsChange
- 同一个未下载的按需分包只发一次 `require.async`(安卓真机字体 fetch 恰好 1001–1003ms 的疑因)
- `--perf-hud`:`cjk-font pkg/read/parse/引擎取用等待` 首帧前诊断行、`font-change #n` 与每秒行的
  `fontChange=`、字体解析复用次数 `(reuse n)`

### 修复

- **iOS 真机白屏**(`UnimplementedError: v8BreakIterator is not supported.`)
  与**部分安卓真机启动失败**(`ReferenceError: Intl is not defined`):改为打包
  完整版 CanvasKit(wasm 自带 ICU 断行,不依赖 `Intl.Segmenter`/
  `Intl.v8BreakIterator`),iOS/安卓/模拟器统一只打这一个变体;为放进单个分包,
  构建期清零 ICU 里泰/老/高棉/缅文的断词词典(这四种文字词内不再给换行机会)。
  `pkg-wasm` 分包由约 1573KB 增至约 1822KB。垫片对 `Intl` 等可能缺失的宿主
  全局改为 `typeof` 探测,没有 Intl 时给引擎一个只有 `Locale` 的最小替身
- `--force-platform` 新增 `ios`(遮蔽 `Intl.v8BreakIterator`/`Intl.Segmenter`)与
  `android-noIntl`(遮蔽整个 `Intl`),`tools/e2e/run.sh` 新增同名配置,在开发者
  工具里复现真机 JS 引擎的能力缺失

### 性能批次收尾

- **原生图片解码生命周期**:成功后立即释放已解码字节(按需从临时文件读回),临时文件不再
  与单份 `SkImage.delete()` 绑定(真机上引擎会反复对同一原生图片对象请求/丢弃惰性
  `SkImage`,没有真正意义上的"最后一次",绑定会在下一次请求时出错);改为总字节数
  (64MB)顶到上限时才淘汰已使用且最久未用的文件,淘汰/磁盘空间不足/总字节超限均不计入
  原生解码失败计数
- `cacheWidth` 缩放遇到"整块全透明"时,先用 wasm 解一遍源图确认不是真透明才判定 2D 画布
  不可用,避免误判真正透明的图片
- `--perf-hud` 相关代码(`perf-hud.js`、图片统计对象)只在开关打开时才写进产物/构造,不
  影响未开启时的产物体积与运行时开销
- 合一字体(`cjk_font`)读取加 10 秒超时,超时按读取失败处理,不阻塞启动
- 远端字体缓存索引(`font-cache.js`)命中时节流写 `index.json`(2 秒一次)

## 0.1.0 — 2026-09-28

首个对外版本。把现有 Flutter 工程编译成微信小程序,主工程零 Dart 代码改动。

### 新增

- **构建管线**(`mp_flutter`):`dev_dependencies` 引入即用,`dart run mp_flutter`
  一条命令产出小程序;`mp_flutter.yaml` 可选配置文件(`appid`/`output`/
  `flutter`/`esbuild`/`require_location`/`semantics_mirror`/`dart_define`);
  `dart run mp_flutter doctor` 自检本机工具链;工程根自动向上探测;
  `--dart-define`/`--dart-define-from-file` 透传给 `flutter build web`;
  main.dart.js 超过分包体积上限(2048KB)时构建期自动分片,业务代码无需配合
- **安全区**:构建生成的入口包装自动把小程序安全区注入
  `MediaQuery.padding`/`viewPadding`,`SafeArea` 零改动生效
- **网络/存储**:`package:http`、`dio`、`NetworkImage`、`shared_preferences`
  透明接管,不需要主工程感知
- **微信能力**(`mp_flutter_wechat`):登录、支付、扫码、剪贴板、定位、分享、
  拨号、地址选择、胶囊按钮位置(`MpWechat.menuButtonRect()`)等,独立 Dart
  包,非小程序平台明确报错而不是静默失败
- **原生组件**(`mp_flutter_native`):`MpVideo`/`MpMap`/`MpCamera` 映射到真正
  的微信原生组件,而不是用 canvas 模拟
- **WXML 伴生层**(`--semantics-mirror`,默认关闭):把 Flutter semantics 树
  镜像成 WXML 节点,服务微信页面内容索引与无障碍
- **示例工程**(`example/`):底部导航 5 个 tab,覆盖触摸/滚动、文本输入、
  网络/存储、微信能力、原生组件
- **CI**(`tools/ci/check.sh` + `.github/workflows/ci.yml`):JS 单测、
  `dart analyze`/`dart test`、`flutter test`(含浏览器用例)、构建冒烟;
  GitHub Actions workflow 已提交,本地以 `tools/ci/check.sh` 全绿作为验证
- **E2E 回归套件**(`tools/e2e/`):5 个验收工程 + `run.sh` 一键运行
  (`stable`/`ohos`/`android` 三种构建配置)

### 已知限制

见 [`docs/support-matrix.md`](docs/support-matrix.md)。较重要的几条:
`Image` 的 `cacheWidth`/`cacheHeight`/`toByteData()` 暂不支持;原生组件恒在
Flutter 画布之上;`--semantics-mirror` 与文本输入同时使用有崩溃风险;dio 超时
合并为总时长;分享链接的 `query` 传不到 Dart 侧。

### 支持矩阵

Flutter stable 3.41.9、`flutter_ohos` 3.41.10-ohos-0.0.2-beta;Node ≥18;
微信小程序基础库 ≥3.15.0。详见 [`docs/support-matrix.md`](docs/support-matrix.md)。
