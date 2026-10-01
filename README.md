# mp-flutter

[![License](https://img.shields.io/github/license/jackwangfeng/mp-flutter)](LICENSE)
[![Release](https://img.shields.io/github/v/release/jackwangfeng/mp-flutter)](https://github.com/jackwangfeng/mp-flutter/releases)
[![Flutter](https://img.shields.io/badge/Flutter-3.41.9%20stable-02569B?logo=flutter&logoColor=white)](docs/support-matrix.md)
[![Platform](https://img.shields.io/badge/platform-WeChat%20Mini%20Program-07C160?logo=wechat&logoColor=white)](https://developers.weixin.qq.com/miniprogram/dev/framework/)

把现有 Flutter 工程编译成微信小程序,主工程零代码改动。

**不改一行 Dart 代码,把 Flutter 应用编译成微信小程序** · Run **unmodified** Flutter apps as **WeChat Mini Programs** — Flutter Web + CanvasKit, zero Dart code changes, real-device verified on iOS/Android.

[English README →](README.en.md) ・ 中文(当前)

## 为什么用它 / Why mp-flutter

- **零代码改动**——主工程不用为小程序环境写任何适配代码,照常 `flutter pub get`,工程根跑一条命令就编译成小程序
- **渲染一致性**——编译产物是未经改造的 Flutter Web(CanvasKit)产物,渲染管线与真正的 Flutter 一致,不是另起炉灶的小程序专用渲染器,不存在"组件支持子集"的问题
- **完整的 widget / 插件生态**——`http`/`dio`/`shared_preferences`/`NetworkImage` 等用法不变,底层透明替换为小程序 API,见下方「能力与限制」
- **真机验证过的性能**——iPhone 15 / 安卓真机实测:冷启动约 3.5–4s,长列表滚动 iOS 40–56fps / Android 50–60fps,图片墙约 57fps,完整压测数据见 [`docs/capability-guide.md`](docs/capability-guide.md)

## 三步快速开始

**1. 加依赖**——仓库尚未发布到 pub.dev,以 git 依赖引入本仓库(公开仓库,无需
额外凭证;`ref` 建议固定到一个发布 tag,例如 `v0.2.5`,而不是 `main`,避免上游
后续提交影响本地构建的可复现性):

```yaml
dev_dependencies:
  mp_flutter:
    git:
      url: https://github.com/jackwangfeng/mp-flutter.git
      path: packages/mp_flutter
      ref: v0.2.5
```

**2. 编译**——工程根跑一条命令(先跑 `dart run mp_flutter doctor` 自检工具链
更省心):

```bash
dart run mp_flutter
```

前置条件(`doctor` 会逐项检查):Flutter(见下方支持矩阵)、Node **≥18**、
`brotli`(压缩 `canvaskit.wasm` 依赖它,macOS/Linux 都不预装——macOS
`brew install brotli`,Debian/Ubuntu `apt install brotli`;缺失时构建会以
退出码 6 失败,见 [`docs/troubleshooting.md`](docs/troubleshooting.md));
esbuild 首次使用会自动安装,不需要提前装。**只支持 macOS/Linux**,Windows
未支持(见 [`docs/support-matrix.md`](docs/support-matrix.md))。

产物默认落在 `build/weapp`(可用 `-o`/`mp_flutter.yaml` 的 `output` 改)。

**3. 打开**——用微信开发者工具直接打开 `build/weapp` 目录即可运行。

需要微信能力(登录/支付/扫码等)或原生组件(视频/地图/相机)时,额外引入
`package:mp_flutter_wechat`/`package:mp_flutter_native`,见下方「能力与限制」
与两个包各自的 README。

## 支持矩阵

已验证 Flutter stable **3.41.9**、`flutter_ohos` **3.41.10-ohos-0.0.2-beta**;
Node **≥18**;微信小程序基础库 **≥3.15.0**。每个平台桥(渲染/触摸/文本输入/
网络/存储/图片/字体/路由/微信能力/原生组件/伴生层)的验证状态与已知限制,
完整版见 [`docs/support-matrix.md`](docs/support-matrix.md)。

## 能力与限制

### 本地开发

esbuild、`main.dart.js` 分片器(acorn)均已随 `packages/mp_flutter` 包分发/
自动安装,无需手动 `npm install`:esbuild 首次使用时自动装到 `~/.mp_flutter`
(唯一联网点),也可用 `--esbuild` 或 `MP_FLUTTER_ESBUILD` 环境变量指定已安装
好的路径。

`mp_flutter.yaml`(可选,放在工程根)可以固定 `appid`/`output`/`flutter`/
`esbuild`/`require_location`/`private_infos`/`semantics_mirror`/`dart_define`/
`safe_area`/`target`,优先级为**命令行 > 配置文件 > 默认值**;`--dart-define`/
`--dart-define-from-file` 会透传给 `flutter build web`,配置文件的
`dart_define` 与命令行同名 KEY 时以命令行为准(且每个值必须是标量——写成
`KEY:` 空着不写值,或嵌套映射/列表,都会在构建前就报 `ConfigParseFailure`,
退出码 64)。命令行参数、配置文件键与退出码含义见
[`packages/mp_flutter/README.md`](packages/mp_flutter/README.md)与
[`docs/troubleshooting.md`](docs/troubleshooting.md)。

### CI

`.github/workflows/ci.yml`(ubuntu-latest,固定 `subosito/flutter-action` 3.41.9 stable、Node 20)
只调用一个脚本——`tools/ci/check.sh`,本地与 CI 共用,顺序跑:JS 单测
(`tools/mp-context`、`packages/mp_flutter/js/test`)、`dart analyze` + `dart test`
(`packages/mp_flutter`,含 tag `slow` 的消费者冒烟)、`flutter test`(含
`--platform chrome` 浏览器用例,`mp_flutter_native`/`mp_flutter_wechat`/`example`)、
`example` 构建冒烟(`dart run mp_flutter`,断言 `app.json` 落地——分包体积
≤2048KB 已由构建期 `SizeReport` 校验,超限直接非零退出)。本机跑
`tools/ci/check.sh` 全绿是唯一的验证方式(见 `CONTRIBUTING.md`)。

**E2E(`tools/e2e/`)不进 CI**:需要微信开发者工具的 GUI 与登录态,GitHub
Actions 的无头 ubuntu 环境跑不了,只能本地手动跑(见 `tools/e2e/README.md`)。

### 网络与存储

用法零改动:`package:http`、`dio`、框架 `NetworkImage`、`shared_preferences` 照常写,底层被垫片透明替换为小程序 API,不需要主工程感知。使用前请注意以下限制:

- **真机合法域名**:真机上 `wx.request`(含图片下载)只能访问小程序后台配置的**合法 HTTPS 域名**;开发者工具用 `urlCheck:false` 绕过校验,验收通过不代表真机可访问,上线前务必在后台配置域名后用真机复测
- **不自动管理 Cookie**:登录态等建议放进请求 header(如 `Authorization: Bearer <token>`),不要依赖浏览器式的自动带 Cookie
- **不支持的请求形态**:`FormData`/`Blob` 请求体、`responseType: 'blob'`/`'document'`、同步 XHR 均不支持;上传进度只在完成时上报一次
- **网络图片暂无磁盘缓存**:只有 Flutter 的内存缓存(`ImageCache`),不会落盘,重启小程序后需要重新下载
- **`cacheWidth`/`cacheHeight` 与 `toByteData()`**:已支持。小程序画布给不出 2d 上下文,引擎需要的离屏 2d 画布由 CanvasKit 的 CPU 光栅 surface 实现(缩放、`getImageData`、PNG 编码都在 wasm 里完成);注意 `cacheWidth` 仍是先按原尺寸解码再缩放,解码瞬间的内存峰值不会降低,缩放后常驻内存才按目标尺寸计;`toByteData(format: rawRgba)` 返回**非预乘(straight)**RGBA 像素(与浏览器一致,但与 Flutter 原生平台的预乘约定不同,自行处理像素时留意);大图 `toByteData` 峰值内存约为 `宽×高×4` 的 **3 倍**,全压在 wasm 堆上,超大图注意堆上限
- **本地存储限制**:`localStorage` 由 `wx.*StorageSync` 承载,键带 `mpf:` 前缀;单键上限 1MB、总量上限 10MB,超限抛 `QuotaExceededError`;超限时 `shared_preferences` 的 `setX` 以错误结束,但其内存缓存已经写入新值(与浏览器行为一致——写失败不回滚已经乐观更新的内存态)
- **重定向由 wx 自动跟随,不受应用控制**:`wx.request` 收到 3xx 会自己跟到底,拿到的 `response.url`/XHR 的 `responseURL` 恒为**请求时的 URL**(不是最终落地 URL),`response.redirected` 恒为 `false`;`fetch` 的 `redirect: 'manual'` 选项被忽略(不会拿到 opaqueredirect 响应)
- **超时是一个总时长,不是分段的**:dio 的 `connectTimeout`/`receiveTimeout` 在垫片这层被合并成同一个 `xhr.timeout`(= connectTimeout + receiveTimeout);连接慢 + 下载大文件时,即使连接和下载各自都不到单项超时阈值,加起来超过总时长也会报 `connectionTimeout`/timeout 类异常
- **PATCH 已实测可用**:开发者工具(stable / flutter_ohos / `--force-platform android` 三种构建配置)里 `http.patch()`/`wx.request({method:'PATCH'})` 均正常发出并原样回显 `X-Method: PATCH`;`accept-net.js` 只记录这一项,不作为验收失败条件(微信官方文档未明确列出 PATCH,建议上线前仍用真机复测)

### 随机数(K4:`Random.secure()` / `crypto.getRandomValues` / `crypto.randomUUID`)

已支持,用法零改动:`dart:math` 的 `Random.secure()`(dart2js 编译到 web 时经
`self.crypto.getRandomValues`)、直接调用的 `crypto.getRandomValues`/
`crypto.randomUUID` 照常写。启动时用 `wx.getRandomValues` 取一次真随机种子,
喂给 ChaCha20(RFC 8439)当确定性随机数发生器(DRBG),之后本地同步产出,不再
每次都跨进程往返;每产出 1MB 或每 60s(先到者为准)后台重新播种一次
(fast-key-erasure,不阻塞调用方)。

- **依赖 `wx.getRandomValues`**:需基础库支持 `wx.getRandomValues` 接口(具体
  最低基础库版本请查微信官方文档);不支持、播种失败,或首次播种在 4 秒内
  没有回调(超时按失败处理,不会让承载页永久黑屏)时,不挂载
  `window.crypto`/`self.crypto`——Dart 侧 `Random.secure()` 按浏览器无该 API
  时的标准语义抛 `Unsupported`,不会伪造安全性(不会退化成 `Math.random`
  之类的假随机源)
- **单次请求上限 65536 字节**:与浏览器 `crypto.getRandomValues` 一致,超出抛
  `QuotaExceededError`

### 安全区

承载页是全屏画布(`navigationStyle: custom`)。Flutter Web 引擎自己的
`viewPadding` 恒为 0,mp-flutter 在构建时用一个生成的入口包装
(`.dart_tool/mp_flutter/entrypoint.dart`,传给 `flutter build web -t`;`lib/main.dart`
不改)把小程序安全区注入 `MediaQuery.padding`/`viewPadding`:top = 状态栏
(`safeArea.top`),bottom = 窗口高 − `safeArea.bottom`,横竖屏切换经
`wx.onWindowResize` 更新。`SafeArea` 零改动生效。胶囊按钮不算进 padding,
需要避开时用 `MpWechat.menuButtonRect()`(见 `packages/mp_flutter_wechat/README.md`)。

**限制**:这套注入依赖构建期生成的入口包装接管 `WidgetsFlutterBinding`。工程
若在 `runApp()` 之前自己创建了绑定子类(例如自定义
`WidgetsFlutterBinding`/`TestWidgetsFlutterBinding` 派生类并显式
`ensureInitialized()`),会与入口包装冲突——**release 构建下注入悄悄不生效**
(`SafeArea` 仍会工作,但 padding 取不到小程序的真实安全区数值,恒为 0),
**profile 构建下启动即崩溃**(`Extension already registered`)。这类工程请
显式加 `--no-safe-area`(或 `mp_flutter.yaml` 的 `safe_area: false`,默认
`true`)关闭本包装,直接构建 `--target` 指向的入口文件(默认
`lib/main.dart`),自行处理安全区(比如自己读取
`wx.getWindowInfo().safeArea`)。

### 微信能力

微信登录、支付等能力**不能**像网络/存储那样透明接管——需要主工程显式调用,所以做成独立的 Dart 包 `package:mp_flutter_wechat`,底层经 JS 桥(`self.__mpWechat`,见 `packages/mp_flutter/runtime/wechat.js`)转发到 `wx.*`。

#### 引入

```yaml
dependencies:
  mp_flutter_wechat:
    git:
      url: https://github.com/jackwangfeng/mp-flutter.git
      path: packages/mp_flutter_wechat
      ref: v0.2.5
```

```dart
import 'package:mp_flutter_wechat/mp_flutter_wechat.dart';

if (MpWechat.isAvailable) {           // 非 mp-flutter 编译的小程序里恒为 false
  final code = await MpWechat.login();
  // ... 把 code 发给你的服务端换 openid/session_key
}
```

#### API

全部为 `MpWechat` 上的静态方法;不可用(非小程序环境)时 `call`/具名方法抛 `UnsupportedError`,微信侧调用失败(含用户取消)时抛 `MpWechatException`(`api`/`errMsg`/`cancelled` 三个字段,`cancelled` 由 `errMsg` 是否含 `cancel` 判定)。

| 方法 | 对应微信 API | 说明 |
|---|---|---|
| `MpWechat.login()` | `wx.login` | 只返回 `code`,换 openid/session_key 见下 |
| `MpWechat.checkSession()` | `wx.checkSession` | 登录态是否仍有效;失败(含不可用)返回 `false`,不抛 |
| `MpWechat.requestPayment(MpPaymentParams)` | `wx.requestPayment` | 参数须来自服务端"统一下单"签名结果 |
| `MpWechat.chooseAddress()` | `wx.chooseAddress` | 返回 `MpAddress` |
| `MpWechat.scanCode({onlyFromCamera})` | `wx.scanCode` | 返回 `MpScanResult` |
| `MpWechat.setClipboardData(String)` / `getClipboardData()` | `wx.setClipboardData` / `wx.getClipboardData` | 剪贴板往返 |
| `MpWechat.getLocation({type})` | `wx.getLocation` | 返回 `MpLocation`;需要 `--require-location` 或 `--private-info=getLocation`(见下) |
| `MpWechat.makePhoneCall(String)` | `wx.makePhoneCall` | 拨号 |
| `MpWechat.setShareInfo({title, path, imageUrl, query})` | 承载页 `onShareAppMessage`/`onShareTimeline` | 设置转发/朋友圈分享信息,见下 |
| `MpWechat.menuButtonRect()` | `wx.getMenuButtonBoundingClientRect` | 胶囊按钮位置(`Future<Rect?>`,逻辑像素);非小程序环境返回 `null`,见上方「安全区」 |
| `MpWechat.call(String api, [Map params])` | 任意 `wx.*` | 逃生舱:上表没覆盖的接口可以直接调;仅支持 success/fail 回调式异步接口——同步接口(`*Sync`)、事件订阅(`on*`/`off*`)、工厂/句柄(`create*`、`*Manager`)会立即报错,不会挂起 |

单测可用 `MpWechat.debugSetChannel(FakeChannel)` 注入假通道,不依赖真实小程序环境(见 `packages/mp_flutter_wechat/test/mp_flutter_wechat_test.dart`)。

#### 服务端职责(客户端做不了,也不应该做)

- **`login()` 只给你 code**:换 openid/session_key 必须由业务服务端调用微信 `code2Session`(需要 AppSecret,不能放进客户端包);示例见 `tools/e2e/test-server.js` 的 `/api/wx/login`(模拟)
- **支付参数必须服务端签名**:`requestPayment` 的 `timeStamp`/`nonceStr`/`package`/`signType`/`paySign` 来自服务端"统一下单"接口用商户密钥签名的结果,客户端自己拼不出合法的 `paySign`;示例见 `/api/wx/prepay`(故意给一个无效 `paySign`,用来验证失败路径可诊断、不挂起)

#### 用户隐私接口声明(`--require-location` / `--private-info`)

调用 `wx.getLocation`、`wx.chooseLocation` 等用户隐私相关接口前,构建时需要显式声明用途,写进 `app.json` 的 `requiredPrivateInfos`(定位类接口还需要 `permission.scope.userLocation` 权限说明),否则微信会拒绝调用。

- `--require-location`(或 `mp_flutter.yaml` 里 `require_location: true`):历史开关,等价于 `--private-info=getLocation`,只声明 `getLocation`。
- `--private-info=<接口名>`(可重复;或 `mp_flutter.yaml` 里 `private_infos: [接口名, ...]`):按需声明任意隐私接口,取值:`getFuzzyLocation`/`getLocation`/`onLocationChange`/`startLocationUpdate`/`startLocationUpdateBackground`/`chooseAddress`/`choosePoi`/`chooseLocation`。命令行与 `mp_flutter.yaml` 的取值合并去重,两者可同时使用。`getLocation` 与 `getFuzzyLocation` 微信不允许同时声明,同时出现会在构建期报错(退出码 64)。

```yaml
# mp_flutter.yaml
private_infos: [chooseLocation, choosePoi]
```

权限说明文案当前固定写死为「用于展示附近门店与配送范围」(见 `packages/mp_flutter/lib/src/emit_project.dart`),暂不可配置。除了这里的客户端声明,每个接口还需要在**小程序管理后台**「开发管理 → 接口设置」里单独启用(`getLocation` 对应「获取地理位置」),否则真机会被拒绝调用(开发者工具不受此限制)。

#### 分享

`MpWechat.setShareInfo` 设置的信息由承载页的 `onShareAppMessage`/`onShareTimeline` 读取(见 `packages/mp_flutter/lib/src/pipeline.dart`):未设置字段时,`onShareAppMessage` 用 `{path: '/<入口页>'}`、不带 `title`(微信用小程序名兜底);`onShareTimeline` 不支持 `path`(固定为当前页),只透传已设置的 `title`/`query`/`imageUrl`。每次 `setShareInfo` 都是整体替换,不按字段合并——只传 `title` 的下一次调用会连带清空之前设置的 `path`/`imageUrl`/`query`。

`setShareInfo` 传的 `path` 应该指向入口页(`/pages/flutter/flutter…`):产物(`mp_flutter` 编译出来的小程序)只有这一个页面,分享到其它 `path` 微信会直接打不开。

**已知限制**:分享出去的链接带的 `query` 目前传不到 Dart 侧——承载页 `onLoad(options)` 拿到的 `options.query`(小程序打开参数,如从分享卡片进入时带的 query)没有转发给 `self.__mpWechat`/引擎,业务代码目前读不到"是通过哪个分享链接进来的"。列为后续项,需要在 `onLoad` 里把 `options` 转发到 Dart 侧(例如经 wechat 桥新增一个只读入口)。

#### 真机验收要点

- 需要**真实 appid**(`touristappid` 等游客态 appid 大多数微信能力不可用或行为不同)
- 登录/分享等一般能力,把自己加进小程序的**体验成员**即可在真机上跑通(开发版/体验版)
- **支付**额外需要:已绑定的**商户号**、业务服务端完成统一下单签名;开发者工具里用无效签名验证的是"失败路径可诊断",**不代表真机支付流程本身已验证**,上线前必须用真实商户号走一遍 0.01 元支付的成功与取消两条路径
- 定位类接口记得带上 `--require-location`(或对应的 `--private-info`),并在小程序管理后台「开发管理 → 接口设置」里启用该接口,否则真机会直接拒绝

#### 验收

```bash
dart run mp_flutter --project <验收工程> --output <产物目录> --verify --appid <appid>
cd tools/e2e && node accept-wx.js <产物目录>
```

覆盖:`wx_available`、登录拿 code、code 送模拟后端换 openid、`checkSession`、支付失败路径(无效签名,断言错误消息里带 `requestPayment`)、剪贴板往返、分享(默认值与 `setShareInfo` 之后各取一次)。已在开发者工具 stable / `flutter_ohos` / `--force-platform android` 三种构建配置下验证。

**实测的 `requestPayment` 行为**:用游客态/未绑定支付的 appid 在开发者工具里发起 `wx.requestPayment`(即使参数是精心构造的无效签名),微信直接以 `requestPayment:fail no permission, appId=<appid>` 结束——权限检查先于签名校验,不会弹出二维码或挂起。真实商户号 + 有效签名下的完整成功/取消路径需要真机验证(见上「真机验收要点」)。

### 原生组件

`MpVideo`/`MpMap`/`MpCamera` 把 Flutter 里的 `HtmlElementView` 占位映射成真正的微信原生组件(`<video>`/`<map>`/`<camera>`),而不是用 canvas 模拟——原生视图同步层(`packages/mp_flutter/runtime/native-views.js`)按 Flutter 的实际布局逐帧读回位置/尺寸/裁剪,同层叠加到 WXML 上。独立 Dart 包,引入方式、用法与完整 API 见 [`packages/mp_flutter_native/README.md`](packages/mp_flutter_native/README.md)。

- **层序限制**:原生组件**永远叠在 Flutter 画布之上**,不能插入 Flutter 图层栈中间——`Stack` 里想盖在视频/地图上面的 Flutter 内容会被组件本身遮住。需要在原生组件之上叠 UI,改用小程序自己的 `cover-view`/`cover-image`,或者把交互 UI 挪到原生组件区域之外(spec §4 决策 C)
- **同步策略**:每帧最多一次 `setData`——静止时零开销,只有位置/尺寸/裁剪/透明度真正变化(阈值 0.5 逻辑像素 / 0.01 不透明度)时才合并上报所有原生组件的几何,不逐条监听 CSS 写入(滚动动画单帧可产生数十条样式写入,远超 `setData` 预算,见探针文档 §4)
- **fallback**:非小程序平台(App/桌面/普通 Web)渲染 `fallback ?? const SizedBox.shrink()`,控制器方法明确抛 `UnsupportedError`,不静默失败;`mpNativeAvailable` 可提前判断
- **支持的组件与命令/事件清单**:

  | 组件 | 命令(`command`) | 事件 |
  |---|---|---|
  | `MpVideo` | `play`/`pause`/`seek`/`stop`/`requestFullScreen`/`exitFullScreen` | `onPlay`/`onPause`/`onEnded`/`onTimeUpdate`/`onError` |
  | `MpMap` | `moveToLocation`/`getCenterLocation` | `onTap`/`onMarkerTap`/`onRegionChange`(`begin`/`end`) |
  | `MpCamera` | `takePhoto` | `onError` |

- **真机待验**:视频播放/暂停/全屏、地图拖动+标记点击、相机拍照、列表中视频随滚动跟随——均已在模拟器验证,真机行为(手势/性能)未逐项复核

### WXML 伴生层

可选(默认关)的语义树镜像:把 Flutter 的 semantics 树同步成一批视觉隐藏(`opacity:0`、`pointer-events:none`)、按矩形定位的 WXML `<text>` 节点,服务微信「页面内容索引」与无障碍——纯 canvas 渲染的内容既不可被微信索引,也没有无障碍语义,伴生层一次性缓解两者(设计动机见 spec §4.1)。

```bash
dart run mp_flutter --project <工程> --output <产物目录> --semantics-mirror
```

- **默认关的取舍(裁定)**:语义树本身有运行时开销——引擎一旦激活就要持续维护整棵 `flt-semantics` 影子树,伴生层再叠加一层 500ms 轮询 + `setData`;不是每个 App 都需要页面内容索引或无障碍能力,不能替所有 App 默认打开,只有业务明确需要时才显式加 `--semantics-mirror`(或 `mp_flutter.yaml` 的 `semantics_mirror: true`)
- **激活**:boot 成功后合成并派发一次落在语义占位元素(`flt-semantics-placeholder`)矩形中心的 `click` 事件(只发这一次),满足引擎 `tryEnableSemantics` 的开启条件
- **镜像**:每 500ms 扫描一次 `flt-semantics` 子树,取每个节点的 `aria-label`/文本与屏幕矩形,整份数组 diff 后才 `setData`;条目数上限 500,超出截断并只警告一次
- **★ 已知限制**:视觉隐藏与「不拦截触摸」目前只由 CSS(`opacity:0; pointer-events:none`)保证,尚未在真机上逐项复核,列入 Phase 5 真机验收清单(见 spec §9)
- **★★ 已知风险:`--semantics-mirror` + 文本输入(TextField)**。语义树激活后引擎把
  `HybridTextEditing.strategy` 切到 `SemanticsTextEditingStrategy`——真正的 `<input>`/`<textarea>` 不再是独立浮层,
  而是挂进它自己的 `<flt-semantics>` 节点,位置由祖先链的 `transform` 决定(已在 `text-bridge.js` 修好这一步的几何
  计算,沿祖先链累加到 `<flt-semantics-host>` 的 `scale(1/dpr)`,单测见 `tools/mp-context/text.test.js`)。此前
  E2E 实测(`--semantics-mirror` 构建跑 `accept-interact.js`)发现:滚动列表后再次点击聚焦 TextField 会让引擎
  崩溃(`Null check operator used on a null value` / `TypeError: Cannot read properties of null (reading 'cullRect')`,
  出现在 CanvasKit 渲染管线内部)。**根因已查明并修复**:垫片当时缺 `self.scheduleImmediate`,导致 Dart 微任务
  退化成 `setTimeout` 调度,下一帧得以插进 `draw()` 的 `await` 与 preroll 之间,读到一张在途 dispose 的
  `SkPicture`(K5,`4968feb`)。2026-09-28 终审复测(同样用 `--semantics-mirror` 构建 `tools/e2e/apps/mpf_interact`
  并跑 `accept-interact.js`,含 7.5s 超时重试)**未再复现这个崩溃**,整次运行控制台无 error。但复测同时发现
  另一个此前未记录的问题:滚动列表后再次点击聚焦 TextField,原生输入框(`.mp-input`)始终不再出现(不是崩溃,
  是文本输入功能本身没有生效),根因待查,不在本轮修复范围内——同一构建、不加 `--semantics-mirror` 时该步骤
  正常通过,排除了测试环境本身的问题。**结论:`--semantics-mirror` 与文本输入同时使用仍不可靠**——此前的渲染
  管线崩溃已经解决,但该组合下文本输入本身目前无法使用;业务侧如果同时需要两者,请先用回归套件针对自己的
  交互流程实测。

### 包体积与冷启动

**首帧前只加载必需的分包。** 微信分包是整包下载的(`require.async` 分包里任意一个
模块都会把整个分包拉下来),所以资源按"首帧前是否一定会用到"分成两类:

| 分包 | 内容 | 何时下载 |
|---|---|---|
| `pkg-dart-*`、`pkg-wasm` | `main.dart.js` 分片、CanvasKit | 首帧前(默认 `pkg-dart-0` 走 preloadRule 预下载;`pkg-wasm` 一到就编译,不等 dart 分包) |
| 主包 `mp-assets-boot/`(默认)或 `pkg-assets-boot` | `FontManifest.json`、`AssetManifest.bin(.json)`、FontManifest 里声明的全部字体(如 MaterialIcons)、回退 Roboto | 首帧前。默认并进主包(并入后主包 ≤1200KB 时),放不下就并进最小的 dart 分包,都放不下才单独成 `pkg-assets-boot`(与 CanvasKit 初始化、Dart 分片执行并行下载,引擎初始化取字体前等齐) |
| `pkg-cjk` | 常用汉字合一字体(`cjk_font`,brotli 压缩的 TTF:level1 约 650KB,full 约 1.1MB,默认 full) | 首帧前;boot 一开始就拉,就位后直接读文件 |
| `pkg-cjkb` | 合一字体的粗体(`cjk_font_bold`,默认跟随 `cjk_font`:full 约 1.17MB,level1 约 660KB) | 不挡首帧;默认首帧提交后才请求,到了空闲时补注册 |
| `pkg-notices` | `assets/NOTICES`(第三方许可证全文,依赖多时 1–2MB) | 打开许可证页时 |
| `pkg-fonts-*` | 简体中文回退字体分片(约 512KB 一个) | 页面第一次出现相应汉字时 |
| `pkg-assets-*` | 图片、shader 等其余资源(按路径排序,约 512KB 一个) | 引擎第一次请求其中某个资源时 |

"首帧前一定会用到"的依据是 Flutter 3.41.9 源码:引擎初始化(`initializeEngineServices`
→ `_downloadAssetFonts`)读 `FontManifest.json` 并下载其中声明的**全部**字体,清单里没有
Roboto 时再下载回退 Roboto(`canvaskit/fonts.dart` `loadAssetFonts`);框架解析
`Image.asset` 时读 `AssetManifest.bin.json`。shader(`ink_sparkle`/`stretch_effect`)只在
对应效果第一次出现时经 `FragmentProgram.fromAsset` 加载;NOTICES 只在监听
`LicenseRegistry.licenses` 时加载。

**回退字体的分组**:notosanssc 的 101 个分片分两类——20 个"常用字"分片(每片约 190 个
高频字,码位散布整个 CJK 区)和按码位段切的生僻字分片。常用字分片排在最前聚成几个包,
其余按覆盖码点的中位数排序、码位相近的装进同一个包(数据取自 SDK 自带的引擎回退字体表)。
一个真实电商小程序的界面文案(833 个不同汉字)按引擎的选字体算法模拟:只需下载 7 个字体包中的 2 个
(0.95MB,整套 3.10MB)。服务端下发的文案会用到更多分片,但都不阻塞首帧。

**常用汉字合一字体(`cjk_font: level1 | full | false`,CLI `--cjk-font=level1|full` / `--no-cjk-font`,
默认 `full`)**:引擎的简体中文回退字体被切成约 100 个分片,常用字散在几十片里,一屏中文要拉几十个
分片;每批分片到齐引擎就发一次 `fontsChange`,框架把**所有**段落重新排版(真机首屏 3 次,每次
600–700ms 的 layout)。现在随包带一个单文件字体(Noto Sans SC v37 子集,`tools/fonts/gen_cjk_common.py`
可复现生成,两档都已入库在 `packages/mp_flutter/fonts/`,构建时不需要 Python):

| 档位 | 字表 | TTF | 包内(brotli) | 取舍 |
|---|---|---:|---:|---|
| `full`(默认) | GB2312 一二级 6763 字 + 标点/全角/Latin-1/常用符号(¥×°·℃①─○★ 等) | 2.2MB | 约 1.15MB | 首屏几乎不再触发分片;真机实测在首帧关键路径之外(读取 28–30ms,首帧 354/533ms) |
| `level1` | 仅一级 3755 字 + 标点/全角/Latin-1/常用符号 | 1.2MB | 约 650KB | 字表更小,但服务端下发的文案常含二级字/生僻符号:该真实电商小程序真机首屏仍触发额外回退分片下载与 `fontsChange`,反而更慢 |
| `false` | 不带 | — | — | 工程自带中文字体(在 FontManifest 里声明)时用 |

真机数据显示 `full` 并不在首帧关键路径上(字体读取 28–30ms,首帧仍是 354ms/533ms),而 `level1`
省下的体积换来的是服务端下发文案命中二级字/常用符号时的额外回退分片 fetch 和一次 `fontsChange`
整体重排,得不偿失,因此默认改为 `full`;字表外的生僻字仍按需下载分片。

**怎么加载**:字体 brotli 压缩后放进独立分包 `pkg-cjk`(不再 base64 内嵌 JS——真机上引擎取字体时才
`require.async` 两个 1–1.4MB 的 base64 模块再解码,iOS 2.1MB 字体等了 1536ms,且串在 dart-main 之后)。
boot 一开始就拉这个分包,就位后用 `FileSystemManager.readCompressedFile`(代码包文件 + 原生 brotli
解压;`readFile` 读代码包里的字体文件是 `permission denied`)读出字节,与 wasm 编译、Dart 分片加载
并行;CanvasKit 一就绪就先解析一次,引擎初始化取字体时直接用这份字节应答、解析命中缓存。读取失败
(基础库过低等)时引擎拿到 404、照常启动,中文退回按需下载分片。

构建期给 `main.dart.js` 打两处补丁(`transform/font_fallback.dart`,结构化匹配,上游变了会点名报错):
引擎把合一字体当作 Roboto 之后的第一个回退字体,缺字检测时也算上它、只把真正缺的码点交给选字体
算法——字表外的字只拉它自己所在的那一片。选 TTF 不选 woff2:woff2 每次建 FreeType face 都要整份
解压,无 JIT 的 iOS 上一次启动要解好几次;包内体积由 brotli 压缩解决。

**合一字体粗体(`cjk_font_bold: level1 | full | false`,CLI `--cjk-font-bold=...`,默认跟随 `cjk_font`)**:
标题、价格常用 `FontWeight.w600` 以上,而合一字体与回退分片都只有常规字重。SkParagraph 发现所选字体比请求
的字重轻(请求 ≥600、字体 <600)就合成加粗(SkFont embolden)——每个字形第一次出现都要逐点加粗轮廓、重算
边界。iOS 小程序没有 JIT,这正是进商品详情页那一帧 200–400ms 长帧里 layout 的大头。真实 CanvasKit(完整版
wasm)基准,同一段 30 个没出现过的汉字、22px、宽 350,每种 60–100 次取中位数:

| 运行环境 | 常规 w400 | 合成加粗 w700 | 合成加粗(先用 w400 预热同一字符串) | 真粗体 w700 | 重复排版(字形已缓存) |
|---|---:|---:|---:|---:|---:|
| JSC 关 JIT(bun,`BUN_JSC_useJIT=0`,近似 iOS) | 7.3ms | 30.2ms | 30.5ms | 7.4ms | 0.17ms |
| V8 `--liftoff-only`(只有基线编译) | 0.63ms | 2.19ms | 2.21ms | 0.58ms | 0.014ms |
| V8 默认 JIT | 0.32ms | 1.00ms | 1.05ms | 0.27ms | 0.010ms |

预热 shaping 不改变合成加粗的开销,开销在逐字形加粗,不在 shaping;真粗体与常规一样快。所以随包带一份
Noto Sans SC v37 Bold 子集(与常规同一字表,已入库),在 FontManifest 里作为同一家族(`MpNotoSansSC`)
的第二个字体(字重 700)注册,引擎按字重匹配到它,回退字体表里仍只有一个 family 名。

- **必须与 `cjk_font` 同档**:同一 family 下 SkParagraph 按字重只选一个字体排版,粗体缺的字直接画成
  豆腐块(不会退回同家族的常规字体),而引擎缺字检测按家族把所有字体的覆盖取并集,认为"有字"就不去拉
  回退分片;构建期对不同档直接报错。
- **不挡首帧**:粗体放独立分包 `pkg-cjkb`(full 常规 + full 粗体超过单分包 2048KB),默认
  (`cjk_font_bold_timing: after_first_frame`)首帧提交之后才请求,首帧前不和 wasm/dart/常规字体抢带宽,
  首帧里的粗体一律先合成加粗,字节到了在空闲时(没有手指按着、最近 300ms 没有出帧)补注册;
  `cjk_font_bold_timing: eager`(`--cjk-font-bold-timing=eager`)恢复 0.2.3 的行为:boot 在 dart/wasm/
  启动资源包请求发出之后就开始读。eager 下引擎取字体时,粗体只要不晚于常规字体到就一起应答(常规字体本来就在
  等,零额外等待;首帧前注册不发 fontsChange;模拟器里引擎取用等待 0–1ms);晚到则先按 404 应答(控制台
  有一行引擎的 `not found (404)` 警告),首帧照常画(粗体文字这时仍是合成加粗),字节到了经入口包装在
  首帧之后调用 `ui.loadFontFromList` 补注册——引擎发一次 fontsChange,框架把段落重排一遍。这次重排
  字形缓存是热的,只多一次 shaping(基准:无 JIT 下每段约 0.6ms;模拟器该真实电商小程序首页 54 段 13ms),比首帧
  等一个 1MB 的分包便宜。`--no-safe-area`(没有入口包装)时晚到的粗体不再使用。
- **体积**:full 约 1.17MB、level1 约 660KB(brotli),总包相应增加;总包紧张时 `--cjk-font-bold=false`。
- **没覆盖的**:字表外的字(回退分片)只有常规字重,粗体照旧合成;拉丁字母/数字排在 Roboto(只有常规)
  上也仍是合成加粗——字形少,缓存之后没有开销。
- `--perf-hud` 的长帧明细里 `fakeBold=N` 是本帧 build 的合成加粗段落数(字重 ≥600 而字体列表里没有
  注册过粗体的家族),用来在真机上确认它是否还在。

另外两处与字体相关的运行时处理(始终开启):
- **同一份字体字节只解析一次**(`runtime/typeface-memo.js`):引擎每注册一批回退字体都新建
  字体集、把迄今所有字体重新 `registerFont` 一遍(第 k 批要把前面的全部再解析一次);现在按
  字节缓存 Typeface,重注册不再解析。
- **回退字体合并窗口**(`net.js`,100ms):同一阵的回退分片响应等到最后一次请求后 100ms 且
  全部落地才一起交给引擎,窗口内陆续冒出的缺字并进同一批注册、一次 `fontsChange`(最多压 1s)。
- **按需分包单飞**(`mp-manifest.js` 的 `inPkg`):同一个未下载的分包同一时刻只发一次
  `require.async`,同包其余资源等它落地后再取(基础库对并发的 `require.async` 不去重,每次都走
  一遍原生分包加载;安卓真机上这批请求里后到的恰好等 1001–1003ms)。

该真实电商小程序在开发者工具里的对比(有 JIT,只看相对值;首屏 + 4 次滑动,各跑两次):

| | 改动前 | 旧合一字体(base64,full) | level1 | full |
|---|---:|---:|---:|---:|
| 首帧 = total(ms) | 540 / 594 | 592 / 584 | 689 / 581 | 532 / 579 |
| 首帧后回退分片 fetch | 20 | 0 | 3 | 0 |
| fontsChange | 5–6 | 0 | 2 | 0 |
| >50ms 长帧 | 3–4 个(68–97ms) | 0 | 0 | 0 |
| 引擎取字体时的等待 | — | 23–24ms(fetch) | 0ms | 0–1ms |

模拟器里首帧差异在噪声内;真机上旧方案的 `cjk-font fetch` 是 iOS 1536ms / 安卓 815ms,新方案看
`[mp-perf] cjk-font pkg / read / parse / 引擎取用等待` 几行(`--perf-hud`)。

**冷启动开关**(每项都能单独开关,方便真机 A/B;默认是冷启动方案推荐的组合):

| `mp_flutter.yaml` / CLI | 默认 | 作用 |
|---|---|---|
| `preload` / `--preload=auto\|dart\|wasm\|none` | `auto`(目前等于 `dart`) | app.json preloadRule(额度 2MB)按什么顺序挑分包。`dart`:dart 分包 → 启动资源包 → wasm → 常规字体(dart 分包到了还要在 JS 线程上注入,先到能和 wasm 下载重叠);`wasm`:0.2.3 的 wasm 优先顺序;`none`:不写 preloadRule |
| `early_wasm` / `--[no-]early-wasm` | 开 | `pkg-wasm` 一到就编译并实例化 CanvasKit,不等 dart 分包;装垫片、执行 Dart 仍在两边都就位之后 |
| `cjk_font_bold_timing` / `--cjk-font-bold-timing=after_first_frame\|eager` | `after_first_frame` | 粗体合一字体首帧后才请求(见上) |
| `boot_assets` / `--boot-assets=auto\|main\|dart\|package` | `auto` | 启动资源放哪:主包 → 最小的 dart 分包 → 单独分包(`package` = 0.2.3 行为),少一个首帧前分包请求 |
| `initial_rendering_cache` / `--[no-]initial-rendering-cache` | 开 | 承载页 `initialRenderingCache: static`:第二次起冷启动时原生启动界面直接上屏,不等主包 JS 注入和 onLoad(缓存里只有启动界面的 view/text,canvas 不显示,正好被启动界面盖住) |
| `lazy_code_loading` / `--[no-]lazy-code-loading` | 开 | app.json `lazyCodeLoading: requiredComponents`;我们只有一个真页面、没有自定义组件,收益很小,无害 |

`--perf-hud` 下每个分包打一行 `[mp-boot] pkg <name> req=+x dl=+a..+b inject=c ready=+y size=…`:
`req`/`ready` 是 boot 发出/等到 `require.async` 的时刻,`dl` 是 `wx.getPerformance()` 的
`loadPackage` 条目给出的真实下载时间窗,`inject` 是 `evaluateScript` 条目里该分包 JS 的注入耗时,
都相对 `App.onLaunch`;基础库不支持时 `dl`/`inject` 省略。另有 `[mp-boot] wx route(appLaunch) …`、
`firstRender` 等条目补上 onLaunch 之前的时间,`[mp-boot] ck-wait-dart`(dart 分包全部就位 −
CanvasKit 就绪,为正说明 wasm 编译已完全藏在 dart 分包后面)。

**分包数量**:微信官方文档只限制单个分包/主包 ≤2MB、全部分包合计 ≤30MB(服务商代开发
的小程序 ≤20MB),没有分包个数上限
([分包加载文档](https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages.html));
按需分包约 512KB 一个是在"按需下载的浪费"和"分包太碎、每包一次往返"之间的折中。

**真实电商小程序实测**(同一份代码,改动前 `62ba15f` → 改动后;源码字节口径,MB = 1024×1024 字节;
下表"改动后"两列已按当前默认 `cjk_font: full` 重新测量,比 `cjk_font` 默认开启前多约 1.1MB——
见下方 `cjk_font` 一节与 CHANGELOG):

| | 改动前 | 改动后(默认,含 `cjk_font: full`) | `--no-licenses --font-base-url` |
|---|---:|---:|---:|
| 首帧前阻塞下载(主包 + 启动分包) | 10.04MB | 6.33MB | 6.30MB |
| 其中不在 preloadRule 预下载里的 | 8.26MB | 4.45MB | 4.43MB |
| 总包 | 10.04MB | 11.21MB | 6.32MB(另有 2.30MB 字体在 CDN) |
| 分包数 | 6 | 14 | 6 |

**许可证(`--no-licenses` / `licenses: false`)**:默认打包 NOTICES(在按需分包里,不影响
启动)。不需要许可证页时可以关掉,NOTICES 换成空占位:`showLicensePage` 仍可打开,只是不
列出第三方包。为什么是空占位而不是直接不打包,见
[`docs/troubleshooting.md`](docs/troubleshooting.md)(不打包会让许可证页永远转圈)。

**远端字体(`font_base_url` / `--font-base-url`)**:

```yaml
font_base_url: https://cdn.example.com/mp-fonts/
```

**实际移到远端的范围**:构建期只打包两个回退字体家族——`roboto`(引擎默认字体,缺了首帧必崩,
**始终留在包内**,启动不依赖 CDN)与 `notosanssc`(简体中文回退,101 个分片,约 2.4MB)。设置
`font_base_url` 后,`notosanssc` 的全部分片都不打进包,换成运行时按需从 CDN 拉取;`roboto` 不受
影响。除这两个家族外,引擎回退字体表里其余家族(**emoji、日文 `notosansjp`、韩文 `notosanskr`、
繁体中文等**)本来就不打包、也不受 `font_base_url` 影响——请求这些分片一律得到 404,相应字符不
显示,但不影响启动(见 `lib/src/fonts.dart` 的 `kDefaultFontFamilies`);这是当前已知限制,不是
`font_base_url` 引入的行为。

设置后,构建在产物下输出待上传目录 `mp-fonts-remote/`
(已写进 `project.config.json` 的 `packOptions.ignore`,不会被当成代码包上传),**需要原样
上传到该地址**。运行时引擎请求字体分片时由 `net.js` 用 `wx.request`(arraybuffer)拉取,缓存
到本地用户文件 `wx.env.USER_DATA_PATH/mp-fonts-cache/`(按文件名缓存,上限 10MB、LRU 淘汰),
下次启动直接读本地文件。**该域名必须加进小程序后台「request 合法域名」**,否则真机下载失败、
中文不显示(开发者工具默认不校验域名,会掩盖这个问题)。
不设置时字体照常打包、按需加载。

**原生启动界面**:Flutter 首帧提交前,承载页显示一个原生 WXML 层——应用名(`splash_title`,
缺省用 pubspec 的 `name`,同时写进 app.json 的 `navigationBarTitleText`)、背景色
(`splash_color`,缺省白色)和一条细进度条(按已完成的启动阶段数估算)。首帧提交后移除;
首帧前失败时显示错误文案,不留黑屏。

**不做**:按 App 文案做字体子集——电商类 App 的文字多由服务端动态下发,构建期子集会丢字。
常用汉字合一字体是按 GB2312 固定字表切的通用子集(level1 / full),不依赖 App 文案;字表外的字照常走回退分片。

## 能力边界 / 复杂页面指南

mp-flutter 渲染管线在 iOS 真机(无 JIT)上对"重"页面比安卓/模拟器更敏感。仓
库自带压测页(`example/lib/stress`,`--dart-define=MP_STRESS=true` 开启)在
iPhone 15 / Xiaomi 2206122SC 真机上跑出了长列表、图片墙、长图文、大表单、
视觉效果、原生组件七类场景的首帧/帧率/最长帧数据,并给出一个真实电商小程序
的线上基线和"能撑多大"的可操作经验值(懒加载列表行数不受限、一次性构建的
文字建议控制在约 1500 字/50 段以内、表单超过 10–15 个输入框建议分步等)。
详见 [`docs/capability-guide.md`](docs/capability-guide.md)。

## 真机验证

除模拟器(微信开发者工具)回归套件外,已在以下真机环境跑过一个真实电商小程序(交易类
App,覆盖列表滚动、图片、网络、微信能力等典型场景)完整验收:

| 设备 | 系统 | 微信版本 | 基础库 |
|---|---|---|---|
| iPhone 15 | iOS 26.5 | 8.0.77 | 3.17.3 |
| Xiaomi(Android) | Android 15(API 35) | 8.0.78 | 3.17.3 |

**关键指标**(真机,release 构建):

- 冷启动(小程序打开到首帧可交互):约 **3.9–4.3s**
- 稳态滚动帧率:iOS **40–55 fps**,Android **50–61 fps**

**已知限制**(完整清单见 [`docs/support-matrix.md`](docs/support-matrix.md)):

- 文本输入首次聚焦偶发丢一帧的渲染管线崩溃已修复;但 `--semantics-mirror`(WXML 伴生层)
  与文本输入同时使用时,原生输入框仍可能在特定交互序列后不再出现,该组合暂不建议同时启用
- 泰文、老挝文、高棉文、缅甸文由于 CanvasKit 完整版 ICU 瘦身(清零断词词典),词内不给换行
  机会,仅在空格处换行
- `flutter_ohos` 构建未打包 `InkSparkle`/`stretch_effect` 等 Material shader
- 网络图片无磁盘缓存,仅 `ImageCache` 内存缓存;重启小程序后需要重新下载
- 原生组件(`MpVideo`/`MpMap`/`MpCamera`)恒在 Flutter 画布之上,不能被 Flutter 图层遮挡
- 远端字体(`font_base_url`)与部分触摸手势细节(多点触控、长按选词)标注为「真机待验」,
  上线前建议按自己的交互流程实测

## FAQ / 常见问题

**Flutter 能开发微信小程序吗?**
能。mp-flutter 把标准的 Flutter 工程(Flutter Web + CanvasKit 产物)编译成微信小程序,主工程不需要改一行 Dart 代码,渲染、触摸、文本输入、网络、存储等能力由构建期注入的垫片透明接管,详见上方「能力与限制」。

**Flutter 怎么转微信小程序?**
三步:① 给 Flutter 工程加 `mp_flutter` 这个 `dev_dependency`;② 工程根跑 `dart run mp_flutter`;③ 用微信开发者工具直接打开产物目录(默认 `build/weapp`)即可运行。需要登录/支付/扫码等微信能力,或视频/地图/相机等原生组件时,额外引入 `mp_flutter_wechat`/`mp_flutter_native` 两个独立 Dart 包。完整步骤见上方「三步快速开始」。

**和 MPFlutter / Taro / uni-app 有什么区别?**
思路不同,不是谁更好的问题:Taro、uni-app 是跨端框架,需要按它们约定的组件/API 重新编写界面,编译到小程序时不经过 Flutter 渲染管线;MPFlutter 是另一个把 Flutter 编译到小程序的开源项目,采用了不同的渲染实现路径。mp-flutter 的做法是直接编译**未修改**的 Flutter Web(CanvasKit)产物,因此渲染管线与原生 Flutter 完全一致、不需要改 Dart 代码,代价是产物体积比纯小程序原生写法更大(见下方「包体积多大」)。

**支持 iOS/Android 真机吗?**
支持,已在 iPhone 15(iOS)与安卓真机上跑通一个真实电商小程序的完整验收(列表滚动、图片、网络、微信能力等典型场景),实测数据见上方「真机验证」与 [`docs/capability-guide.md`](docs/capability-guide.md)。注意:运行 `dart run mp_flutter` 的**开发机**只支持 macOS/Linux,Windows 未支持,这不影响编译产物在真机上的运行。

**包体积多大?**
取决于工程本身与所选配置,典型总包在几 MB 到十余 MB 量级(微信限制:单个分包/主包 ≤2MB,全部分包合计 ≤30MB)。默认配置下随包带常用汉字合一字体(约 1–2.3MB,减少中文首屏抖动);可用 `--no-licenses`、`--font-base-url`(回退字体改走远端 CDN)等选项显著缩小包体积。具体口径与实测数字见 [`docs/capability-guide.md`](docs/capability-guide.md)、[`docs/support-matrix.md`](docs/support-matrix.md)。

## 链接

- [`docs/architecture.md`](docs/architecture.md) —— 设计与实现原理(BOM/DOM 垫片、分包、CanvasKit 定制等)
- [`docs/support-matrix.md`](docs/support-matrix.md) —— 工具链版本、平台桥验证状态、已知限制汇总
- [`docs/capability-guide.md`](docs/capability-guide.md) —— 能力边界 / 复杂页面指南:真机压测数据、能撑多大、推荐写法
- [`docs/troubleshooting.md`](docs/troubleshooting.md) —— CLI 退出码对照与处理办法
- [`CONTRIBUTING.md`](CONTRIBUTING.md) —— 开发环境、本地检查脚本、提交约定
- [`CHANGELOG.md`](CHANGELOG.md) —— 版本历史
- [`LICENSE`](LICENSE) —— Apache License 2.0(另见 [`NOTICE`](NOTICE))
- [`packages/mp_flutter/README.md`](packages/mp_flutter/README.md) —— 构建管线包:CLI 参数、配置文件
- [`packages/mp_flutter_wechat/README.md`](packages/mp_flutter_wechat/README.md) —— 微信能力包完整 API
- [`packages/mp_flutter_native/README.md`](packages/mp_flutter_native/README.md) —— 原生组件包完整 API
- [`example/`](example/) —— 示例工程(dogfooding 用,覆盖每类能力)
- [`tools/e2e/README.md`](tools/e2e/README.md) —— E2E 回归套件,本地手动跑
