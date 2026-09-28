// `flutter test` 默认跑在 Dart VM 上(不是浏览器),`dart.library.js_interop`
// 在这个目标下不可用——按 `lib/src/mp_native_view.dart` 顶部的条件导入,这里
// 恒定选中 `registry_stub.dart`,`mpNativeAvailable` 恒为 false。
//
// 覆盖 brief 的三条测试要求:
//   1. stub 下渲染 fallback;
//   2. 参数序列化(中文、markers 列表)稳定;
//   3. 事件 JSON 解析到回调。
// Web 端(真正创建占位 div、注册 view factory、通过 `self.__mpNative` 转发
// 命令)只能在浏览器目标里跑,不在本文件覆盖范围——见 task-3-report.md 里
// 记录的 web 编译检查。
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mp_flutter_native/mp_flutter_native.dart';
import 'package:mp_flutter_native/src/mp_native_view.dart';

void main() {
  test('stub 平台下 mpNativeAvailable 为 false', () {
    expect(mpNativeAvailable, isFalse);
  });

  group('stub 下渲染 fallback', () {
    testWidgets('MpVideo 没有原生环境时渲染 fallback', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: MpVideo(src: 'a.mp4', fallback: const Text('no-video')),
      ));
      expect(find.text('no-video'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('MpMap 没有原生环境时渲染 fallback', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: MpMap(latitude: 31.2, longitude: 121.5, fallback: const Text('no-map')),
      ));
      expect(find.text('no-map'), findsOneWidget);
    });

    testWidgets('MpCamera 没有原生环境时渲染 fallback', (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: MpCamera(fallback: Text('no-camera')),
      ));
      expect(find.text('no-camera'), findsOneWidget);
    });

    testWidgets('没有指定 fallback 时默认渲染空(SizedBox.shrink),不抛异常', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: MpCamera()));
      expect(tester.takeException(), isNull);
      final sizedBoxes = tester
          .widgetList<SizedBox>(find.byType(SizedBox))
          .where((w) => w.width == 0 && w.height == 0);
      expect(sizedBoxes, isNotEmpty);
    });

    testWidgets('MpNativeView 直接使用时也一样渲染 fallback(内部承载 widget)',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: MpNativeView(
          kind: MpNativeKind.video,
          params: const {},
          fallback: const Text('inner-fallback'),
        ),
      ));
      expect(find.text('inner-fallback'), findsOneWidget);
    });
  });

  group('参数序列化稳定(中文、markers 列表)', () {
    test('MpMap:两次序列化结果一致,markers 列表与中文标题原样保留', () {
      const map = MpMap(
        latitude: 31.2,
        longitude: 121.5,
        scale: 15,
        markers: [
          MpMapMarker(id: 1, latitude: 31.2, longitude: 121.5, title: '中文标题一'),
          MpMapMarker(id: 2, latitude: 31.3, longitude: 121.6, title: '中文标题二', iconPath: 'a.png'),
        ],
        showLocation: true,
      );
      final json1 = map.debugParamsJson();
      final json2 = map.debugParamsJson();
      expect(json1, equals(json2));

      final decoded = jsonDecode(json1) as Map<String, Object?>;
      expect(decoded['latitude'], 31.2);
      expect(decoded['longitude'], 121.5);
      expect(decoded['scale'], 15);
      expect(decoded['showLocation'], isTrue);
      final markers = decoded['markers'] as List;
      expect(markers, hasLength(2));
      expect((markers[0] as Map)['title'], '中文标题一');
      expect((markers[1] as Map)['iconPath'], 'a.png');
    });

    test('MpVideo:含中文 poster 路径的参数序列化稳定,可选字段缺省时不出现在 JSON 里', () {
      const video = MpVideo(src: 'https://example.com/视频.mp4', poster: '封面图.png');
      final json1 = video.debugParamsJson();
      final json2 = video.debugParamsJson();
      expect(json1, equals(json2));
      final decoded = jsonDecode(json1) as Map<String, Object?>;
      expect(decoded['src'], 'https://example.com/视频.mp4');
      expect(decoded['poster'], '封面图.png');
      expect(decoded['autoplay'], isFalse);
      expect(decoded['objectFit'], 'contain');

      const videoNoPoster = MpVideo(src: 'a.mp4');
      final decodedNoPoster =
          jsonDecode(videoNoPoster.debugParamsJson()) as Map<String, Object?>;
      expect(decodedNoPoster.containsKey('poster'), isFalse);
    });

    test('MpCamera:参数序列化稳定', () {
      const camera = MpCamera(devicePosition: 'front', flash: 'on');
      final json1 = camera.debugParamsJson();
      final json2 = camera.debugParamsJson();
      expect(json1, equals(json2));
      final decoded = jsonDecode(json1) as Map<String, Object?>;
      expect(decoded['devicePosition'], 'front');
      expect(decoded['flash'], 'on');
    });
  });

  group('事件 JSON 解析到回调', () {
    test('parseNativeEventJson 正常解析 {type, detail}', () {
      final parsed =
          parseNativeEventJson(jsonEncode({'type': 'play', 'detail': null}));
      expect(parsed.type, 'play');
      expect(parsed.detail, isNull);

      final parsed2 = parseNativeEventJson(
          jsonEncode({'type': 'timeupdate', 'detail': {'currentTime': 12.5}}));
      expect(parsed2.type, 'timeupdate');
      expect((parsed2.detail as Map)['currentTime'], 12.5);
    });

    test('parseNativeEventJson 对非法 JSON / 非对象兜底返回空事件,不抛错', () {
      expect(parseNativeEventJson('not json'), (type: '', detail: null));
      expect(parseNativeEventJson(jsonEncode([1, 2, 3])), (type: '', detail: null));
    });

    test('MpVideo:play/pause/ended/timeupdate/error 事件驱动到对应回调', () {
      final calls = <String>[];
      double? seenTime;
      String? seenError;
      final video = MpVideo(
        src: 'a.mp4',
        onPlay: () => calls.add('play'),
        onPause: () => calls.add('pause'),
        onEnded: () => calls.add('ended'),
        onTimeUpdate: (t) => seenTime = t,
        onError: (e) => seenError = e,
      );

      void feed(String type, Object? detail) {
        final raw = jsonEncode({'type': type, 'detail': detail});
        final parsed = parseNativeEventJson(raw);
        video.debugHandleEvent(parsed.type, parsed.detail);
      }

      feed('play', null);
      feed('pause', null);
      feed('ended', null);
      feed('timeupdate', {'currentTime': 3.5});
      feed('error', {'errMsg': '解码失败:格式不支持'});

      expect(calls, ['play', 'pause', 'ended']);
      expect(seenTime, 3.5);
      expect(seenError, '解码失败:格式不支持');
    });

    test('MpMap:tap/markertap/regionchange 事件驱动到对应回调', () {
      double? tapLat;
      double? tapLng;
      int? tappedMarkerId;
      final regionChanges = <String>[];
      final map = MpMap(
        latitude: 0,
        longitude: 0,
        onTap: (lat, lng) {
          tapLat = lat;
          tapLng = lng;
        },
        onMarkerTap: (id) => tappedMarkerId = id,
        onRegionChange: (type) => regionChanges.add(type),
      );

      map.debugHandleEvent('tap', {'latitude': 31.2, 'longitude': 121.5});
      map.debugHandleEvent('markertap', {'markerId': 7});
      // I2 修复:微信 bindregionchange 的 e.type 是 'begin'/'end',不是
      // 'regionchange';两者都应该被当作视野变化分派,并把 type 带给回调。
      map.debugHandleEvent('begin', null);
      map.debugHandleEvent('end', null);

      expect(tapLat, 31.2);
      expect(tapLng, 121.5);
      expect(tappedMarkerId, 7);
      expect(regionChanges, ['begin', 'end']);
    });

    test('MpCamera:error 事件驱动到回调', () {
      String? seenError;
      final camera = MpCamera(onError: (e) => seenError = e);
      camera.debugHandleEvent('error', {'errMsg': '权限被拒绝'});
      expect(seenError, '权限被拒绝');
    });
  });

  group('控制器未绑定时(stub 平台 / 尚未创建原生视图)调用抛 UnsupportedError', () {
    test('MpVideoController', () async {
      final controller = MpVideoController();
      await expectLater(controller.play(), throwsUnsupportedError);
      await expectLater(controller.seek(1), throwsUnsupportedError);
    });

    test('MpMapController', () async {
      final controller = MpMapController();
      await expectLater(controller.moveToLocation(), throwsUnsupportedError);
      await expectLater(controller.getCenterLocation(), throwsUnsupportedError);
    });

    test('MpCameraController', () async {
      final controller = MpCameraController();
      await expectLater(controller.takePhoto(), throwsUnsupportedError);
    });
  });
}
