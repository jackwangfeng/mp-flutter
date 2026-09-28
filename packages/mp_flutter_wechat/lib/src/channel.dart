/// Dart 与小程序 JS 桥之间的通道。测试可注入假实现。
abstract class MpWechatChannel {
  /// 当前平台/环境下微信能力是否可用(是否存在 `self.__mpWechat` 桥)。
  bool get isAvailable;

  /// 调用一个微信小程序 API;[paramsJson] 与返回值均为 JSON 字符串。
  /// 失败时应抛出 [MpWechatException](Web 实现里由 `channel_web.dart` 完成映射)。
  Future<String> call(String api, String paramsJson);

  /// 设置承载页 `onShareAppMessage` 使用的分享信息;[json] 为 JSON 字符串。
  void setShareInfo(String json);

  /// 胶囊按钮位置(`wx.getMenuButtonBoundingClientRect`)的 JSON 字符串
  /// `{left,top,right,bottom,width,height}`;不可用时为 null。
  Future<String?> menuButtonRect();
}
