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
- 网络、存储、输入复用宿主接口，模拟器已验证 GET/POST 中文回显、网络图片、跨重启存储和中文/emoji 输入。手机上的这些扩展能力仍待逐项确认；请求和图片域名须在抖音后台配置。

按所用 API 的官方最低版本，基础库至少需 2.92；这只是 API 下限，尚非经过验证的兼容范围。微信的支持矩阵不能直接套用到抖音。

官方依据：[Canvas WebGL](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/canvas/v2/Canvas/Canvas.getContext)、[TTWebAssembly](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/tutorial/experience-optimization/list/wasm)、[分包异步化](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/tutorial/basic-ability/subpackages/async)。

## 本次验证记录

2026-11-07，Flutter 3.47.9，抖音开发者工具 4.5.7、基础库 4.33.0.1。

- 原生启动界面移除、页面 mpError 为空、控制台无 error。
- 中文、资源图片显示正常。
- 非矩形裁剪：三角形外侧像素为橙色 (255,122,61)，内部为绿色 (110,231,168)。
- 同一窗口连续两次点击，画面计数及 STATE 日志由 0 → 1 → 2。
- 390 项 Dart 测试通过，1 项跳过；391 项运行时 JS 测试通过，静态分析通过。
- 用户反馈该预览在真机运行正常（中文、图片、三角形裁剪、点击计数）。设备型号、系统和抖音版本未记录，不扩展为 iOS/Android 全矩阵通过。

### 扩展验收

- 本地回环后端：GET 和 POST 均回显完整的 `你好😀`，网络图片解码显示成功。
- 外网 HTTPS：抖音原生请求的 UTF-8 查询与二进制响应返回 200。
- shared_preferences 跨编译重启读取到之前计数并成功递增。
- 点击 Canvas 中的 Flutter TextField 后输入 `发布验证世界😀`，Flutter 收到 onChanged；调用原生确认事件入口后 onSubmitted 收到相同内容。该项验证事件桥，不等于手机软键盘所有行为均通过。
- 修复 Dart HTTP 客户端传数值 Content-Length 时抖音请求异常的问题：tt 请求头转换为字符串，Content-Length 由宿主计算。

可复跑的本地网络验收（仅模拟器）：

```sh
node tools/e2e/douyin-server.js
# 另一个终端：
dart run packages/mp_flutter/bin/flutter_miniprogram.dart \
  --platform douyin --project tools/e2e/apps/mpf_douyin \
  --appid <appid> --verify \
  --dart-define MPF_DOUYIN_TEST_ORIGIN=http://127.0.0.1:18883 \
  --dart-define MPF_DOUYIN_IMAGE_ORIGIN=http://127.0.0.1:18883
```

默认示例请求 Postman Echo 和 httpbin，测试服务有可用性限制。模拟器若连原生
`tt.request` 都报 `protocol mismatch`，检查 IDE 进程继承的代理环境变量；
本次通过不继承终端代理变量的 IDE 进程验证，未修改系统代理。不要将该类错误与
Flutter 适配问题混为一谈。正式业务使用自己的 HTTPS 服务与已配置的域名。

### 发布包复核

从 pub.dev 正常安装正式 `flutter_miniprogram 0.4.0` 到全新工程，确认依赖来自
`hosted/pub.dev/flutter_miniprogram-0.4.0`。使用 Flutter 3.47.9 构建并在独立抖音
工具窗口验收，页面 `pages/flutter/flutter` 启动正常、错误栏为空、控制台无 error；
中文/资源图片/裁剪、HTTPS 网络图片、GET/POST `你好😀`、跨重启存储、点击计数及
`正式包验证😀` 的输入与确认事件均通过。该复核使用正式下载包，未用源码 path 依赖替代。

[0.4.0 最终三版本 CI](https://github.com/jackwangfeng/mp-flutter/actions/runs/42371222210)
全部通过，包含每个 SDK 的微信和抖音构建冒烟。手机验收范围仍以“用户反馈”小节为准。
