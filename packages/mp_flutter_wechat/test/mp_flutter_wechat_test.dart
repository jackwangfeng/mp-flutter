import 'dart:convert';
import 'dart:ui' show Rect;

import 'package:test/test.dart';
import 'package:mp_flutter_wechat/mp_flutter_wechat.dart';

/// 假通道:按 api 名返回预设结果(Map)或抛出预设的 [MpWechatException]。
class FakeChannel implements MpWechatChannel {
  final Map<String, Object> responses; // api → 结果 Map 或 MpWechatException
  final calls = <String, Map<String, Object?>>{};
  String? share;
  FakeChannel(this.responses);

  @override
  bool get isAvailable => true;

  @override
  Future<String> call(String api, String paramsJson) async {
    calls[api] = jsonDecode(paramsJson) as Map<String, Object?>;
    final r = responses[api];
    if (r is MpWechatException) throw r;
    return jsonEncode(r ?? {});
  }

  @override
  void setShareInfo(String json) {
    share = json;
  }

  String? menuRect;
  @override
  Future<String?> menuButtonRect() async => menuRect;
}

void main() {
  tearDown(() => MpWechat.debugSetChannel(null));

  group('非小程序平台(VM 即 stub)', () {
    test('isAvailable 为 false', () => expect(MpWechat.isAvailable, isFalse));

    test('login 抛 UnsupportedError 并说明仅小程序可用', () {
      // login() 是 async 方法:即便异常发生在第一个 await 之前,Dart 也只会把
      // 它封进返回的 Future,不会同步抛出给调用者,因此不能用
      // `expect(MpWechat.login, throwsA(...))`(那只捕获同步抛出),
      // 改用 expectLater 驱动返回的 Future——断言语义(异常类型/消息)不变。
      expect(
          MpWechat.login(),
          throwsA(isA<UnsupportedError>().having(
              (e) => e.message, 'message', contains('仅在 mp-flutter 编译的微信小程序中可用'))));
    });

    test('checkSession 返回 false 而不是抛错', () async => expect(await MpWechat.checkSession(), isFalse));

    test('setShareInfo 为空操作', () => MpWechat.setShareInfo(title: 't'));

    test('menuButtonRect 返回 null(不抛)', () async => expect(await MpWechat.menuButtonRect(), isNull));

    test('setShareInfo:path 不以 / 开头时抛 ArgumentError(即便通道不可用也要先校验)', () {
      expect(() => MpWechat.setShareInfo(path: 'pages/x'), throwsArgumentError);
    });
  });

  group('经 channel 调用', () {
    test('login 返回 code', () async {
      MpWechat.debugSetChannel(FakeChannel({
        'login': {'code': 'c1', 'errMsg': 'login:ok'}
      }));
      expect(await MpWechat.login(), 'c1');
    });

    test('requestPayment 参数原样(timeStamp 为字符串)', () async {
      final ch = FakeChannel({
        'requestPayment': {'errMsg': 'requestPayment:ok'}
      });
      MpWechat.debugSetChannel(ch);
      await MpWechat.requestPayment(const MpPaymentParams(
          timeStamp: '1700000000', nonceStr: 'n', package: 'prepay_id=p', signType: 'RSA', paySign: 's'));
      expect(ch.calls['requestPayment'],
          {'timeStamp': '1700000000', 'nonceStr': 'n', 'package': 'prepay_id=p', 'signType': 'RSA', 'paySign': 's'});
    });

    test('用户取消:MpWechatException.cancelled 为 true', () async {
      MpWechat.debugSetChannel(FakeChannel({
        'requestPayment':
            const MpWechatException(api: 'requestPayment', errMsg: 'requestPayment:fail cancel', cancelled: true)
      }));
      await expectLater(
          MpWechat.requestPayment(const MpPaymentParams(
              timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'RSA', paySign: 's')),
          throwsA(isA<MpWechatException>().having((e) => e.cancelled, 'cancelled', isTrue)));
    });

    test('chooseAddress 解析中文地址', () async {
      MpWechat.debugSetChannel(FakeChannel({
        'chooseAddress': {
          'userName': '张三',
          'postalCode': '510000',
          'provinceName': '广东省',
          'cityName': '广州市',
          'countyName': '天河区',
          'detailInfo': '体育西路 1 号',
          'nationalCode': '440106',
          'telNumber': '13800000000'
        }
      }));
      final a = await MpWechat.chooseAddress();
      expect([a.userName, a.provinceName, a.detailInfo, a.telNumber], ['张三', '广东省', '体育西路 1 号', '13800000000']);
    });

    test('getLocation:整数坐标也解析为 double', () async {
      MpWechat.debugSetChannel(FakeChannel({
        'getLocation': {'latitude': 23, 'longitude': 113.3, 'speed': -1, 'accuracy': 65}
      }));
      final l = await MpWechat.getLocation();
      expect(l.latitude, 23.0);
      expect(l.longitude, 113.3);
    });

    test('checkSession:失败返回 false,成功返回 true', () async {
      MpWechat.debugSetChannel(FakeChannel({
        'checkSession': const MpWechatException(api: 'checkSession', errMsg: 'checkSession:fail', cancelled: false)
      }));
      expect(await MpWechat.checkSession(), isFalse);
      MpWechat.debugSetChannel(FakeChannel({
        'checkSession': {'errMsg': 'checkSession:ok'}
      }));
      expect(await MpWechat.checkSession(), isTrue);
    });

    test('getClipboardData / scanCode / 通用 call', () async {
      MpWechat.debugSetChannel(FakeChannel({
        'getClipboardData': {'data': '口令'},
        'scanCode': {'result': 'https://x', 'scanType': 'QR_CODE', 'charSet': 'utf-8'},
        'vibrateShort': {'errMsg': 'vibrateShort:ok'}
      }));
      expect(await MpWechat.getClipboardData(), '口令');
      expect((await MpWechat.scanCode()).result, 'https://x');
      expect(await MpWechat.call('vibrateShort', {'type': 'light'}), {'errMsg': 'vibrateShort:ok'});
    });

    test('setShareInfo:只传已设置字段', () {
      final ch = FakeChannel({});
      MpWechat.debugSetChannel(ch);
      MpWechat.setShareInfo(title: '特惠', path: '/pages/flutter/flutter?sku=1');
      expect(jsonDecode(ch.share!), {'title': '特惠', 'path': '/pages/flutter/flutter?sku=1'});
    });

    test('setShareInfo:path 不以 / 开头时抛 ArgumentError,不调用通道', () {
      final ch = FakeChannel({});
      MpWechat.debugSetChannel(ch);
      expect(() => MpWechat.setShareInfo(path: 'pages/x'), throwsArgumentError);
      expect(ch.share, isNull);
    });

    test('login 成功回调没有 code 时抛 MpWechatException', () async {
      MpWechat.debugSetChannel(FakeChannel({
        'login': {'errMsg': 'login:ok'}
      }));
      await expectLater(
          MpWechat.login(),
          throwsA(isA<MpWechatException>()
              .having((e) => e.api, 'api', 'login')
              .having((e) => e.errMsg, 'errMsg', 'login 成功回调未返回 code')
              .having((e) => e.cancelled, 'cancelled', isFalse)));
    });
  });

  group('menuButtonRect', () {
    test('JSON 转成逻辑像素 Rect', () async {
      MpWechat.debugSetChannel(FakeChannel({})
        ..menuRect = '{"left":281,"top":51,"right":368,"bottom":83,"width":87,"height":32}');
      final r = await MpWechat.menuButtonRect();
      expect(r, const Rect.fromLTRB(281, 51, 368, 83));
      expect(r!.width, 87);
    });

    test('桥返回 null / 坏 JSON / 缺字段时返回 null', () async {
      for (final raw in [null, '', 'not json', '{"left":1}']) {
        MpWechat.debugSetChannel(FakeChannel({})..menuRect = raw);
        expect(await MpWechat.menuButtonRect(), isNull, reason: 'raw=$raw');
      }
    });
  });
}
