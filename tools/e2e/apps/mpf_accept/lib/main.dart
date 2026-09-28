import 'dart:async';
import 'dart:math';

import 'package:flutter/widgets.dart';

void main() {
  // 框架捕获的异常(布局/绘制里抛出的,如文字排版失败)只走 FlutterError,
  // release 下经 debugPrint 打成普通日志,不是 console.error——单独上报给 E2E
  FlutterError.onError = (details) {
    print('STATE|flutterError=${details.exceptionAsString().split('\n').first}');
  };
  runApp(const AcceptApp());
  unawaited(runCryptoCheck());
}

// K4 验收(crypto.getRandomValues):Random.secure() 在 Flutter Web 上经
// self.crypto.getRandomValues 取真随机数——两次取值必须不同且非空,才说明
// ChaCha20 DRBG 真的在同步产出随机数据,不是靠某个常量/占位值蒙混过关。
// `package:uuid` 一类库的 v4 生成本质上就是这一条调用链,所以不用额外引入
// 依赖单独验证。
//
// 兜底 try/catch(参照 tools/e2e/apps/mpf_wx 的 step() 写法):验收工程绝不能
// 因为某个能力不可用/环境差异就把整页崩成一片黑——就算 Random.secure() 真的
// 因为 wx.getRandomValues 不可用而抛 Unsupported,也要能打出 ERR 状态供人核对,
// 而不是一个吞掉具体原因的未捕获异常。
Future<void> runCryptoCheck() async {
  try {
    final rnd = Random.secure();
    // 2^32,不写成 `1 << 32`——dart2js 把 `<<` 编译成 JS 原生位移语义(结果按
    // 32 位截断),`1 << 32` 在 web 上常量折叠成 0(E2E 实测抓到:
    // `RangeError: max must be in range 0 < max ≤ 2^32, was 0`),
    // 只有 Dart VM/AOT 的 64 位 int 语义下 `1 << 32` 才等于本来想要的 2^32。
    const max32 = 4294967296;
    print('STATE|rand=${rnd.nextInt(max32)}');
    await Future<void>.delayed(const Duration(milliseconds: 50));
    print('STATE|rand=${rnd.nextInt(max32)}');
  } catch (e) {
    print('STATE|rand=ERR $e');
  }
}

class AcceptApp extends StatelessWidget {
  const AcceptApp({super.key});
  @override
  Widget build(BuildContext context) => const Directionality(
        textDirection: TextDirection.ltr,
        child: ColoredBox(
          color: Color(0xFFFF7A3D),
          child: Stack(
            children: [
              Center(
                child: SizedBox(
                  width: 120, height: 120,
                  child: ColoredBox(color: Color(0xFF6EE7A8)),
                ),
              ),
              // 文本排版验收(iOS 白屏回归):chromium 版 CanvasKit 排任何文字都要
              // Intl.v8BreakIterator/Intl.Segmenter,iOS JavaScriptCore 没有前者、
              // 部分安卓连 Intl 都没有——首次排版即抛异常、整页白屏。放在顶部
              // 一条窄栏里强制多行换行,不遮住像素采样点(中心与左下角)。
              Positioned(
                top: 40, left: 16, width: 160,
                child: _TextProbe(),
              ),
            ],
          ),
        ),
      );
}

class _TextProbe extends StatefulWidget {
  const _TextProbe();
  @override
  State<_TextProbe> createState() => _TextProbeState();
}

class _TextProbeState extends State<_TextProbe> {
  @override
  void initState() {
    super.initState();
    // 能跑到首帧之后,说明含文字的布局/绘制没有抛异常
    WidgetsBinding.instance.addPostFrameCallback((_) => print('STATE|text=laidout'));
  }

  @override
  Widget build(BuildContext context) => const Text(
        '文本换行验收:mp-flutter 在微信小程序里排版中文与 English words,'
        '“引号”(括号)。',
        style: TextStyle(fontSize: 14, color: Color(0xFF000000)),
      );
}
