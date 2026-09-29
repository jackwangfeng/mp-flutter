# 支持矩阵

本页汇总 mp-flutter 已验证的工具链版本、各平台桥的验证状态与已知限制。状态
分三档:

- **模拟器已验证**——微信开发者工具（含 CanvasKit 渲染管线）里已跑过回归
  套件（`tools/e2e`）并断言通过
- **真机待验**——模拟器已验证,但依赖真实设备的行为(手势细节、性能、
  真机专属限制如合法域名)尚未逐项在真机上复核,上线前建议自行实测
- **不支持**——已知不可用,列出替代方案或计划

## 工具链版本

**运行 `dart run mp_flutter`(构建 CLI 本身)只支持 macOS/Linux,Windows 未
支持**——回归套件、CI(`ubuntu-latest`)与全部本地开发都在 macOS/Linux 上跑,
`brotli`/`unset FLUTTER_ROOT` 等做法也是 POSIX shell 假设;Windows 上能否跑通
未经验证,没有已知的兼容性工作。

| 项 | 要求/已验证版本 | 备注 |
|---|---|---|
| Flutter(stable) | **3.41.9** | 唯一已跑过完整回归套件的 stable 版本;换版本前须先跑一遍 `tools/e2e/run.sh stable`(见 `packages/mp_flutter/lib/src/version_matrix.dart`) |
| Flutter(`flutter_ohos` fork) | **3.41.10-ohos-0.0.2-beta** | 已知与 stable 的产物差异:未打包 Material shaders(`ink_sparkle.frag`、`stretch_effect.frag`)——用到 `InkSparkle` 水波纹或 overscroll 拉伸效果的 App 运行时会取不到这两个资源 |
| Node.js | **≥ 18** | `main.dart.js` 分片(`packages/mp_flutter/js/split.js`)与 esbuild 自动安装均依赖 Node;`dart run mp_flutter doctor` 会检查 |
| `brotli` | — | 压缩 `canvaskit.wasm` 依赖它,macOS/Linux 都不预装;macOS `brew install brotli`,Debian/Ubuntu(含 CI)`apt install brotli`;缺失时构建以退出码 6 失败,`doctor` 会检查 |
| 微信小程序基础库 | **≥ 3.15.0**(目标最低版本) | 回归套件历史实测覆盖 3.15.2–3.17.3;低于该版本的 `wx.*` 接口探测(见 `mp_flutter_wechat` 的 `call()` 兜底)会按“当前基础库不支持该接口”分型报错,而不是挂起 |
| 微信开发者工具 CLI(可选) | — | 仅影响命令行自动上传/预览,不影响本地构建产物;`doctor` 会检测默认安装路径(缺失只警告,不计入 `doctor` 退出码) |

其中 mp_flutter 之外的两个包(`mp_flutter_native`、`mp_flutter_wechat`)不绑定
Flutter 版本矩阵,跟随宿主工程的 Flutter SDK 走。

**双 SDK 机器**(同时装了多套 Flutter SDK,比如 stable + `flutter_ohos`
fork):没有显式传 `--flutter`/`mp_flutter.yaml` 的 `flutter` 时,mp_flutter
优先用工程 `.dart_tool/package_config.json` 里 `flutter` 包 `rootUri` 反推出的
SDK(该工程 `flutter pub get` 时用的那一套);显式指定的 SDK 与这个推断结果
不一致时会直接报错(退出码 64),而不是二选一悄悄跑出一个引擎/源码版本错配
的产物,见 [`docs/troubleshooting.md`](troubleshooting.md) 退出码 64 一节。

## 平台桥状态

| 平台桥 | 状态 | 已知限制 |
|---|---|---|
| 渲染(CanvasKit / 多 canvas 合成) | ✅ 真机已验证(iPhone 15:首屏 129–144ms、59fps、像素精确) + 模拟器三种构建配置(stable / `flutter_ohos` / `--force-platform android`) | 绑定 CanvasKit;若上游 Flutter 转向 skwasm/Impeller Web 需重做;`canvasKitMaximumSurfaces: 1` 强制单 surface,多画布场景会别名到同一 canvas;复杂页面(长列表/图片墙/长图文/大表单/重效果/原生组件)在真机上的容量与"能撑多大"经验值见 [`docs/capability-guide.md`](capability-guide.md);着色器预热(`shader_warmup`,默认开,见 `shader-warmup.js`)真机复测长列表最长帧 1061→97ms、>100ms 帧 2→0、fps 43→56(详见 capability-guide 2.1 节) |
| 触摸 | 模拟器已验证(`accept-interact.js`) | 真机手势细节(多点触控、长按选词、复制粘贴)未逐项复核;Android 强制多画布光栅器仅在伪造 UA 下验证过 |
| 文本输入 | 模拟器已验证 | 首次聚焦偶发丢一帧(`cullRect of null`,模拟器曾 7/7 次复现)根因是垫片缺 `self.scheduleImmediate` 致 Dart 微任务退化为 `setTimeout`、下一帧插进 `draw()` 的 `await` 与 preroll 之间读到在途 dispose 的 picture,**已修复**(K5,`4968feb`);缩放/旋转祖先下输入框尺寸/字号不准;**`--semantics-mirror` 与文本输入同时使用仍不可靠**(渲染管线崩溃已随上述修复排除,但复测发现另一问题——见下「已知限制」);iOS 目标平台下 `TextField` 光标默认改为常亮不闪(`EditableText.debugDeterministicCursor`,可在 `main()` 里设回 `false` 恢复闪烁),消除了聚焦期间由光标动画驱动的持续 60fps 出帧,真机复测大表单 >100ms 帧 6→4(详见 capability-guide 2.1 节);常亮光标的副作用——密码框(`obscureText`)最后一位输入字符本应短暂明文显示后自动隐藏,隐藏靠的正是被停掉的光标 tick,**已修复**(I1):text-bridge.js 检测到密码框聚焦/失焦时通知入口包装,聚焦期间临时恢复正常闪烁、失焦后再切回常亮 |
| 网络(`http`/`dio`/`NetworkImage`) | 模拟器已验证 | 真机仅能访问小程序后台配置的合法 HTTPS 域名;不自动管理 Cookie;不支持 `FormData`/`Blob`/同步 XHR;dio 的 `connectTimeout`/`receiveTimeout` 合并为一个总超时;重定向由 wx 自动跟随,`response.url`/`redirected` 不反映最终地址 |
| 存储(`shared_preferences`) | 模拟器已验证 | 键带 `mpf:` 前缀;单键 1MB、总量 10MB 上限,超限抛 `QuotaExceededError`(内存态已乐观更新,不回滚) |
| 图片(`Image`/`ui.Image`) | 模拟器已验证(含 `cacheWidth`/`cacheHeight` 与 `toByteData()`,stable / `flutter_ohos`) | `cacheWidth`/`cacheHeight`(含 `ResizeImage`)先按原尺寸解码再在 CanvasKit CPU 光栅上缩放,解码时的内存峰值不因此降低;`toByteData(format: rawRgba)` 返回**非预乘(straight)**RGBA 像素,与浏览器一致,但与 Flutter 原生平台(预乘)不同,业务侧若对返回像素做手工合成/滤镜需自行按非预乘处理;大图 `toByteData` 峰值内存约为 `宽×高×4` 的 **3 倍**(离屏光栅 surface 一份 + `getImageData`/`toDataURL` 读出的一份 + Dart 侧接收的一份都压在 wasm 堆上),超大图请留意 wasm 堆上限;网络图片无磁盘缓存,仅 `ImageCache` 内存缓存;资源 base64 装箱体积实测 +33% |
| 随机数(`Random.secure()` / `crypto.getRandomValues` / `crypto.randomUUID`) | 模拟器已验证(K4:ChaCha20 DRBG,`wx.getRandomValues` 播种) | 依赖 `wx.getRandomValues`,需基础库支持该接口(最低版本请以微信官方文档为准);不支持、播种失败,或首次播种 4 秒内未回调(按超时失败处理,不阻塞启动)时不挂载 `window.crypto`/`self.crypto`,`Random.secure()` 按浏览器无该 API 时的语义抛 `Unsupported`,不伪造安全性;`getRandomValues` 单次请求上限 65536 字节,与浏览器一致 |
| 字体(回退字体) | 模拟器已验证 | 首次构建下载并本地缓存;网络失败按 `FontFetchFailure` 分型报错(退出码 7),支持 `HTTPS_PROXY`/`HTTP_PROXY`,不支持 `ALL_PROXY`/socks;简体中文分片(notosanssc 101 片)放在按需分包 `pkg-fonts-*`(约 512KB 一个,常用字分片优先、其余按码位邻近分组),第一次出现某批汉字时才下载所在分包,下载完成前这批字短暂显示为空白/方块;只打包 Roboto + 简体中文,日/韩/繁/emoji 字形不显示 |
| 常用汉字合一字体(`cjk_font`,默认 `full`) | 模拟器已验证(真实电商小程序:`full` 首屏回退分片 20→0、fontsChange 5→0、长帧 3–4→0;`level1` 首屏 3 个分片、2 次 fontsChange);E2E 全量;真机(旧 base64 方案)首屏卡顿消除、fontChange=0;真机(新读取方式 readCompressedFile,`full`)已验证:字体读取 28–30ms、首帧 354/533ms,不在首帧关键路径上;`level1` 真机上因服务端下发文案命中二级字/常用符号仍会触发额外回退分片下载与 fontsChange | `level1` = GB2312 一级 3755 字 + 标点/全角/Latin-1/常用符号(TTF 1.2MB,br 约 650KB);`full` = 一二级 6763 字(TTF 2.2MB,br 约 1.15MB,默认);放独立分包 `pkg-cjk`,boot 一开始就读(`FileSystemManager.readCompressedFile`),与 wasm/Dart 并行,CanvasKit 就绪即预解析;读取失败时退回按需分片;构建期给 `main.dart.js` 打两处补丁(回退表初值、缺字检测),上游结构变了构建失败并点名(`cjk_font: false` 可临时关闭);字表外的字仍按需下载回退分片(只拉所在的那一片) |
| 合一字体粗体(`cjk_font_bold`,默认跟随 `cjk_font`) | 基准已验证(真实 CanvasKit,JSC 关 JIT:30 字 22px 首次排版合成加粗 30.5ms → 真粗体 7.4ms);模拟器已验证(真实电商小程序首页 `fakeBold` 16 → 0、详情页 5 → 0,粗体按时到达与晚到补注册两条路径);E2E 全量;**iOS 真机详情页长帧的改善未验证** | 与常规合一字体同一 family、字重 700,必须同档(不同档会出豆腐块,构建期报错);独立分包 `pkg-cjkb`(full 约 1.17MB、level1 约 660KB br),总包相应增加;首帧不等它:不晚于常规字体到就随清单注册,晚到则首帧后经入口包装 `ui.loadFontFromList` 补注册、多一次 fontsChange 重排——`--no-safe-area`(没有入口包装)时晚到的粗体不再使用,粗体文字继续合成加粗;回退分片(字表外的字)仍只有常规字重,粗体照旧合成;拉丁字母/数字排在 Roboto(只有常规)上,仍合成加粗(字形少,缓存后无开销) |
| 字体解析去重 / 回退字体合并窗口 / 按需分包单飞 | 单测已验证;模拟器已验证;**安卓 1s 整 fetch 是否消失需真机确认** | 同一份字节只解析一次(引擎每批重注册全部字体不再重解析);回退分片响应按 100ms 窗口合并(最多压 1s),减少 fontsChange 次数;同一未下载分包只发一次 `require.async` |
| 远端回退字体(`font_base_url`,默认关) | 单测已验证(`tools/mp-context/font-cache.test.js`,mock wx);**真机未验证** | 分片不进包,运行时 `wx.request` 从 CDN 拉取,缓存到 `USER_DATA_PATH/mp-fonts-cache/`(上限 10MB,LRU);CDN 域名必须加入小程序后台 request 合法域名;首次无网络时中文不显示(Roboto 仍在包内,不影响启动) |
| 冷启动 / 资源分包 | 模拟器已验证(E2E 全量,见 CHANGELOG) | 首帧前只加载 `pkg-dart-*`、`pkg-wasm`、`pkg-assets-boot`(FontManifest/AssetManifest、清单里声明的字体、Roboto);NOTICES、回退字体、图片、shader 都按需下载——首屏用到的 `Image.asset` 图片会在首帧后才下载所在分包(约 512KB 粒度),首次显示比整包预载时晚一个分包下载时间 |
| 原生启动界面 | 模拟器已验证 | 应用名 + 进度条(按已完成的启动阶段数估算,不是真实下载字节进度);首帧提交后移除;首帧前失败显示错误文案 |
| 路由/历史(Flutter 内部 Navigator) | 模拟器已验证 | 内存版 `History` 垫片;承载页重入(`reLaunch`、分享卡片再次打开)靠 `wx.restartMiniProgram` 重启获得干净上下文;Android 物理返回键与 Navigator 的联动未实现(需业务自行用 `page-container` 处理) |
| 微信能力(`mp_flutter_wechat`) | 模拟器已验证(stable / `flutter_ohos` / `--force-platform android`,`accept-wx.js` 7 项) | 支付:开发者工具用游客态 appid 时权限检查先于签名校验(`no permission`),真实商户号 + 有效签名的完整成功/取消路径**真机未验证**;分享出去的链接 `query` 传不到 Dart 侧;定位权限说明文案固定写死;`--private-info`/`private_infos`(含 `chooseLocation` 等)可声明任意 `requiredPrivateInfos`,但每个接口仍需额外在小程序管理后台「开发管理 → 接口设置」里单独启用,否则真机拒绝调用(开发者工具不受此限制) |
| 原生组件(`mp_flutter_native`:`MpVideo`/`MpMap`/`MpCamera`) | 模拟器已验证 | **原生组件恒在 Flutter 画布之上**,不能被 Flutter 图层栈中间的内容遮挡(需用小程序 `cover-view`/`cover-image` 或挪开交互 UI);真机待验:视频播放/暂停/全屏、地图拖动+标记点击、相机拍照、列表中视频随滚动跟随 |
| 伴生层(WXML 语义镜像,`--semantics-mirror`) | 模拟器已验证(默认关闭) | 视觉隐藏(`opacity:0; pointer-events:none`)与“不拦截触摸”只由 CSS 保证,**真机未逐项复核**;**`--semantics-mirror` 与文本输入(TextField)同时使用仍不可靠**——此前记录的“滚动列表后再次聚焦 TextField 让 CanvasKit 渲染管线崩溃(`Null check operator used on a null value`/`Cannot read properties of null (reading 'cullRect')`)”根因是垫片缺 `self.scheduleImmediate`,已修复(K5,`4968feb`);2026-09-28 终审复测(`--semantics-mirror` 构建 `tools/e2e/apps/mpf_interact` 跑 `accept-interact.js`)未再复现该崩溃(控制台无 error),但复测发现另一问题:滚动后再次聚焦 TextField,原生输入框(`.mp-input`)始终不出现,文本输入本身不可用(同一构建不加 `--semantics-mirror` 时该步骤正常),根因待查,不在本轮修复范围;业务侧如需两者同时使用请先用自己的交互流程实测 |

## 已知限制清单(汇总)

以下限制在近期没有修复计划,或修复依赖上游 Flutter engine:

1. 原生组件(`MpVideo`/`MpMap`/`MpCamera`)永远叠在 Flutter 画布之上,无法插入 Flutter 图层栈中间
2. `--semantics-mirror` 与文本输入同时使用仍不可靠——此前记录的渲染管线崩溃(`cullRect`/`Null check`,K5)根因是垫片缺 `self.scheduleImmediate`,已修复(`4968feb`);2026-09-28 复测未再复现该崩溃,但发现另一问题:滚动后再次聚焦 TextField,原生输入框不再出现,文本输入本身不可用,根因待查
3. dio 的 `connectTimeout`/`receiveTimeout` 合并为一个总超时,不分段
4. 分享出去的链接携带的 `query` 传不到 Dart 侧(`onLoad` 参数未转发)
5. 网络图片无磁盘缓存,只有内存缓存(`ImageCache`)
6. 真机上网络请求/图片下载仅能访问小程序后台配置的合法 HTTPS 域名
7. 工程若在 `runApp` 之前自己创建了绑定子类,会与构建期入口包装冲突——release
   构建下安全区注入悄悄不生效,profile 构建下启动即崩溃
   (`Extension already registered`);这类工程请用 `--no-safe-area`(或
   `mp_flutter.yaml` 的 `safe_area: false`)关闭入口包装,自行处理安全区
8. Android 物理返回键与 Flutter Navigator 的联动未实现
9. 安全区注入是在框架层插一层 `MediaQuery`,业务代码若绕过 `MediaQuery.of`/
   `MediaQuery.maybeOf` 去读安全区——比如自己调用 `MediaQuery.fromView`
   (拿到的是引擎原始 `FlutterView`,恒为零)或 `View.of(context).padding`
   (`FlutterView` 本身没有这个注入)——会绕开这套注入,读到恒为 0 的值;
   多 `View`/`runWidget`(多个根 `View`,而不是入口包装包住的单一默认
   `View`)场景同样不注入,因为入口包装只在默认 `View` 之下插了一层
10. 泰文、老挝文、高棉文、缅甸文(词间不写空格)词内不给换行机会:打包的完整版
    CanvasKit 为放进单个分包(2048KB)清零了 ICU 里这四种文字的断词词典(约
    515KB),这几种文字只在空格处换行,整词放不下时按字形强制断开;中文、日文、
    韩文、拉丁文等不受影响(见 `packages/mp_flutter/lib/src/transform/canvaskit_wasm.dart`)
11. `--no-licenses` 时许可证页不列出第三方包(NOTICES 是空占位);默认打包的 NOTICES 在
    按需分包里,只在打开许可证页时下载
12. 不做"按 App 文案做字体子集":电商类 App 的文字多由服务端动态下发,构建期子集会丢字;
    中文回退字体保持整套按需加载(或 `font_base_url` 走 CDN);常用汉字合一字体是按 GB2312 固定
    字表切的通用子集(level1 / full),不依赖 App 文案

更细的“为什么”与实测数据见 [`docs/architecture.md`](architecture.md)。复杂
页面(长列表、图片墙、长图文、大表单、重效果、原生组件)的真机压测数据、一
个真实电商小程序的线上基线,以及"能撑多大"的可操作经验值,见
[`docs/capability-guide.md`](capability-guide.md)。
