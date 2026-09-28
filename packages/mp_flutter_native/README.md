# mp_flutter_native

在 [mp-flutter](../mp_flutter) 编译的微信小程序里,把 `MpVideo`/`MpMap`/`MpCamera`
接到原生 `<video>`/`<map>`/`<camera>` 组件(Task 2 的 JS 同步层
`self.__mpNative`,见 `packages/mp_flutter/runtime/native-views.js`);在其它平台
(Android/iOS/桌面)或普通浏览器上渲染各自的 `fallback`,控制器方法明确抛
`UnsupportedError`,而不是静默失败。

## 引入方式

尚未发布到 pub.dev。用 git 依赖引入本仓库(公开仓库,无需额外凭证;`ref`
建议固定到一个发布 tag,例如 `v0.2.0`,而不是 `main`):

```yaml
dependencies:
  mp_flutter_native:
    git:
      url: https://github.com/jackwangfeng/mp-flutter.git
      path: packages/mp_flutter_native
      ref: v0.2.0
```

在 mp-flutter 仓库内部开发(monorepo 内的 `example/` 等)时,用相对路径的
path 依赖即可,不需要走 git:

```yaml
dependencies:
  mp_flutter_native:
    path: ../mp_flutter/packages/mp_flutter_native
```

## API

```dart
MpVideo(
  src: 'https://example.com/a.mp4',
  autoplay: true,          // 优先用这个,而不是创建后立刻调用 controller.play()
  loop: false,
  muted: false,
  controls: true,
  poster: 'https://example.com/poster.png',
  objectFit: 'contain',
  controller: myVideoController,
  onPlay: () {}, onPause: () {}, onEnded: () {},
  onTimeUpdate: (seconds) {}, onError: (msg) {},
  fallback: const Text('当前平台不支持视频'),
)

MpMap(
  latitude: 31.2, longitude: 121.5, scale: 16,
  markers: [MpMapMarker(id: 1, latitude: 31.2, longitude: 121.5, title: '这里')],
  showLocation: true,
  controller: myMapController,
  onTap: (lat, lng) {}, onMarkerTap: (id) {},
  // 微信 bindregionchange 的 e.type 本身就是 'begin'/'end'(视野变化的
  // 开始/结束),这里原样转发,不吞成一个笼统的 'regionchange'。
  onRegionChange: (type) {}, // type: 'begin' | 'end'
  fallback: const Text('当前平台不支持地图'),
)

MpCamera(
  devicePosition: 'back', flash: 'auto',
  controller: myCameraController,
  onError: (msg) {},
  fallback: const Text('当前平台不支持相机'),
)

bool get mpNativeAvailable; // 仅在 mp-flutter 编译的小程序里为 true
```

控制器:

- `MpVideoController`:`play()`/`pause()`/`seek(seconds)`/`stop()`/
  `requestFullScreen()`/`exitFullScreen()`
- `MpMapController`:`moveToLocation()`/`getCenterLocation()`(返回
  `({double latitude, double longitude})`)
- `MpCameraController`:`takePhoto({quality})`(返回 `tempImagePath`)

## 非小程序平台 / 没有原生环境时的行为

先判断 `mpNativeAvailable` 再决定是否展示相关入口,避免调用控制器方法抛出
`UnsupportedError`:

- 三个 widget 都渲染 `fallback ?? const SizedBox.shrink()`。
- 控制器任意方法调用都抛
  `UnsupportedError('mp_flutter_native: 该操作仅在 mp-flutter 编译的小程序中、且对应的原生组件已创建后可用')`。

```dart
if (mpNativeAvailable) {
  await myVideoController.play();
}
```

## ★ 层级警告:原生组件总是叠在 Flutter 内容之上

小程序把原生组件作为原生视图,与 WXML 伴生层同层叠加合成,**不受 Flutter
绘制顺序影响**。如果在 Flutter 树里把别的内容(弹层背景、装饰、取景框 UI 等)
盖在 `MpVideo`/`MpMap`/`MpCamera` 上面,实际效果是那部分内容被原生组件遮住,
而不是相反。需要在原生组件之上叠加 UI 时,考虑改用小程序自己的
`cover-view`/`cover-image`(不在本包范围内),或者把交互 UI 放在原生组件区域
之外。

## 实现说明

- Web 平台(`lib/src/registry_web.dart`):首次使用某个 `MpNativeKind` 时用
  `ui_web.platformViewRegistry.registerViewFactory` 注册一个 `mp-native-<kind>`
  view type,工厂函数造 `<div data-mp-native data-mp-params data-mp-id>`——
  `data-mp-id` 就是 Flutter 引擎分配的平台视图 `viewId`(不另起计数器)。
  参数变化通过直接改写 `data-mp-params` 属性同步(`HtmlElementView` 的
  `creationParams` 只在创建那一刻生效,不会跟着 widget 重建自动更新);
  原生事件监听占位 div 上的 `CustomEvent('mpnative')`,`detail` 是 JSON 字符串
  `{type, detail}`;控制器命令经 `self.__mpNative.command(id, method, argsJson)`
  转发。
- `self.__mpNative` 可能在工厂函数执行的那一刻还不存在(`boot()` 对首帧的
  调度是异步的,真机实测过这个时序缝隙)——按 Task 2 的约定,有就
  `register(id)`,没有就把 id push 进 `self.__mpNativePending`(自动创建);
  对应视图 dispose 时调 `unregister(id)`(必须调用,否则同步层的扫描循环会
  一直跑下去)。
- 非 Web 平台(`lib/src/registry_stub.dart`):`mpNativeAvailable` 恒为
  `false`,控制器方法恒抛 `UnsupportedError`。
- `dart.library.js_interop` 条件导入在 stub/web 两份实现之间切换,镜像
  [`mp_flutter_wechat`](../mp_flutter_wechat) 的 `channel_stub.dart`/
  `channel_web.dart` 写法。`flutter test` 默认跑在 VM 上,恒定选中 stub。
