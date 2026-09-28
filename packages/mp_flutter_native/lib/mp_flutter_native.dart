/// 在 mp-flutter 编译的微信小程序里,把 [MpVideo]/[MpMap]/[MpCamera] 接到
/// 原生 `<video>`/`<map>`/`<camera>` 组件(Task 2 的 JS 同步层
/// `self.__mpNative`);非小程序环境(含普通浏览器、Android/iOS/桌面)下渲染
/// 各自的 `fallback`。
///
/// ★ 原生组件在小程序里总是叠在所有 Flutter 内容之上——Flutter 树里想盖在
/// 这些 widget 上面的内容,实际会被原生组件遮住,而不是相反。真机/mp-flutter
/// 编译产物里布局时要留意这一点。
library;

export 'src/camera.dart';
export 'src/map.dart';
export 'src/mp_native_view.dart' show mpNativeAvailable;
export 'src/video.dart';
