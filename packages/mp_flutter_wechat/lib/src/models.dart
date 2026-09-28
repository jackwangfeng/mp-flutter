/// `wx.requestPayment` 所需参数;均来自业务服务端"统一下单"接口的签名结果,
/// 客户端不应也无法自行生成。
class MpPaymentParams {
  final String timeStamp;
  final String nonceStr;
  final String package;
  final String signType;
  final String paySign;

  const MpPaymentParams({
    required this.timeStamp,
    required this.nonceStr,
    required this.package,
    required this.signType,
    required this.paySign,
  });

  factory MpPaymentParams.fromJson(Map<String, Object?> json) => MpPaymentParams(
        timeStamp: json['timeStamp'] as String? ?? '',
        nonceStr: json['nonceStr'] as String? ?? '',
        package: json['package'] as String? ?? '',
        signType: json['signType'] as String? ?? '',
        paySign: json['paySign'] as String? ?? '',
      );

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
  final String userName;
  final String postalCode;
  final String provinceName;
  final String cityName;
  final String countyName;
  final String detailInfo;
  final String nationalCode;
  final String telNumber;

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
  final String result;
  final String scanType;
  final String charSet;
  final String path;

  const MpScanResult({
    required this.result,
    required this.scanType,
    required this.charSet,
    required this.path,
  });

  factory MpScanResult.fromJson(Map<String, Object?> json) => MpScanResult(
        result: json['result'] as String? ?? '',
        scanType: json['scanType'] as String? ?? '',
        charSet: json['charSet'] as String? ?? '',
        path: json['path'] as String? ?? '',
      );
}

/// `wx.getLocation` 返回的位置信息。
class MpLocation {
  final double latitude;
  final double longitude;
  final double speed;
  final double accuracy;

  const MpLocation({
    required this.latitude,
    required this.longitude,
    required this.speed,
    required this.accuracy,
  });

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
  String toString() => 'MpWechatException($api${cancelled ? ', 用户取消' : ''}): $errMsg';
}
