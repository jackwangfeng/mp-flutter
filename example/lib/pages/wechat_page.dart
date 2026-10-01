import 'package:flutter/material.dart';
import 'package:mp_flutter_wechat/mp_flutter_wechat.dart';

/// 微信能力:登录/支付/扫码/分享等,全部来自 `package:mp_flutter_wechat`
/// (真实 API,见其 README——不是发明出来的接口)。
///
/// 非小程序环境下 `MpWechat.isAvailable` 为 `false`:按钮仍然可以点,
/// 但会走各方法自己的“不可用”行为——多数方法抛 `UnsupportedError`,
/// 由这里统一 catch 显示成一条日志,而不是让页面崩溃。
class WechatPage extends StatefulWidget {
  const WechatPage({super.key});

  @override
  State<WechatPage> createState() => _WechatPageState();
}

class _WechatPageState extends State<WechatPage> {
  final _log = <String>[];
  Rect? _menuButtonRect;

  void _append(String line) {
    setState(() {
      _log.insert(0, line);
      if (_log.length > 20) _log.removeLast();
    });
  }

  Future<void> _run(String label, Future<Object?> Function() action) async {
    try {
      final result = await action();
      _append('✓ $label: ${result ?? '(无返回值)'}');
    } on MpWechatException catch (e) {
      _append(e.cancelled ? '· $label: 用户取消' : '✗ $label 失败: ${e.errMsg}');
    } on UnsupportedError catch (e) {
      _append('✗ $label: ${e.message}');
    } catch (e) {
      _append('✗ $label 异常: $e');
    }
  }

  Future<void> _loadMenuButtonRect() async {
    final rect = await MpWechat.menuButtonRect();
    setState(() => _menuButtonRect = rect);
  }

  @override
  void initState() {
    super.initState();
    // menuButtonRect() 不可用时返回 null(不抛),可以直接调用而不需要按钮触发。
    _loadMenuButtonRect();
  }

  @override
  Widget build(BuildContext context) {
    final available = MpWechat.isAvailable;
    final width = MediaQuery.sizeOf(context).width;
    // 胶囊按钮不算进安全区 padding,右上角要放内容时按这个套路让位
    // (见 packages/mp_flutter_wechat/README.md「避开胶囊按钮」)。
    final rightGap = _menuButtonRect == null ? 16.0 : width - _menuButtonRect!.left + 8;

    return Padding(
      padding: EdgeInsets.only(right: rightGap),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('微信能力', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          if (!available)
            Container(
              key: const Key('wechat-unavailable-banner'),
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.errorContainer,
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Text('仅小程序可用:当前不在 mp-flutter 编译的微信小程序环境中,下面按钮会显示各自的失败提示'),
            ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton(onPressed: () => _run('login', () => MpWechat.login()), child: const Text('登录 wx.login')),
              FilledButton(
                onPressed: () => _run('checkSession', () => MpWechat.checkSession()),
                child: const Text('checkSession'),
              ),
              FilledButton(
                onPressed: () => _run(
                  'requestPayment',
                  () => MpWechat.requestPayment(const MpPaymentParams(
                    // 故意用无效签名:演示“失败路径可诊断”,真实支付参数须由业务
                    // 服务端“统一下单”签名后下发(见 mp_flutter_wechat README)。
                    timeStamp: '0',
                    nonceStr: 'demo',
                    package: 'prepay_id=demo',
                    signType: 'MD5',
                    paySign: 'invalid',
                  )),
                ),
                child: const Text('支付 wx.requestPayment(演示失败路径)'),
              ),
              FilledButton(
                onPressed: () => _run('chooseAddress', () => MpWechat.chooseAddress()),
                child: const Text('chooseAddress'),
              ),
              FilledButton(onPressed: () => _run('scanCode', () => MpWechat.scanCode()), child: const Text('扫码 scanCode')),
              FilledButton(
                onPressed: () => _run('setClipboardData', () => MpWechat.setClipboardData('flutter_miniprogram 示例')),
                child: const Text('写剪贴板'),
              ),
              FilledButton(
                onPressed: () => _run('getClipboardData', () => MpWechat.getClipboardData()),
                child: const Text('读剪贴板'),
              ),
              FilledButton(
                onPressed: () => _run('getLocation', () => MpWechat.getLocation()),
                child: const Text('定位 getLocation'),
              ),
              FilledButton(
                onPressed: () => _run('makePhoneCall', () => MpWechat.makePhoneCall('10086')),
                child: const Text('拨号 makePhoneCall'),
              ),
              FilledButton(
                onPressed: () {
                  MpWechat.setShareInfo(title: 'flutter_miniprogram 示例', path: '/pages/flutter/flutter');
                  _append('✓ setShareInfo: 已设置分享标题');
                },
                child: const Text('设置分享 setShareInfo'),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Text('胶囊按钮矩形:${_menuButtonRect ?? '(不可用,返回 null)'}', key: const Key('menu-button-rect')),
          const Divider(height: 32),
          const Text('调用日志(最新在上)', style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          for (final line in _log) Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Text(line)),
        ],
      ),
    );
  }
}
