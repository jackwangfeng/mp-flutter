# flutter_miniprogram 示例工程

一个普通的 Flutter Web 工程,底部导航 5 个 tab,覆盖 mp-flutter 支持的每一类
能力,用来验证「主工程零改动」与各能力的真实用法。**不需要为了适配
mp-flutter 修改任何页面代码**——除了引入依赖、加一份 `mp_flutter.yaml`。

| tab | 覆盖能力 | 对应文件 |
|---|---|---|
| 触摸/滚动 | `ListView` 滚动 + `GestureDetector` 点击反馈 | `lib/pages/touch_scroll_page.dart` |
| 文本输入 | 多个 `TextField`(焦点切换、提交清空、多行) | `lib/pages/text_input_page.dart` |
| 网络/存储 | `package:http` GET、`shared_preferences` 读写、`Image.network` | `lib/pages/network_page.dart` |
| 微信能力 | `package:mp_flutter_wechat`(登录/支付/扫码/剪贴板/定位/分享/胶囊按钮) | `lib/pages/wechat_page.dart` |
| 原生组件 | `package:mp_flutter_native` 的 `MpVideo`/`MpMap` | `lib/pages/native_page.dart` |

## 在普通浏览器里跑(验证零改动 + fallback)

```bash
flutter run -d chrome
```

「微信能力」「原生组件」两个 tab 在普通浏览器里会显示"仅小程序可用"/
fallback 占位,而不是报错崩溃——这是设计如此,不是 bug。「网络/存储」
tab 的 HTTP 请求走真实浏览器网络,请求外网可能因 CORS 失败,同样应该
优雅显示失败原因而不是卡住。

## 编译成微信小程序

```bash
dart run flutter_miniprogram
```

(`flutter_miniprogram`——主包目录仍是 `packages/mp_flutter`——以 dev_dependency +
path 引入,见 `pubspec.yaml`;配置见 `mp_flutter.yaml`。产物默认落在
`build/weapp`,用微信开发者工具直接打开。)

先跑一次自检,确认本机工具链(Node/esbuild/flutter/brotli)齐备:

```bash
dart run flutter_miniprogram doctor
```

## 已知限制(在本示例里如何体现)

- **无磁盘缓存的网络图片**:「网络/存储」tab 的 `Image.network` 只有内存缓存,
  重启小程序会重新下载。
- **真机合法域名**:HTTP 请求与网络图片在真机上都要求域名已加入小程序后台
  的合法域名列表;`touristappid`(本示例默认 appid)加不了域名,所以真机上
  这两处大概率会走到失败/fallback 分支——这是预期行为,页面已按“优雅降级”
  处理(见 `network_page.dart` 的注释),不代表 bug。开发者工具默认不校验
  域名,通常能正常演示。
- **`cacheWidth`/`cacheHeight`/`toByteData()` 暂不支持**:本示例没有用到这两个
  API,如果你在自己的工程里用到,请先看仓库根 README「网络与存储」一节。
- **原生组件总在最上层**:「原生组件」tab 特意没有在 `MpVideo`/`MpMap` 上叠加
  任何浮层——控制按钮都放在组件区域之外。

## 测试

```bash
flutter test
```

`test/widget_test.dart` 是一个 widget 冒烟测试:依次切到 5 个 tab,断言各自
的特征 widget 都渲染出来了。测试跑在 Dart VM 上(`flutter test` 默认目标),
`mp_flutter_wechat`/`mp_flutter_native` 都会选中各自的 stub 实现——所以
「微信能力」「原生能力」两个 tab 在测试里也会走"仅小程序可用"分支,与真实
断言一致。测试不触发真实网络/本地存储调用(那些操作都由按钮触发)。
