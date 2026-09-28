import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:mp_flutter/src/cjk_font.dart';
import 'package:mp_flutter/src/package_root.dart';
import 'package:test/test.dart';

void main() {
  test('FontManifest 追加合一字体家族;已有同名家族不重复;清单缺失时新建', () {
    final orig = utf8.encode(jsonEncode([
      {'family': 'MaterialIcons', 'fonts': [{'asset': 'fonts/MaterialIcons-Regular.otf'}]},
    ]));
    final out = jsonDecode(utf8.decode(addCjkFontToManifest(orig))) as List;
    expect(out, hasLength(2));
    expect(out.last, {'family': kCjkFontFamily, 'fonts': [{'asset': kCjkFontAssetRel}]});
    final again = jsonDecode(utf8.decode(addCjkFontToManifest(addCjkFontToManifest(orig)))) as List;
    expect(again, hasLength(2));
    expect(jsonDecode(utf8.decode(addCjkFontToManifest(null))), hasLength(1));
    expect(() => addCjkFontToManifest(utf8.encode('{"x":1}')), throwsFormatException);
  });

  test('入库的两档字体文件:TTF;level1 约 1.1MB、full 约 2.1MB', () async {
    final root = await resolvePackageRoot();
    final l1 = readCjkFont(root);
    final full = readCjkFont(root, level: 'full');
    // TrueType 魔数 00 01 00 00
    expect(l1.sublist(0, 4), [0, 1, 0, 0]);
    expect(full.sublist(0, 4), [0, 1, 0, 0]);
    expect(l1.length, inInclusiveRange(1000000, 1300000));
    expect(full.length, inInclusiveRange(1800000, 2400000));
    expect(() => readCjkFont(root, level: 'level2'), throwsArgumentError);
  });

  test('FontManifest 粗体:同一家族第二个字体(weight 700),family 只出现一次', () {
    final out = jsonDecode(utf8.decode(addCjkFontToManifest(null, bold: true))) as List;
    expect(out, [
      {'family': kCjkFontFamily, 'fonts': [{'asset': kCjkFontAssetRel}, {'asset': kCjkFontBoldAssetRel, 'weight': 700}]},
    ]);
  });

  test('入库的粗体:TTF、OS/2 字重 700,两档体积与常规相当', () async {
    final root = await resolvePackageRoot();
    int weight(List<int> b) {
      final d = ByteData.sublistView(Uint8List.fromList(b));
      for (var i = 0; i < d.getUint16(4); i++) {
        final rec = 12 + i * 16;
        if (String.fromCharCodes(b.sublist(rec, rec + 4)) == 'OS/2') return d.getUint16(d.getUint32(rec + 8) + 4);
      }
      return -1;
    }

    for (final level in ['level1', 'full']) {
      final bold = readCjkFont(root, level: level, bold: true);
      final regular = readCjkFont(root, level: level);
      expect(bold.sublist(0, 4), [0, 1, 0, 0]);
      expect(weight(bold), 700, reason: level);
      expect(weight(regular), 400, reason: level);
      expect(bold.length, inInclusiveRange(regular.length * 0.9, regular.length * 1.1));
    }
  });

  test('resolveCjkBoldLevel:默认跟随 cjk_font;必须同档;常规关闭时不能单要粗体', () {
    expect(resolveCjkBoldLevel('full', null), 'full');
    expect(resolveCjkBoldLevel('level1', null), 'level1');
    expect(resolveCjkBoldLevel(null, null), isNull);
    expect(resolveCjkBoldLevel('full', 'false'), isNull);
    expect(resolveCjkBoldLevel(null, 'false'), isNull);
    expect(resolveCjkBoldLevel('level1', 'level1'), 'level1');
    expect(() => resolveCjkBoldLevel('full', 'level1'),
        throwsA(isA<ArgumentError>().having((e) => e.message, 'message', contains('豆腐块'))));
    expect(() => resolveCjkBoldLevel('level1', 'full'), throwsArgumentError);
    expect(() => resolveCjkBoldLevel(null, 'full'), throwsArgumentError);
    expect(() => resolveCjkBoldLevel('full', 'level2'), throwsArgumentError);
  });

  test('找不到字体文件时给出可操作的错误', () {
    final dir = Directory.systemTemp.createTempSync('mpf_cjk_');
    addTearDown(() => dir.deleteSync(recursive: true));
    expect(() => readCjkFont(dir.path),
        throwsA(isA<StateError>().having((e) => e.message, 'message', contains('cjk_font: false'))));
  });
}
