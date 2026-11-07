# 抖音小程序（0.4.0 实验性支持）

源码已提供 `--platform douyin` / YAML `platform: douyin`，微信仍为默认目标。
已通过本地构建、TT 宿主模拟测试、微信回归及抖音开发者工具的中文、图片、非矩形裁剪和点击计数验收。用户已反馈同一预览工程在真机运行正常；验证范围限于下述示例，仍为实验性支持。

## 从源码构建

在仓库根执行（先给 Flutter 工程执行 `flutter pub get`）：

```sh
dart run packages/mp_flutter/bin/flutter_miniprogram.dart \
  --platform douyin \
  --project tools/e2e/apps/mpf_douyin \
  --output tools/e2e/out/mpf_douyin \
  --appid <你的抖音小程序AppID> \
  --verify
```

也可在 Flutter 工程的 `mp_flutter.yaml` 配置：

```yaml
platform: douyin
appid: tt你的AppID
output: build/douyin
cjk_font: false
```

使用抖音开发者工具打开输出目录，登录有该 AppID 权限的账号。示例显示中文、资源图片、三角形裁剪和计数按钮；点击后界面计数应增加，控制台应出现 `STATE count=1`。随后用预览二维码做手机验证。`testAppId` 仅用于本地构建测试，不代表有效账号权限。

## 适配范围

- 生成 TTML / TTSS、抖音工程配置和异步公共分包。
- Canvas V2 WebGL、`TTWebAssembly` 加载 Brotli WASM、`tt` 宿主 API 适配。
- 默认关闭合一压缩中文字体，使用随包回退字体；显式开启合一字体会报错。暂未适配抖音的压缩字体读取。
- 微信能力桥及原生地图、视频、相机桥关闭。登录、支付等抖音专用能力尚未实现。
- 默认使用抖音标准导航栏，避免未申请自定义导航栏权限时无法正常发布。
- 抖音默认 framebuffer 在模拟器中没有 stencil；保留真实 GL 能力值，允许 CanvasKit 自行管理渲染目标，已做三角形裁剪像素验收。微信严格 stencil 检查保留。
- 网络、存储、输入复用宿主接口，但仍需抖音模拟器和手机分别验收。隐私声明和域名须按平台要求配置。

按所用 API 的官方最低版本，基础库至少需 2.92；这只是 API 下限，尚非经过验证的兼容范围。微信的支持矩阵不能直接套用到抖音。

官方依据：[Canvas WebGL](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/canvas/v2/Canvas/Canvas.getContext)、[TTWebAssembly](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/tutorial/experience-optimization/list/wasm)、[分包异步化](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/tutorial/basic-ability/subpackages/async)。

## 本次验证记录

2026-11-07，Flutter 3.47.9，抖音开发者工具 4.5.7、基础库 4.33.0.1。

- 原生启动界面移除、页面 mpError 为空、控制台无 error。
- 中文、资源图片显示正常。
- 非矩形裁剪：三角形外侧像素为橙色 (255,122,61)，内部为绿色 (110,231,168)。
- 同一窗口连续两次点击，画面计数及 STATE 日志由 0 → 1 → 2。
- 389 项 Dart 测试通过，1 项跳过；388 项运行时 JS 测试通过，静态分析通过。
- 用户反馈该预览在真机运行正常（中文、图片、三角形裁剪、点击计数）。设备型号、系统和抖音版本未记录，不扩展为 iOS/Android 全矩阵通过。
