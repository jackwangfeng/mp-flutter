/// `wx.requestPayment` 所需参数;均来自业务服务端"统一下单"接口的签名结果,
/// 客户端不应也无法自行生成。
class MpPaymentParams {
  /// 时间戳(秒),服务端签名时生成。
  final String timeStamp;

  /// 随机字符串,服务端签名时生成。
  final String nonceStr;

  /// 统一下单接口返回的 `prepay_id`,格式形如 `prepay_id=xxx`。
  final String package;

  /// 签名方式,如 `MD5`/`HMAC-SHA256`。
  final String signType;

  /// 签名,服务端用商户密钥对上述字段计算得到。
  final String paySign;

  /// 构造支付参数;所有字段均为必填,直接取服务端返回值即可。
  const MpPaymentParams({
    required this.timeStamp,
    required this.nonceStr,
    required this.package,
    required this.signType,
    required this.paySign,
  });

  /// 从 JSON map 构造(缺失字段按空字符串兜底)。
  factory MpPaymentParams.fromJson(Map<String, Object?> json) =>
      MpPaymentParams(
        timeStamp: json['timeStamp'] as String? ?? '',
        nonceStr: json['nonceStr'] as String? ?? '',
        package: json['package'] as String? ?? '',
        signType: json['signType'] as String? ?? '',
        paySign: json['paySign'] as String? ?? '',
      );

  /// 转成 `wx.requestPayment` 需要的 JSON map。
  Map<String, Object?> toJson() => {
    'timeStamp': timeStamp,
    'nonceStr': nonceStr,
    'package': package,
    'signType': signType,
    'paySign': paySign,
  };
}

/// `wx.chooseAddress` 返回的收货地址。
class MpAddress {
  /// 收货人姓名。
  final String userName;

  /// 邮政编码。
  final String postalCode;

  /// 省份名称,如 `广东省`。
  final String provinceName;

  /// 城市名称,如 `深圳市`。
  final String cityName;

  /// 区/县名称。
  final String countyName;

  /// 详细收货地址(街道门牌号等)。
  final String detailInfo;

  /// 国家代码,如 `CN`。
  final String nationalCode;

  /// 收货人手机号/电话号码。
  final String telNumber;

  /// 构造一个地址;各字段均对应 `wx.chooseAddress` 成功回调里的同名字段。
  const MpAddress({
    required this.userName,
    required this.postalCode,
    required this.provinceName,
    required this.cityName,
    required this.countyName,
    required this.detailInfo,
    required this.nationalCode,
    required this.telNumber,
  });

  /// 从 JSON map 构造(缺失字段按空字符串兜底)。
  factory MpAddress.fromJson(Map<String, Object?> json) => MpAddress(
    userName: json['userName'] as String? ?? '',
    postalCode: json['postalCode'] as String? ?? '',
    provinceName: json['provinceName'] as String? ?? '',
    cityName: json['cityName'] as String? ?? '',
    countyName: json['countyName'] as String? ?? '',
    detailInfo: json['detailInfo'] as String? ?? '',
    nationalCode: json['nationalCode'] as String? ?? '',
    telNumber: json['telNumber'] as String? ?? '',
  );
}

/// `wx.scanCode` 返回的扫码结果。
class MpScanResult {
  /// 扫码内容。
  final String result;

  /// 条码类型,如 `QR_CODE`/`EAN_13`。
  final String scanType;

  /// 条码文字编码,如 `UTF-8`。
  final String charSet;

  /// 二维码携带的小程序页面路径(若有)。
  final String path;

  /// 构造一个扫码结果;各字段对应 `wx.scanCode` 成功回调里的同名字段。
  const MpScanResult({
    required this.result,
    required this.scanType,
    required this.charSet,
    required this.path,
  });

  /// 从 JSON map 构造(缺失字段按空字符串兜底)。
  factory MpScanResult.fromJson(Map<String, Object?> json) => MpScanResult(
    result: json['result'] as String? ?? '',
    scanType: json['scanType'] as String? ?? '',
    charSet: json['charSet'] as String? ?? '',
    path: json['path'] as String? ?? '',
  );
}

/// `wx.getLocation` 返回的位置信息。
class MpLocation {
  /// 纬度,坐标系由调用 `getLocation` 时的 `type` 参数决定(默认 `gcj02`)。
  final double latitude;

  /// 经度,坐标系同上。
  final double longitude;

  /// 速度,单位 m/s。
  final double speed;

  /// 位置精度,单位米。
  final double accuracy;

  /// 构造一个位置;各字段对应 `wx.getLocation` 成功回调里的同名字段。
  const MpLocation({
    required this.latitude,
    required this.longitude,
    required this.speed,
    required this.accuracy,
  });

  /// 从 JSON map 构造(缺失字段按 0 兜底)。
  factory MpLocation.fromJson(Map<String, Object?> json) => MpLocation(
    latitude: (json['latitude'] as num?)?.toDouble() ?? 0,
    longitude: (json['longitude'] as num?)?.toDouble() ?? 0,
    speed: (json['speed'] as num?)?.toDouble() ?? 0,
    accuracy: (json['accuracy'] as num?)?.toDouble() ?? 0,
  );
}

/// 微信小程序 API 调用失败(含用户取消)时抛出的异常。
///
/// 对应 JS 桥(`wechat.js`)reject 的 `Error`,其 `mpApi`/`mpErrMsg`/`mpCancelled`
/// 属性经 `channel_web.dart` 映射到这里。
class MpWechatException implements Exception {
  /// 触发失败的 API 名称,如 `requestPayment`。
  final String api;

  /// 微信侧原始错误信息,如 `requestPayment:fail cancel`。
  final String errMsg;

  /// 是否为用户主动取消(`errMsg` 含 `cancel`)。
  final bool cancelled;

  const MpWechatException({
    required this.api,
    required this.errMsg,
    required this.cancelled,
  });

  @override
  String toString() =>
      'MpWechatException($api${cancelled ? ', 用户取消' : ''}): $errMsg';
}
