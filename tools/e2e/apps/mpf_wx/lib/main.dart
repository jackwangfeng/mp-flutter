import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:mp_flutter_wechat/mp_flutter_wechat.dart';

const base = 'http://127.0.0.1:18080';

void main() {
  runApp(const MaterialApp(home: Scaffold(body: Center(child: Text('wx')))));
  unawaited(run());
}

Future<void> step(String name, Future<String> Function() f) async {
  try { print('STATE|$name=${await f()}'); } catch (e) { print('STATE|$name=ERR $e'); }
}

Future<void> run() async {
  print('STATE|wx_available=${MpWechat.isAvailable}');
  String code = '';
  await step('login', () async => code = await MpWechat.login());
  await step('backend', () async =>
      (jsonDecode((await http.get(Uri.parse('$base/api/wx/login?code=$code'))).body) as Map)['openid'] as String);
  await step('session', () async => '${await MpWechat.checkSession()}');
  await step('pay', () async {
    final p = MpPaymentParams.fromJson(
        (jsonDecode((await http.get(Uri.parse('$base/api/wx/prepay'))).body) as Map).cast<String, Object?>());
    await MpWechat.requestPayment(p).timeout(const Duration(seconds: 15));
    return 'ok';
  });
  await step('clip', () async { await MpWechat.setClipboardData('口令123'); return MpWechat.getClipboardData(); });
  print('STATE|ready_share_default');
  await Future<void>.delayed(const Duration(seconds: 3));
  MpWechat.setShareInfo(title: '限时特惠', path: '/pages/flutter/flutter?sku=42');
  print('STATE|share_set_done');
}
