@TestOn('browser')
library;

// 只跑在浏览器平台(`flutter test --platform chrome`):这里直接操练 channel_web.dart 里
// `_WebChannel.call` 的 `catch (e)` 分支,不经 debugSetChannel 的 FakeChannel——
// 那条路径绕过了真实的 dart:js_interop 转换,测不到 Task 2 review 提出的问题:
// `e as _BridgeError` 是无检查的 extension-type cast,任何 JSObject 都能转成
// 功,必须靠"是否带 mpErrMsg/mpApi"这个运行时判断才能不误判。
//
// 用真实的 `Promise`(而不是 `Future.toJS`)构造 reject 值:后者会把 reject 原因
// 装箱进一个新建 `Error` 的 `error`/`stack` 属性(见 dart:js_interop 源码
// `FutureOfJSAnyToJSPromise.toJS`),丢失顶层 mpErrMsg/mpApi——那不是 wechat.js
// 实际构造错误的形状(它直接在 `new Error()` 上挂 mpApi/mpErrMsg/mpCancelled)。
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:ui' show Rect;

import 'package:mp_flutter_wechat/mp_flutter_wechat.dart';
import 'package:test/test.dart';

@JS('__mpWechat')
external set _installedBridge(JSObject? v);

JSPromise<JSString> _rejectWith(JSObject error) {
  return JSPromise<JSString>(
    ((JSFunction resolve, JSFunction reject) {
      reject.callAsFunction(reject, error);
    }).toJS,
  );
}

/// 安装一个假桥:`call` 恒 reject,`errorFactory` 决定 reject 的对象长什么样。
void _installBridge(JSObject Function() errorFactory) {
  final bridge = JSObject();
  JSPromise<JSString> call(JSString api, JSString paramsJson) =>
      _rejectWith(errorFactory());
  bridge['call'] = call.toJS;
  bridge['setShareInfo'] = ((JSString _) {}).toJS;
  _installedBridge = bridge;
}

void main() {
  tearDown(() {
    _installedBridge = null;
    MpWechat.debugSetChannel(null);
  });

  test('reject 对象带 mpErrMsg/mpApi 时映射为 MpWechatException(观测:真机/开发者工具的 '
      'wechat.js 就是这样构造错误的,见 accept-wx.js 的 pay 步骤)', () async {
    _installBridge(() {
      final e = JSObject();
      e['mpApi'] = 'requestPayment'.toJS;
      e['mpErrMsg'] = 'requestPayment:fail no permission, appId=x'.toJS;
      e['mpCancelled'] = false.toJS;
      e['message'] = 'requestPayment: requestPayment:fail no permission, appId=x'.toJS;
      return e;
    });
    expect(MpWechat.isAvailable, isTrue);
    await expectLater(
      MpWechat.requestPayment(
          const MpPaymentParams(timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'RSA', paySign: 's')),
      throwsA(isA<MpWechatException>()
          .having((e) => e.api, 'api', 'requestPayment')
          .having((e) => e.errMsg, 'errMsg', 'requestPayment:fail no permission, appId=x')
          .having((e) => e.cancelled, 'cancelled', isFalse)),
    );
  });

  test('reject 对象不带 mpErrMsg/mpApi 时原样 rethrow,不误判成 MpWechatException '
      '(不能靠 extension-type 的 e as _BridgeError 无检查 cast 兜底)', () async {
    _installBridge(() {
      final e = JSObject();
      e['message'] = '普通 JS 错误,不是 wechat.js 的 fail()'.toJS;
      return e;
    });
    Object? caught;
    try {
      await MpWechat.requestPayment(
          const MpPaymentParams(timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'RSA', paySign: 's'));
      fail('应该抛出错误');
    } catch (e) {
      caught = e;
    }
    expect(caught, isNot(isA<MpWechatException>()));
    expect(caught, isA<JSObject>());
    expect((caught as JSObject)['message'], isNotNull);
  });

  test('menuButtonRect:经真实 js_interop 读桥上的同步方法;旧版桥没有该方法时返回 null', () async {
    _installBridge(() => JSObject());
    expect(await MpWechat.menuButtonRect(), isNull, reason: '旧版桥(无 menuButtonRect)');
    final bridge = JSObject();
    bridge['call'] = ((JSString a, JSString b) => _rejectWith(JSObject())).toJS;
    bridge['setShareInfo'] = ((JSString _) {}).toJS;
    bridge['menuButtonRect'] = (() =>
        '{"left":281,"top":51,"right":368,"bottom":83,"width":87,"height":32}'.toJS).toJS;
    _installedBridge = bridge;
    expect(await MpWechat.menuButtonRect(), const Rect.fromLTRB(281, 51, 368, 83));
    bridge['menuButtonRect'] = (() => null).toJS;
    expect(await MpWechat.menuButtonRect(), isNull);
  });
}
