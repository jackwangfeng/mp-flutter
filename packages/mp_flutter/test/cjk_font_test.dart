import 'dart:convert';
import 'dart:io';

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

  test('找不到字体文件时给出可操作的错误', () {
    final dir = Directory.systemTemp.createTempSync('mpf_cjk_');
    addTearDown(() => dir.deleteSync(recursive: true));
    expect(() => readCjkFont(dir.path),
        throwsA(isA<StateError>().having((e) => e.message, 'message', contains('cjk_font: false'))));
  });
}
