# mp_flutter

把现有 Flutter 工程编译成微信小程序,主工程零 Dart 代码改动:加一个
`dev_dependency`,跑一条命令,产出的小程序用微信开发者工具直接打开。

完整项目文档(能力清单、支持矩阵、已知限制)见仓库根
[README](https://github.com/jackwangfeng/mp-flutter#readme)。本页只讲这个包
本身:CLI 用法、配置文件、退出码。

## 安装

仓库尚未发布到 pub.dev,以 git 依赖引入本仓库(公开仓库,无需额外凭证;`ref`
建议固定到一个发布 tag,例如 `v0.2.1`,而不是 `main`):

```yaml
dev_dependencies:
  mp_flutter:
    git:
      url: https://github.com/jackwangfeng/mp-flutter.git
      path: packages/mp_flutter
      ref: v0.2.1
```

是 `dev_dependency`——只在构建期用到,不会进最终的 Flutter Web 产物。

## 快速开始

```bash
# 1. 加依赖(见上),然后在工程根:
flutter pub get

# 2. 编译成小程序(默认输出到 build/weapp)
dart run mp_flutter

# 3. 用微信开发者工具打开 build/weapp 即可运行
```

先跑一遍自检,确认本机工具链(Node ≥18、esbuild、flutter、brotli、微信开发者
工具 CLI)齐备:

```bash
dart run mp_flutter doctor
```

## CLI 参数

```
dart run mp_flutter [选项]
dart run mp_flutter doctor
```

| 选项 | 说明 |
|---|---|
| `-p, --project` | Flutter 工程路径。缺省时从当前目录向上查找第一个含 `pubspec.yaml` 且依赖 `flutter` 的目录 |
| `-o, --output` | 产物输出路径,默认 `build/weapp` |
| `--appid` | 小程序 appid,默认 `touristappid`(游客态,多数微信能力不可用) |
| `--flutter` / `--esbuild` | 显式指定可执行文件路径,覆盖自动探测 |
| `--profile` | 产出未压缩代码,Dart 栈可读,用于排障 |
| `--require-location` | 声明需要定位权限(`wx.getLocation` 等接口需要);等价于 `--private-info=getLocation` |
| `--private-info=<接口名>` | 声明用户隐私接口(写入 `app.json` 的 `requiredPrivateInfos`),可重复。取值:`getFuzzyLocation`/`getLocation`/`onLocationChange`/`startLocationUpdate`/`startLocationUpdateBackground`/`chooseAddress`/`choosePoi`/`chooseLocation`。定位类接口(除 `chooseAddress` 外)会自动带上 `permission.scope.userLocation`;`getLocation`/`getFuzzyLocation` 不能同时声明 |
| `--semantics-mirror` | 开启 WXML 伴生层(语义树镜像),默认关闭 |
| `--perf-hud` | 开启真机性能测量(`[mp-perf]`/`[mp-boot]` 控制台日志 + 左上角浮层),默认关闭。见下方「真机性能测量」 |
| `--no-shader-warmup` | 关闭着色器预热(默认开):首帧之后趁空闲,在引擎的 GrDirectContext 上把常见绘制组合各画一遍,让 GL program 提前编译,首次进入列表/卡片页时不再当帧编译(iOS 无 JIT 时单个 program 百 ms 级)。不占冷启动,有动画/滚动/触摸时暂停;轻项一片最多攒 8ms,阴影/模糊等重项拆到最细粒度、要求连续空闲 1s 才画、每片一个 |
| `--shader-warmup-light` | 着色器预热只画轻项(文字/纯色/图片/圆/描边/路径等),跳过阴影/`BoxShadow`/`BackdropFilter`/颜色矩阵等重项(真机上单个 program 可达上百 ms)。默认关闭,对 `--no-shader-warmup` 无效 |
| `--no-licenses` | 不打包第三方许可证全文(`assets/NOTICES`,换成空占位),默认打包(放在按需分包,只在打开许可证页时下载)。见根 README「包体积与冷启动」 |
| `--cjk-font=level1\|full` / `--no-cjk-font` | 常用汉字合一字体(Noto Sans SC 子集,brotli 后放独立分包 `pkg-cjk`,启动时直接读文件):`full`(默认)= GB2312 一二级字 + 标点/全角/Latin-1/常用符号,约 1.15MB,真机实测不在首帧关键路径上;`level1` = 仅一级字,约 650KB,但服务端下发文案命中二级字/常用符号时会多一次回退分片下载与整体重排。首屏中文不再逐片下载回退字体、不再因字体到达整体重排;字表外的字仍按需下载分片。取舍见根 README「包体积与冷启动」 |
| `--cjk-font-bold=level1\|full\|false` | 合一字体的粗体(Noto Sans SC Bold 子集,同一 family、字重 700,独立分包 `pkg-cjkb`,不挡首帧)。默认跟随 `--cjk-font`,必须同档;`false` = 不带,w600 以上的中文由 CanvasKit 合成加粗(无 JIT 时每段首次排版约贵 4 倍)。见根 README「合一字体粗体」 |
| `--font-base-url <https://...>` | 远端回退字体:简体中文回退字体分片不打进包,运行时从该地址拉取并缓存到本地文件;产物下的 `mp-fonts-remote/` 需原样上传到该地址,且该域名必须加入小程序后台 request 合法域名 |
| `--no-safe-area` | 关闭构建期入口包装(安全区注入),默认开(`--safe-area`)。工程自带
  `WidgetsFlutterBinding` 子类时用它,见根 README「安全区」一节的限制 |
| `-t, --target` | Flutter 入口文件,默认 `lib/main.dart`。相对路径锚定工程根(不是 cwd) |
| `--dart-define=KEY=VALUE` | 透传给 `flutter build web`,可重复 |
| `--dart-define-from-file=<path>` | 透传给 `flutter build web` |
| `--version` | 打印包版本 |

完整帮助:`dart run mp_flutter --help`。

## `mp_flutter.yaml`(可选)

放在工程根,优先级为 **命令行 > 配置文件 > 默认值**:

```yaml
appid: wx1234567890abcdef
output: build/weapp
require_location: true
private_infos: [chooseLocation, choosePoi]   # 与 --private-info 合并去重
semantics_mirror: false
perf_hud: false
shader_warmup: true            # 首帧后空闲时预热着色器(同 --no-shader-warmup 关闭)
# shader_warmup_light: true     # 预热只画轻项、跳过重项(同 --shader-warmup-light)
safe_area: true
licenses: true                 # false = 不打包 NOTICES(同 --no-licenses)
cjk_font: full                  # full(默认)/ level1 / false,同 --cjk-font / --no-cjk-font
# cjk_font_bold: false          # 粗体:默认跟随 cjk_font(须同档),false = 不带,同 --cjk-font-bold
# font_base_url: https://cdn.example.com/mp-fonts/   # 远端回退字体(同 --font-base-url)
splash_title: 我的小店          # 原生启动界面的应用名,缺省用 pubspec 的 name
splash_color: "#ffffff"        # 启动界面背景色(#rgb / #rrggbb),缺省白色
target: lib/main.dart
dart_define:
  API_BASE: https://api.example.com
  FEATURE_X: "true"
```

`dart_define` 与命令行 `--dart-define` 会合并;命令行同名 KEY 覆盖配置文件的
值,不改变已有键的顺序;每个值必须是标量(不能是 null 或嵌套映射/列表,否则
`ConfigParseFailure`,退出码 64)。未知键只会 warn 一次,不影响构建。

`private_infos` 与命令行 `--private-info` 会合并去重(yaml 在前,命令行新增
的在后);出现不认识的取值,或同时声明了 `getLocation`/`getFuzzyLocation`,
都在构建前报错(退出码 64)。**除了这里的客户端声明,每个接口还需要在小程序
管理后台「开发管理 → 接口设置」里单独启用,否则真机会被拒绝调用**(开发者
工具不受此限制)。

## 真机性能测量(`--perf-hud`)

排查真机(尤其 iOS)列表滚动卡顿用。默认关闭——关闭时不 `require` 任何相关
模块,不产生任何运行时开销(与 `--semantics-mirror` 同样的注入方式)。

开启:

```bash
dart run mp_flutter --perf-hud
```

或在 `mp_flutter.yaml` 里写 `perf_hud: true`。

打开后:

- 控制台每秒一行 `[mp-perf]`,字段:
  - `fps`:过去 1 秒实际执行的 rAF 帧数
  - `frame(avg/p95/max ms)`:每次 rAF 回调总耗时(引擎的 beginFrame/drawFrame
    都在这里面)
  - `gl(calls/frame,ms/frame)`:WebGL 调用次数/累计耗时,按帧统计但用采样
    (每 10 帧完整统计一帧)控制包装本身的开销
  - `decode(count,ms)`:图片解码(`CanvasKit.MakeImageFromEncoded` 等)的
    次数与累计耗时;单次解码超过 8ms 会额外打一行 `[mp-perf] decode-slow
    <耗时> size=<宽>x<高> bytes=<字节数>`
  - `longTasks`:一帧耗时超过 50ms 的次数
  - `dart~=<耗时>ms(est)`:粗略估算的 Dart/框架耗时(帧总耗时减去 gl 耗时、
    减去按帧均摊的 decode 耗时),**是估算值,不是精确归因**
  - `shader=<次数>/<ms>`、`programs=<累计个数>/<ms>`:着色器编译相关 gl 调用与
    累计编译的 GL program。每个 program 另打一行 `[mp-perf] program #n <ms>
    <源码哈希> attrs=<顶点属性> unis=<片元 uniform>`,用来认出是哪种绘制组合
    (圆角裁剪 `uinnerRect,uradiusPlusHalf`、高斯模糊 `uoffsetsAndKernel`、渐变
    `ustart,uend`…);着色器预热每画完一项打一行 `[mp-perf] shader-warmup item
    <名称> <ms> [heavy]`,结束打一行 `[mp-perf] shader-warmup done
    combos=<组> busy=<占用主线程 ms> maxSlice=<单次最长 ms> elapsed=<ms>
    heavy=<画过的重项数> skipped=<light 模式跳过的重项数>`
- 超过 50ms 的帧打一行 `long-frame`,两帧间隔超过 100ms 且主线程确实被占住时
  打一行 `gap`(帧外)。`long-frame` 的分项(需要入口包装,即默认的
  `--safe-area`):
  - `dart=<总>(transient 动画回调, build, layout 布局, bits, paint, comp 合成,
    sem 语义, fin, post 帧后回调)`:框架各阶段,入口包装经 `self.__mpFrameProf`
    每帧报一次;`metrics=N` 本帧前视口度量变化次数、`inset=` 当前
    `viewInsets.bottom`
  - `raster=`:引擎光栅化(Surface.getCanvas → flush;引擎的渲染是异步的,常
    落在 rAF 回调返回后的微任务里,并入当前帧)
  - 竖线后是分项参考(与上面有重叠,不再单独扣):`shader`/`upload`/`decode`/
    `layout`(段落排版)/`tb`(文本输入桥轮询与 setData 同步部分)/
    `setData=次数/字节`/`resize=`(窗口尺寸变化事件)
  - `other=` 帧耗时减去框架各阶段与光栅化
- 冷启动阶段耗时:每个阶段结束打一行
  `[mp-boot] <阶段名> +<距 App onLaunch 的毫秒>ms (<本阶段耗时毫秒>ms)`,
  阶段依次是页面 `onLoad`、各分包 `subpackage:<分包名>`(`require.async`
  完成)、`canvaskit`(wasm 加载/编译/实例化,微信没有更细的分阶段 API,
  只能合并报一个阶段)、`crypto`(播种)、`dart-chunks`(`main.dart.js`
  各分片加载完成)、`dart-main`(Dart 生成代码开始接管执行的代理指标)、
  `first-frame`(首帧真正提交);全部结束后打一行 `[mp-boot] total`
- 左上角一个可开关的小浮层,显示 FPS 与帧均耗时,`pointer-events:none`
  (不挡触摸,所以不能靠点击它切换)。开发者工具/真机调试控制台里可以用
  `getCurrentPages()[0].mpPerf.setVisible(false)` 关掉(`setVisible(true)`
  重新打开)

怎么在真机调试控制台看:微信开发者工具顶部菜单「真机调试」→ 连接设备后
在下方 Console 面板搜索 `[mp-perf]` 或 `[mp-boot]`;devtools 里预览/编译
同样会打印,搜索方式一样。

## 退出码

构建失败按原因分型退出(2 包体积超限、3 Flutter 版本不支持、4 `flutter
build web` 失败、5 构建期变换失配、6 外部工具缺失、7 字体下载失败、64 参数/
配置错误、1 未分类兜底)。逐条对照与处理办法见
[docs/troubleshooting.md](../../docs/troubleshooting.md)。

## 支持矩阵与已知限制

见
[docs/support-matrix.md](../../docs/support-matrix.md)。

## 许可证

Apache License 2.0,见仓库根 [LICENSE](../../LICENSE)。
