import 'channel.dart';

/// 非 Web 平台(Android/iOS/桌面):没有小程序环境,任何调用都明确报错。
MpWechatChannel createPlatformChannel() => _StubChannel();

class _StubChannel implements MpWechatChannel {
  @override
  bool get isAvailable => false;

  @override
  Future<String> call(String api, String paramsJson) => throw UnsupportedError(
      'mp_flutter_wechat: $api 仅在 mp-flutter 编译的微信小程序中可用');

  @override
  void setShareInfo(String json) {}

  @override
  Future<String?> menuButtonRect() async => null;
}
