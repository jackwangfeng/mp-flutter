import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

/// 常用汉字合一字体(`cjk_font`,默认 full)。
///
/// 为什么要它:引擎的简体中文回退字体 Noto Sans SC 被切成约 100 个分片,常用字
/// 按码位轮转散在几十片里,一屏中文要拉几十个分片;每批分片到齐引擎就发一次
/// `fontsChange`,框架把所有 RenderParagraph 重新排版(真机首屏 3 次、每次
/// 600–700ms 的 layout)。合一字体覆盖 GB2312 一级(level1)或一二级(full)+ 常用标点,
/// 首帧前经 FontManifest 注册,再由 main.dart.js 补丁(见
/// `transform/font_fallback.dart`)让引擎把它当作 Roboto 之后的第一个回退字体、
/// 缺字检测时也算上它——首屏中文不再触发分片下载,生僻字仍走原分片。
///
/// 字体文件由 `tools/fonts/gen_cjk_common.py` 从 Noto Sans SC v37(OFL 1.1)
/// 生成后入库,构建时不依赖 Python。

/// 合一字体在引擎里的 family 名。不能与任何 Noto 分片名(`Noto Sans SC 0`…)或
/// 业务字体重名。
const kCjkFontFamily = 'MpNotoSansSC';

/// 两档字表的包内源文件(相对 mp_flutter 包根)。
const kCjkFontSources = {
  'level1': 'fonts/NotoSansSC-GB2312-L1.ttf', // GB2312 一级 3755 字 + 标点/全角/Latin-1
  'full': 'fonts/NotoSansSC-GB2312.ttf', // 再加二级 3008 字
};

/// 在 FontManifest 里声明的资源路径(相对 `assets/`)。引擎按
/// `assets/<这个路径>` 请求;这个请求不走资源分包,由 boot 预读的字节直接应答。
const kCjkFontAssetRel = 'mp-cjk/NotoSansSC.ttf';

/// 引擎请求的资源 key。
const kCjkFontAsset = 'assets/$kCjkFontAssetRel';

/// 合一字体所在的分包:只有一个 brotli 压缩的字体文件和就位探针。
///
/// 不再 base64 内嵌 JS:真机上引擎取字体时才 require.async 两个 1–1.4MB 的
/// base64 模块再解码,iOS 实测 2.1MB 字体等了 1536ms(安卓 815ms),且串在
/// dart-main 之后。现在 boot 一开始就拉这个分包,就位后用
/// `FileSystemManager.readCompressedFile`(代码包文件 + 原生 brotli 解压)读出
/// 字节,与 CanvasKit 初始化、Dart 分片执行并行;代码包里的 .br 也比 base64
/// 小一半多(level1 约 650KB vs 1.5MB)。
const kCjkFontPackage = 'pkg-cjk';

/// 分包里的文件(相对分包 root)。
const kCjkFontFile = 'mp-cjk.ttf.br';

/// 读入库的合一字体。[level] 是 `level1` / `full`。
List<int> readCjkFont(String packageRoot, {String level = 'level1'}) {
  final rel = kCjkFontSources[level];
  if (rel == null) throw ArgumentError.value(level, 'level', '只能是 ${kCjkFontSources.keys.join(' / ')}');
  final f = File(p.join(packageRoot, rel));
  if (!f.existsSync()) {
    throw StateError('找不到常用汉字合一字体 ${f.path}(mp_flutter 包不完整?)。'
        '可用 tools/fonts/gen_cjk_common.py 重新生成,或设 cjk_font: false 关闭。');
  }
  return f.readAsBytesSync();
}

/// 往 `FontManifest.json` 追加合一字体家族,返回新的清单字节。
///
/// 清单缺失或为空时新建;解析失败抛 [FormatException](不能静默跳过:
/// 跳过后 main.dart.js 补丁仍会把 [kCjkFontFamily] 当回退字体,但家族没注册,
/// 缺字检测拿不到它,等于白打补丁)。已声明同名家族时原样返回。
List<int> addCjkFontToManifest(List<int>? manifestBytes) {
  List<dynamic> doc;
  if (manifestBytes == null || manifestBytes.isEmpty) {
    doc = [];
  } else {
    final parsed = jsonDecode(utf8.decode(manifestBytes));
    if (parsed is! List) {
      throw const FormatException('FontManifest.json 顶层不是数组');
    }
    doc = parsed;
  }
  final exists = doc.any((f) => f is Map && f['family'] == kCjkFontFamily);
  if (!exists) {
    doc.add({
      'family': kCjkFontFamily,
      'fonts': [
        {'asset': kCjkFontAssetRel},
      ],
    });
  }
  return utf8.encode(jsonEncode(doc));
}
