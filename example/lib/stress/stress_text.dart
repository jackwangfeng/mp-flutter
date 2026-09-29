import 'stress_config.dart';

/// C/D 共用的长图文内容:可复现的伪随机常用汉字,固定种子,不依赖网络/资产。
class StressParagraph {
  const StressParagraph({required this.isTitle, required this.text});
  final bool isTitle;
  final String text;
}

/// 100 个常用简体汉字,纯粹当“字库”用,没有实际语义。
const _kCommonHanzi = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对'
    '成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力'
    '里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前'
    '外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向'
    '道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入';

/// 一个极简、纯 Dart 的线性同余生成器——不用 `dart:math` 的 `Random(seed)`
/// (虽然文档说给定 seed 时各实现输出一致,但没必要依赖这个隐式保证),
/// 手写一个保证跨 dart2js/VM 完全确定。
class _Lcg {
  _Lcg(int seed) : _s = seed & 0x7fffffff;
  int _s;
  int next() {
    _s = (_s * 1103515245 + 12345) & 0x7fffffff;
    return _s;
  }
}

/// 生成 >= [StressConfig.textParagraphTarget] 段、总字数 >=
/// [StressConfig.textCharTarget] 的中文内容,每 5 段插一个标题(w700)。
List<StressParagraph> buildStressParagraphs() {
  final rnd = _Lcg(20260929);
  final pieces = <StressParagraph>[];
  var totalChars = 0;
  var i = 0;
  while ((totalChars < StressConfig.textCharTarget || i < StressConfig.textParagraphTarget) && i < 2000) {
    final isTitle = i % 5 == 0;
    final len = isTitle ? 8 + rnd.next() % 8 : 32 + rnd.next() % 24;
    final buf = StringBuffer();
    for (var k = 0; k < len; k++) {
      buf.write(_kCommonHanzi[rnd.next() % _kCommonHanzi.length]);
    }
    pieces.add(StressParagraph(isTitle: isTitle, text: buf.toString()));
    totalChars += len;
    i++;
  }
  return pieces;
}

int totalCharsOf(List<StressParagraph> paragraphs) =>
    paragraphs.fold(0, (sum, p) => sum + p.text.length);
