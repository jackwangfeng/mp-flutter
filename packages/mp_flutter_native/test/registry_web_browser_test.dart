@TestOn('browser')
library;

// 只跑在浏览器平台(`dart test -p chrome`):覆盖修复轮 1(评审 Important)
// 的问题——JS 工厂在创建 div 的那一刻就会 `register(id)`/push 到
// `__mpNativePending`,但 `MpNativeView` 的 State 只有等 `onPlatformViewCreated`
// 回调才知道 `viewId`;`IndexedStack`/Tab 快速切换等场景下,State 完全可能在
// 这个空档期(工厂已经跑过,回调还没来)就被 dispose——如果 dispose 只在
// "已经知道 viewId"时才处理注销,这个 id 就会被永远漏掉,让 Task 2 的同步
// 循环白跑。
//
// 这里不通过真实的 `HtmlElementView`/Flutter 平台视图合成流程触发工厂
// (那需要一整套 flutter test 的浏览器渲染管线,不是 `dart test -p chrome`
// 能做的),而是用 `debugSimulateNativeFactoryRun`——它绕开
// `ui_web.platformViewRegistry` 的真实分发,直接调用工厂本体那段逻辑,只为
// 单测 `_WebBackend` 自己的 token→viewId 登记/撤销这部分状态机,不依赖
// Flutter 引擎的渲染时序。
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:mp_flutter_native/src/mp_native_view.dart';
import 'package:mp_flutter_native/src/registry_web.dart';
import 'package:test/test.dart';

@JS('__mpNative')
external set _installedBridge(JSObject? v);

/// 装一个假桥,记录 `register`/`unregister` 被调用的 id,供断言。
JSObject _installSpyBridge({
  required void Function(String id) onRegister,
  required void Function(String id) onUnregister,
}) {
  final bridge = JSObject();
  bridge['register'] = ((JSString id) => onRegister(id.toDart)).toJS;
  bridge['unregister'] = ((JSString id) => onUnregister(id.toDart)).toJS;
  _installedBridge = bridge;
  return bridge;
}

void main() {
  tearDown(() {
    _installedBridge = null;
    // 清掉可能残留的 `__mpNativePending`,不让一个测试的状态漏进下一个。
    final g = globalContext;
    if (g.has('__mpNativePending')) g.delete('__mpNativePending'.toJS);
  });

  group('有桥(self.__mpNative 已存在)', () {
    test('正常时序:工厂跑过之后 cancelRequest 调 unregister', () {
      final registered = <String>[];
      final unregistered = <String>[];
      _installSpyBridge(
          onRegister: registered.add, onUnregister: unregistered.add);

      final backend = createNativeBackend();
      final token = backend.createRequestToken();
      final viewId = debugSimulateNativeFactoryRun(
          backend, MpNativeKind.video, token, '{}');

      expect(registered, [viewId.toString()]);
      backend.cancelRequest(token);
      expect(unregistered, [viewId.toString()]);
    });

    test('★ 竞态:dispose 早于工厂跑起来(onPlatformViewCreated 之前)时,'
        '工厂真正跑起来后要原地撤销,不能落地成"注册了没人管"的 id', () {
      final registered = <String>[];
      final unregistered = <String>[];
      _installSpyBridge(
          onRegister: registered.add, onUnregister: unregistered.add);

      final backend = createNativeBackend();
      final token = backend.createRequestToken();

      // dispose 先到——这一刻工厂还没跑过,`_viewIdByToken` 里还查不到。
      backend.cancelRequest(token);

      // 工厂之后才跑起来(模拟"onPlatformViewCreated 回调姗姗来迟"这个
      // 时序;真实场景里这一步会真的把 register() 发出去,除非
      // cancelRequest 已经把这个 token 记成"作废")。
      final viewId = debugSimulateNativeFactoryRun(
          backend, MpNativeKind.video, token, '{}');

      // 关键断言:既然这次创建请求在工厂跑起来之前就已经被撤销,工厂就不
      // 应该把它当成正常注册处理(`register` 不该被调用),但要保证
      // `unregister` 这条防御性调用发生了——不留下"注册了没人管"的悬空
      // id(哪怕 JS 侧对一个从没 register 过的 id 调 unregister 也是安全的
      // 空操作,见 Task 2 `unregister(id)` 的实现)。
      expect(registered, isEmpty, reason: '已经撤销的请求不该再走正常注册路径');
      expect(unregistered, [viewId.toString()]);
    });
  });

  group('没有桥(self.__mpNative 尚未挂上去,走 __mpNativePending)', () {
    List<String> pendingIds() {
      final g = globalContext;
      if (!g.has('__mpNativePending')) return const [];
      final arr = g['__mpNativePending'];
      if (arr == null) return const [];
      return (arr as JSArray<JSString>).toDart.map((e) => e.toDart).toList();
    }

    test('正常时序:工厂跑过之后 cancelRequest 把 id 从 pending 里摘掉', () {
      final backend = createNativeBackend();
      final token = backend.createRequestToken();
      final viewId = debugSimulateNativeFactoryRun(
          backend, MpNativeKind.map, token, '{}');

      expect(pendingIds(), contains(viewId.toString()));
      backend.cancelRequest(token);
      expect(pendingIds(), isNot(contains(viewId.toString())));
    });

    test('★ 竞态:dispose 早于工厂跑起来时,工厂真正跑起来后不应该把 id '
        '真的落进 __mpNativePending(不然就是一个永远没人 unregister 的 id)',
        () {
      final backend = createNativeBackend();
      final token = backend.createRequestToken();

      backend.cancelRequest(token); // dispose 先到,工厂还没跑过。
      final viewId = debugSimulateNativeFactoryRun(
          backend, MpNativeKind.map, token, '{}');

      expect(pendingIds(), isNot(contains(viewId.toString())));
    });
  });
}
