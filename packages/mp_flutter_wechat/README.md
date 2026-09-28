# mp_flutter_wechat

在 [mp-flutter](../mp_flutter) 编译的微信小程序里调用微信登录、支付等原生能力;
在其它平台(Android/iOS/桌面,或普通浏览器)上调用会明确报错,而不是静默失败。

## 引入方式

尚未发布到 pub.dev。用 git 依赖引入本仓库(公开仓库,无需额外凭证;`ref`
建议固定到一个发布 tag,例如 `v0.2.1`,而不是 `main`):

```yaml
dependencies:
  mp_flutter_wechat:
    git:
      url: https://github.com/jackwangfeng/mp-flutter.git
      path: packages/mp_flutter_wechat
      ref: v0.2.1
```

在 mp-flutter 仓库内部开发(monorepo 内的 `example/` 等)时,用相对路径的
path 依赖即可,不需要走 git:

```yaml
dependencies:
  mp_flutter_wechat:
    path: ../mp_flutter/packages/mp_flutter_wechat
```

## API

| 方法 | 对应微信 API | 说明 |
|---|---|---|
| `MpWechat.isAvailable` | — | 当前环境是否存在微信桥(`self.__mpWechat`) |
| `MpWechat.login()` | `wx.login` | 返回 `code`;换 `openid`/`session_key` 须服务端调用 `code2Session` |
| `MpWechat.checkSession()` | `wx.checkSession` | 登录态是否仍有效;失败返回 `false`,不抛异常 |
| `MpWechat.requestPayment(params)` | `wx.requestPayment` | `params` 来自服务端"统一下单"签名结果 |
| `MpWechat.chooseAddress()` | `wx.chooseAddress` | 拉起收货地址选择器 |
| `MpWechat.scanCode({onlyFromCamera})` | `wx.scanCode` | 拉起扫码 |
| `MpWechat.setClipboardData(data)` | `wx.setClipboardData` | 写剪贴板 |
| `MpWechat.getClipboardData()` | `wx.getClipboardData` | 读剪贴板 |
| `MpWechat.getLocation({type})` | `wx.getLocation` | 默认坐标系 `gcj02` |
| `MpWechat.makePhoneCall(phoneNumber)` | `wx.makePhoneCall` | 拨打电话 |
| `MpWechat.setShareInfo({title, path, imageUrl, query})` | — | 设置承载页 `onShareAppMessage` 使用的分享信息 |
| `MpWechat.menuButtonRect()` | `wx.getMenuButtonBoundingClientRect` | 胶囊按钮的位置,`Future<Rect?>`(逻辑像素);非小程序环境返回 `null`,见下文「避开胶囊按钮」 |
| `MpWechat.call(api, [params])` | 任意 `wx.*` | 通用入口,覆盖表里没有单独封装的接口;仅支持 success/fail 回调式异步接口——同步接口(`*Sync`)、事件订阅(`on*`/`off*`)、工厂/句柄(`create*`、`*Manager`)会立即报错,不会挂起 |

非小程序平台(stub)或 Web 上没有 `__mpWechat` 桥时:

- `isAvailable` 为 `false`
- `checkSession()` 返回 `false`(不抛)
- `setShareInfo(...)` 为空操作(不抛)
- 其余方法(含 `call`)抛 `UnsupportedError('mp_flutter_wechat: <api> 仅在 mp-flutter 编译的微信小程序中可用')`

## 服务端职责(敏感操作)

以下操作需要 `AppSecret` 或商户密钥,**绝不能**放在客户端,必须由业务服务端完成:

- **`code2Session`**(微信官方文档:`auth.code2Session`):用 `login()` 返回的 `code`
  换取 `openid`/`unionid`/`session_key`。
- **统一下单 + 签名**(微信支付官方文档:`统一下单 API` + `小程序调起支付 API` 的签名规则):
  生成 `requestPayment()` 所需的 `timeStamp`/`nonceStr`/`package`/`signType`/`paySign`。

## 用户取消的处理

失败(含用户取消)会抛出 `MpWechatException`,其 `cancelled` 字段区分"用户主动取消"
与其它失败:

```dart
try {
  await MpWechat.requestPayment(params);
} on MpWechatException catch (e) {
  if (e.cancelled) {
    // 用户取消支付,静默返回即可
  } else {
    // 真正失败:e.api / e.errMsg 里有细节
    showToast(e.errMsg);
  }
}
```

## 非小程序平台行为

在 Android/iOS/桌面(走 `channel_stub.dart`)或普通浏览器(Web 上没有
`self.__mpWechat`,走 `channel_web.dart` 但 `isAvailable` 为 `false`)上,
先判断 `MpWechat.isAvailable` 再决定是否展示微信相关入口,避免调用抛出
`UnsupportedError`:

```dart
if (MpWechat.isAvailable) {
  final code = await MpWechat.login();
  // ...
}
```

## 避开胶囊按钮

mp-flutter 生成的页面是全屏画布(`navigationStyle: custom`),构建时会把小程序
安全区(状态栏/刘海、底部 Home 指示条)注入 `MediaQuery.padding`/`viewPadding`,
所以 `SafeArea`、`Scaffold`、`AppBar` 不用改就会让开内容。但右上角的**胶囊按钮
不算进 padding**(和原生 App 一样,padding 只描述系统占用的区域)。

页面顶部右侧想放按钮/文字又不想被胶囊盖住时,用 `MpWechat.menuButtonRect()`
取胶囊矩形自己让位:

```dart
final rect = await MpWechat.menuButtonRect(); // 非小程序环境为 null
final width = MediaQuery.sizeOf(context).width;
final rightGap = rect == null ? 16.0 : width - rect.left + 8; // 胶囊左边再留 8
Padding(padding: EdgeInsets.only(right: rightGap), child: header);
```

## 分享设置示例

每次 `setShareInfo` 整体替换已设置的分享信息(不是按字段合并):只传了 `title`
的下一次调用,会把之前设置过的 `path`/`imageUrl`/`query` 一并清空,承载页的
`onShareAppMessage` 只会看到这一次调用里传的字段。`path` 若传入且不以 `/`
开头,会在 Dart 侧立即抛出 `ArgumentError`(小程序页面路径必须以 `/` 开头)。

```dart
MpWechat.setShareInfo(
  title: '限时特惠',
  path: '/pages/flutter/flutter?sku=1',
  imageUrl: 'https://example.com/share.png',
);
```

## 实现说明:Web 平台的异常映射

`lib/src/channel_web.dart` 里,JS 桥(`wechat.js`)reject 时抛出的 `Error` 带有
`mpApi`/`mpErrMsg`/`mpCancelled` 三个自定义属性。**实测结论**(微信开发者工具 +
dart2js 编译产物,accept-wx.js 的 pay 步骤):dart2js 把 JS reject 的 `Error`
原样交给 Dart 的 `catch`,`e is JSObject` 成立,不需要改走
`JSPromise.then(onFulfilled, onRejected)` 手工接收原始 reject 值。

即便如此,`catch` 里仍只在确实带有 `mpErrMsg`/`mpApi`(即真的来自 `wechat.js`
的 `fail()`)时才映射成 `MpWechatException`,否则原样 `rethrow`——extension-type
的 cast 是无检查的,任何 `JSObject` 都能转成 `_BridgeError` 且不报错,只是取
不到的字段为 `null`;不加这道判断会把"任意 JS reject 值"都当成
`MpWechatException`,掩盖真正的 bug。
