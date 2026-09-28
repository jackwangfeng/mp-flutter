/// 在 mp-flutter 编译的微信小程序中调用微信登录、支付等能力。
///
/// 敏感操作必须在你的服务端完成:
/// - `login()` 只返回 code;用 code 换 openid/session_key 须服务端调用
///   `code2Session`(需要 AppSecret)
/// - `requestPayment()` 的参数来自服务端"统一下单"并签名(需要商户密钥)
library;

import 'dart:convert';
import 'dart:ui' show Rect;

import 'src/channel.dart';
import 'src/models.dart';
import 'src/channel_stub.dart' if (dart.library.js_interop) 'src/channel_web.dart';

export 'src/channel.dart' show MpWechatChannel;
export 'src/models.dart';

/// 微信小程序能力的统一入口。全部为静态方法,内部持有平台通道单例。
class MpWechat {
  MpWechat._();

  static MpWechatChannel? _override;
  static final MpWechatChannel _platform = createPlatformChannel();
  static MpWechatChannel get _ch => _override ?? _platform;

  /// 仅测试用:注入假通道以驱动 API;传 `null` 恢复平台通道。
  /// 方法名以 `debug` 开头,不引入 `package:meta` 依赖。
  static void debugSetChannel(MpWechatChannel? channel) => _override = channel;

  /// 当前平台/环境下微信能力是否可用(即是否存在 `self.__mpWechat` 桥)。
  static bool get isAvailable => _ch.isAvailable;

  /// 调用任意微信小程序 API 的通用入口;不可用时抛 [UnsupportedError],
  /// 失败(含用户取消)时抛 [MpWechatException]。
  static Future<Map<String, Object?>> call(
    String api, [
    Map<String, Object?> params = const {},
  ]) async {
    if (!_ch.isAvailable) {
      throw UnsupportedError(
          'mp_flutter_wechat: $api 仅在 mp-flutter 编译的微信小程序中可用');
    }
    final raw = await _ch.call(api, jsonEncode(params));
    return (jsonDecode(raw) as Map).cast<String, Object?>();
  }

  /// `wx.login`;返回可换取 openid/session_key 的 code(须服务端完成)。
  /// 成功回调却没有 `code` 字段时,视为异常(不是 empty-string 的正常返回)。
  static Future<String> login() async {
    final code = (await call('login'))['code'] as String?;
    if (code == null) {
      throw const MpWechatException(
          api: 'login', errMsg: 'login 成功回调未返回 code', cancelled: false);
    }
    return code;
  }

  /// `wx.checkSession`;登录态是否仍然有效。失败(含不可用)返回 false,不抛。
  static Future<bool> checkSession() async {
    if (!_ch.isAvailable) return false;
    try {
      await call('checkSession');
      return true;
    } on MpWechatException {
      return false;
    }
  }

  /// `wx.requestPayment`;[params] 来自服务端统一下单签名结果。
  static Future<void> requestPayment(MpPaymentParams params) async {
    await call('requestPayment', params.toJson());
  }

  /// `wx.chooseAddress`;拉起微信收货地址选择器。
  static Future<MpAddress> chooseAddress() async =>
      MpAddress.fromJson(await call('chooseAddress'));

  /// `wx.scanCode`;拉起扫码。
  static Future<MpScanResult> scanCode({bool onlyFromCamera = false}) async =>
      MpScanResult.fromJson(await call('scanCode', {'onlyFromCamera': onlyFromCamera}));

  /// `wx.setClipboardData`。
  static Future<void> setClipboardData(String data) async {
    await call('setClipboardData', {'data': data});
  }

  /// `wx.getClipboardData`。
  static Future<String> getClipboardData() async =>
      (await call('getClipboardData'))['data'] as String? ?? '';

  /// `wx.getLocation`;[type] 为坐标系,默认 `gcj02`。
  static Future<MpLocation> getLocation({String type = 'gcj02'}) async =>
      MpLocation.fromJson(await call('getLocation', {'type': type}));

  /// `wx.makePhoneCall`。
  static Future<void> makePhoneCall(String phoneNumber) async {
    await call('makePhoneCall', {'phoneNumber': phoneNumber});
  }

  /// 胶囊按钮(右上角"··· ◎")的位置与大小,来自 `wx.getMenuButtonBoundingClientRect`,
  /// 单位是 Flutter 逻辑像素(与 MediaQuery 同一坐标系)。非小程序环境(或基础库
  /// 拿不到)返回 null。
  ///
  /// mp-flutter 把安全区(状态栏/刘海、Home 指示条)注入了 `MediaQuery.padding`,
  /// `SafeArea` 直接可用;但胶囊按钮**不算**进 padding(与原生 App 一致)。页面顶部
  /// 右侧要放按钮/文字又不想被胶囊盖住时,用这个矩形自己让位,例如
  /// `EdgeInsets.only(right: MediaQuery.sizeOf(context).width - rect.left + 8)`。
  static Future<Rect?> menuButtonRect() async {
    if (!_ch.isAvailable) return null;
    final raw = await _ch.menuButtonRect();
    if (raw == null || raw.isEmpty) return null;
    try {
      final m = (jsonDecode(raw) as Map).cast<String, Object?>();
      final l = (m['left'] as num?)?.toDouble();
      final t = (m['top'] as num?)?.toDouble();
      final r = (m['right'] as num?)?.toDouble();
      final b = (m['bottom'] as num?)?.toDouble();
      if (l == null || t == null || r == null || b == null) return null;
      return Rect.fromLTRB(l, t, r, b);
    } on FormatException {
      return null;
    }
  }

  /// 设置承载页 `onShareAppMessage` 使用的分享信息;不可用时空操作。
  /// 只传已设置(非 null)的字段;每次调用整体替换,不按字段合并。
  /// [path] 传入且不以 `/` 开头(小程序页面路径要求)时抛 [ArgumentError]。
  static void setShareInfo({String? title, String? path, String? imageUrl, String? query}) {
    if (path != null && !path.startsWith('/')) {
      throw ArgumentError.value(path, 'path', '分享路径必须以 / 开头(小程序页面路径)');
    }
    if (!_ch.isAvailable) return;
    _ch.setShareInfo(jsonEncode({
      if (title != null) 'title': title,
      if (path != null) 'path': path,
      if (imageUrl != null) 'imageUrl': imageUrl,
      if (query != null) 'query': query,
    }));
  }
}
