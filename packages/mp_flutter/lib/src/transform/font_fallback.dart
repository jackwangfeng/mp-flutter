import 'dart:convert';

import 'canvaskit_js.dart' show TransformFailure;

/// main.dart.js 回退字体补丁(配合常用汉字合一字体,见 `cjk_font.dart`)。
///
/// 依据 Flutter 3.41.9 引擎源码(`lib/_engine/engine/font_fallbacks.dart`):
///
///  · `FontFallbackManager.globalFontFallbacks` 初值是 `['Roboto']`,之后下载的
///    分片依次追加;每个段落样式的 fontFamilies 末尾都拼上这张表
///    (canvaskit/text.dart `_computeCombinedFontFamilies`)。**补丁 A** 把初值
///    改成 `['Roboto', <合一字体>]`,合一字体就排在 Roboto 之后、所有分片之前。
///  · 缺字检测 `ensureFontsSupportText(text, fontFamilies)` 只查段落自己的
///    family/fallback(**不含** globalFontFallbacks),查出缺字后把这段文字的
///    **全部**码点交给贪心选字体:只要有一个字缺,整段文字涉及的分片全被选中。
///    iOS 上默认 family(CupertinoSystemText 等)根本没注册,每段中文都"全缺"。
///    **补丁 B** 让检测时也查合一字体,并且只把真正缺的码点交给贪心——常用字
///    不再触发分片下载,生僻字只拉它自己所在的分片。
///
/// 结构化匹配,不绑死 dart2js 的压缩名;压缩与 --profile(不压缩)两种写法都认。
/// 失配时抛 [TransformFailure] 点名是哪一处,不静默产出缺补丁的文件——缺补丁
/// 时合一字体虽然注册了,首屏照样拉几十个分片、多次整体重排,极难看出原因。
String patchFontFallback(String source, {required String family}) {
  final famJs = jsonEncode(family);
  var out = source;

  // ── 补丁 A:globalFontFallbacks 初值 ──
  // 工厂/构造函数里 `navigator.language` 与 `["Roboto"]` 相邻(字段初始化顺序:
  // _language 在 globalFontFallbacks 之前)。
  // --profile 产物写成 `A._asJSObject(A._asJSObject(init.G.window).navigator).language`
  final a = RegExp(r'navigator\)*\.language[\s\S]{0,600}?\[\s*"Roboto"\s*\]');
  final aMatches = a.allMatches(out).toList();
  if (aMatches.length != 1) {
    throw TransformFailure(
      '回退字体补丁 A(globalFontFallbacks 初值 ["Roboto"])',
      '在 navigator.language 附近期望恰好 1 处 ["Roboto"],实际 ${aMatches.length} 处。'
      '引擎 FontFallbackManager 的字段初始化可能变了(font_fallbacks.dart)。'
      '可设 cjk_font: false 临时关闭常用汉字合一字体。',
      file: 'main.dart.js',
    );
  }
  final am = aMatches.single;
  final aText = am.group(0)!;
  final robotoAt = aText.lastIndexOf('"Roboto"');
  out = out.replaceRange(am.start + robotoAt, am.start + robotoAt + '"Roboto"'.length,
      '"Roboto",$famJs');

  // ── 补丁 B:缺字检测 ──
  //   if (!(rune < 160 || known.contains(rune) || noFont.contains(rune))) runesToCheck.add(rune)
  //   ...
  //   if (_registry.getMissingCodePoints(codePoints, fontFamilies).length !== 0)
  //     addMissingCodePoints(codePoints)
  final b = RegExp(
    r'(<\s*160\s*\|\|[\s\S]{0,500}?)'
    r'if\s*\(\s*([\w$]+(?:\.[\w$]+)*)\.([\w$]+)\(\s*([\w$]+)\s*,\s*([\w$]+)\s*\)'
    r'\.length\s*!==\s*0\s*\)\s*([\w$]+)\.([\w$]+)\(\s*\4\s*\)',
  );
  final bMatches = b.allMatches(out).toList();
  if (bMatches.length != 1) {
    throw TransformFailure(
      '回退字体补丁 B(ensureFontsSupportText 缺字检测)',
      '期望恰好 1 处 "rune < 160 ... getMissingCodePoints(codePoints, fontFamilies).length !== 0'
      ' → addMissingCodePoints(codePoints)",实际 ${bMatches.length} 处。'
      '引擎 font_fallbacks.dart 的 ensureFontsSupportText 可能变了。'
      '可设 cjk_font: false 临时关闭常用汉字合一字体。',
      file: 'main.dart.js',
    );
  }
  final bm = bMatches.single;
  // fontFamilies 是 addText 里每次新建的局部列表,只传给这一处:原地 push 不影响
  // 别处,且保留 dart2js 挂在数组上的类型信息($ti)——concat/slice 出来的新数组
  // 没有它,--profile 产物里 `List<String>._as` 类型检查会失败。
  final fams = bm.group(5)!;
  final replacement = '${bm.group(1)}'
      '{if($fams.indexOf($famJs)<0)$fams.push($famJs);'
      'var __mpMiss=${bm.group(2)}.${bm.group(3)}(${bm.group(4)},$fams);'
      'if(__mpMiss.length!==0)${bm.group(6)}.${bm.group(7)}(__mpMiss)}';
  out = out.replaceRange(bm.start, bm.end, replacement);
  return out;
}
