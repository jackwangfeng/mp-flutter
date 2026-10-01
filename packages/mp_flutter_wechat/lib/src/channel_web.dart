import 'dart:js_interop';

import 'channel.dart';
import 'models.dart';

@JS('__mpWechat')
external _Bridge? get _bridge;

extension type _Bridge._(JSObject _) implements JSObject {
  external JSNumber? get version;
  @JS('call')
  external JSPromise<JSString> callApi(JSString api, JSString paramsJson);
  external void setShareInfo(JSString json);
  // 旧版桥(没有该方法)时读到 undefined,调用前先判断
  @JS('menuButtonRect')
  external JSFunction? get menuButtonRectFn;
  @JS('menuButtonRect')
  external JSString? menuButtonRect();
}

/// 对应 `wechat.js` 里 `fail()` 构造的 `Error`:除标准 `message` 外,
/// 还挂了 `mpApi`/`mpErrMsg`/`mpCancelled` 三个自定义属性。
extension type _BridgeError._(JSObject _) implements JSObject {
  external JSString? get mpApi;
  external JSString? get mpErrMsg;
  external JSBoolean? get mpCancelled;
  external JSString? get message;
}

/// Web 平台:在 mp-flutter 编译的小程序里,垫片(boot.js)把桥挂在
/// `self.__mpWechat`;普通浏览器里没有这个全局,`isAvailable` 为 false。
MpWechatChannel createPlatformChannel() => _WebChannel();

class _WebChannel implements MpWechatChannel {
  @override
  bool get isAvailable => _bridge != null;

  @override
  Future<String> call(String api, String paramsJson) async {
    final b = _bridge;
    if (b == null) {
      throw UnsupportedError(
        'mp_flutter_wechat: $api 仅在 mp-flutter 编译的微信小程序中可用',
      );
    }
    try {
      return (await b.callApi(api.toJS, paramsJson.toJS).toDart).toDart;
    } catch (e) {
      // 观测(Task 3 E2E,accept-wx.js 的 pay 步骤,微信开发者工具 + dart2js
      // 编译产物):JSPromise reject 的 JS Error 原样落到这里的 `catch`,
      // `e is JSObject` 成立——实测 `STATE|pay=ERR MpWechatException
      // (requestPayment): requestPayment:fail no permission, appId=...`,
      // 即映射按预期生效,未观测到需要改走
      // `JSPromise.then(onFulfilled, onRejected)` 手工接收原始 reject 值的情况。
      //
      // 但 extension-type 的 cast(`e as _BridgeError`)是无检查的:任何
      // JSObject 都能转成 `_BridgeError` 且不报错,只是访问不到的字段拿到
      // null——不加判断的话,会把"任意 JS reject 值"（哪怕不是 wechat.js 的
      // fail() 构造的错误）都映射成 MpWechatException,掩盖真正的 bug。
      // 只在确实带有 `mpErrMsg`/`mpApi`(即真的来自 fail())时才映射,
      // 否则原样 rethrow,交给调用方看到真实的错误类型。
      if (e is JSObject) {
        final err = e as _BridgeError;
        if (err.mpErrMsg != null || err.mpApi != null) {
          final msg =
              err.mpErrMsg?.toDart ?? err.message?.toDart ?? e.toString();
          throw MpWechatException(
            api: err.mpApi?.toDart ?? api,
            errMsg: msg,
            cancelled: err.mpCancelled?.toDart ?? false,
          );
        }
      }
      rethrow;
    }
  }

  @override
  void setShareInfo(String json) => _bridge?.setShareInfo(json.toJS);

  @override
  Future<String?> menuButtonRect() async {
    final b = _bridge;
    if (b == null || b.menuButtonRectFn == null) return null;
    return b.menuButtonRect()?.toDart;
  }
}
