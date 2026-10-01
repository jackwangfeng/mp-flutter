import 'dart:convert';

import 'package:flutter/widgets.dart';

import 'mp_native_view.dart';

/// [MpMap] 上的一个标记点(对应 wx `<map>` 的 `markers`)。
class MpMapMarker {
  /// 创建一个地图标记点。
  const MpMapMarker({
    required this.id,
    required this.latitude,
    required this.longitude,
    this.title,
    this.iconPath,
    this.width,
    this.height,
  });

  /// 标记点 id,[MpMap.onMarkerTap] 用它区分被点击的是哪个标记。
  final int id;

  /// 纬度。
  final double latitude;

  /// 经度。
  final double longitude;

  /// 标注文字。
  final String? title;

  /// 自定义图标地址。
  final String? iconPath;

  /// 图标宽度(像素)。
  final double? width;

  /// 图标高度(像素)。
  final double? height;

  /// 转成写进 wx `<map>` `markers` 的 JSON map。
  Map<String, Object?> toJson() => {
    'id': id,
    'latitude': latitude,
    'longitude': longitude,
    if (title != null) 'title': title,
    if (iconPath != null) 'iconPath': iconPath,
    if (width != null) 'width': width,
    if (height != null) 'height': height,
  };
}

/// 控制一个 [MpMap] 对应的原生 `<map>` 组件。
///
/// 只在对应的 [MpMap] 已经在小程序环境里创建完成后才可用;其它情况下调用
/// 任意方法都抛 [UnsupportedError]。
class MpMapController extends MpNativeControllerBinding {
  /// 创建一个地图控制器;创建后需绑定到一个 [MpMap] 才能真正发出命令。
  MpMapController();

  /// 将地图中心移动到当前定位点。
  Future<void> moveToLocation() async {
    await sendCommand('moveToLocation');
  }

  /// 获取当前地图中心的经纬度。
  Future<({double latitude, double longitude})> getCenterLocation() async {
    final raw = await sendCommand('getCenterLocation');
    final decoded = jsonDecode(raw);
    final map = decoded is Map ? decoded : const {};
    final latitude = (map['latitude'] as num?)?.toDouble() ?? 0;
    final longitude = (map['longitude'] as num?)?.toDouble() ?? 0;
    return (latitude: latitude, longitude: longitude);
  }
}

/// 小程序原生 `<map>` 组件。
///
/// ★ 原生组件总是叠在所有 Flutter 内容之上:Flutter 里想盖在 [MpMap] 上面
/// 的内容(比如浮层),实际效果是被地图遮住,而不是盖住地图。
///
/// 非 mp-flutter 编译的小程序环境下渲染 [fallback](默认空)。
class MpMap extends StatelessWidget {
  /// 创建一个原生地图组件。
  const MpMap({
    super.key,
    required this.latitude,
    required this.longitude,
    this.scale = 16,
    this.markers = const [],
    this.showLocation = false,
    this.controller,
    this.onTap,
    this.onMarkerTap,
    this.onRegionChange,
    this.fallback,
  });

  /// 中心点纬度。
  final double latitude;

  /// 中心点经度。
  final double longitude;

  /// 缩放级别,默认 16。
  final double scale;

  /// 标记点列表。
  final List<MpMapMarker> markers;

  /// 是否显示当前定位蓝点。
  final bool showLocation;

  /// 控制这个地图组件(移动中心、取中心点等),见 [MpMapController]。
  final MpMapController? controller;

  /// 点击地图回调,参数是点击处的经纬度。
  final void Function(double latitude, double longitude)? onTap;

  /// 点击标记点回调,参数是 [MpMapMarker.id]。
  final ValueChanged<int>? onMarkerTap;

  /// 地图视野变化(拖动/缩放/`moveToLocation` 等触发)。微信 `bindregionchange`
  /// 的事件对象里没有 `type: 'regionchange'`——`e.type` 本身就是 `'begin'`
  /// (视野开始变化)或 `'end'`(视野变化结束),同步层(`onMpNativeEvent`)
  /// 把 `e.type` 原样转发给这里(见 `_onEvent`),所以这个回调直接把
  /// `'begin'`/`'end'` 传给业务代码,而不是自造一个统一的 `'regionchange'`
  /// 吞掉这个信息(修复轮 I2,2026-09-27 终审)。
  final ValueChanged<String>? onRegionChange;

  /// 非 mp-flutter 编译的小程序环境下渲染的占位内容,默认空。
  final Widget? fallback;

  Map<String, Object?> _params() => {
    'latitude': latitude,
    'longitude': longitude,
    'scale': scale,
    'markers': markers.map((m) => m.toJson()).toList(),
    'showLocation': showLocation,
  };

  /// 仅测试/调试用,见 `MpVideo.debugParamsJson`。
  String debugParamsJson() => jsonEncode(_params());

  /// 仅测试/调试用,见 `MpVideo.debugHandleEvent`。
  void debugHandleEvent(String type, Object? detail) => _onEvent(type, detail);

  void _onEvent(String type, Object? detail) {
    switch (type) {
      case 'tap':
        final lat = detail is Map ? detail['latitude'] : null;
        final lng = detail is Map ? detail['longitude'] : null;
        if (lat is num && lng is num) {
          onTap?.call(lat.toDouble(), lng.toDouble());
        }
      case 'markertap':
        final markerId = detail is Map ? detail['markerId'] : null;
        if (markerId is num) onMarkerTap?.call(markerId.toInt());
      case 'begin':
      case 'end':
        // 微信 bindregionchange 的 e.type 就是 'begin'/'end'(见上面
        // onRegionChange 字段的文档),不是 'regionchange'。
        onRegionChange?.call(type);
    }
  }

  @override
  Widget build(BuildContext context) {
    return MpNativeView(
      kind: MpNativeKind.map,
      params: _params(),
      controller: controller,
      onEvent: _onEvent,
      fallback: fallback,
    );
  }
}
