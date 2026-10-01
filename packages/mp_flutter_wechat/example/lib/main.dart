// Minimal usage example for `mp_flutter_wechat`.
//
// This widget only calls WeChat APIs after checking `MpWechat.isAvailable`,
// which is `false` on every platform except a WeChat Mini Program compiled
// by `flutter_miniprogram` (the `mp-flutter` build tool). That keeps this
// example runnable (and analyzable) on any platform without throwing
// `UnsupportedError`.
import 'package:flutter/material.dart';
import 'package:mp_flutter_wechat/mp_flutter_wechat.dart';

void main() => runApp(const MpFlutterWechatExampleApp());

/// Root widget of the example app.
class MpFlutterWechatExampleApp extends StatelessWidget {
  /// Creates the example app.
  const MpFlutterWechatExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'mp_flutter_wechat example',
      home: const WechatLoginPage(),
    );
  }
}

/// Demonstrates a login + payment flow guarded by [MpWechat.isAvailable].
class WechatLoginPage extends StatefulWidget {
  /// Creates the login demo page.
  const WechatLoginPage({super.key});

  @override
  State<WechatLoginPage> createState() => _WechatLoginPageState();
}

class _WechatLoginPageState extends State<WechatLoginPage> {
  String _status = 'Idle';

  Future<void> _login() async {
    // Always gate WeChat-only APIs behind `isAvailable`: outside a Mini
    // Program compiled by mp-flutter, calling them throws `UnsupportedError`.
    if (!MpWechat.isAvailable) {
      setState(() => _status = 'WeChat bridge not available on this platform');
      return;
    }
    try {
      // `code` must be exchanged for openid/session_key on your server via
      // `auth.code2Session` — never do that exchange on the client.
      final code = await MpWechat.login();
      setState(() => _status = 'Got login code: $code');
    } on MpWechatException catch (e) {
      setState(() => _status = 'Login failed: ${e.errMsg}');
    }
  }

  Future<void> _pay() async {
    if (!MpWechat.isAvailable) {
      setState(() => _status = 'WeChat bridge not available on this platform');
      return;
    }
    try {
      // These values must come from your server's signed "unified order"
      // response; they are shown here only to illustrate the call shape.
      await MpWechat.requestPayment(const MpPaymentParams(
        timeStamp: '0',
        nonceStr: '',
        package: 'prepay_id=example',
        signType: 'MD5',
        paySign: '',
      ));
      setState(() => _status = 'Payment succeeded');
    } on MpWechatException catch (e) {
      setState(() => _status = e.cancelled ? 'Payment cancelled' : 'Payment failed: ${e.errMsg}');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('mp_flutter_wechat example')),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('WeChat available: ${MpWechat.isAvailable}'),
            const SizedBox(height: 12),
            Text(_status),
            const SizedBox(height: 24),
            ElevatedButton(onPressed: _login, child: const Text('Login')),
            ElevatedButton(onPressed: _pay, child: const Text('Pay')),
          ],
        ),
      ),
    );
  }
}
