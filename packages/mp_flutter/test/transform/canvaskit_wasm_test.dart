import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;
import 'package:test/test.dart';
import 'package:mp_flutter/src/size_check.dart';
import 'package:mp_flutter/src/transform/canvaskit_js.dart' show TransformFailure;
import 'package:mp_flutter/src/transform/canvaskit_wasm.dart';

List<int> _uleb(int v) {
  final out = <int>[];
  do {
    var b = v & 0x7f;
    v >>= 7;
    if (v != 0) b |= 0x80;
    out.add(b);
  } while (v != 0);
  return out;
}

List<int> _sleb(int v) {
  final out = <int>[];
  while (true) {
    final b = v & 0x7f;
    v >>= 7;
    final done = (v == 0 && b & 0x40 == 0) || (v == -1 && b & 0x40 != 0);
    out.add(done ? b : b | 0x80);
    if (done) return out;
  }
}

/// 造一段 ICU 公共数据(小端,"CmnD"),条目内容为 [items] 的字节。
Uint8List _icuCommonData(List<(String, List<int>)> items) {
  const headerSize = 32;
  final names = BytesBuilder();
  final nameOffsets = <int>[];
  final tocSize = 4 + items.length * 8;
  for (final (name, _) in items) {
    nameOffsets.add(tocSize + names.length);
    names.add([...ascii.encode(name), 0]);
  }
  while ((tocSize + names.length) % 16 != 0) {
    names.addByte(0);
  }
  final dataStart = tocSize + names.length;
  final dataOffsets = <int>[];
  final body = BytesBuilder();
  for (final (_, bytes) in items) {
    dataOffsets.add(dataStart + body.length);
    body.add(bytes);
  }
  final header = ByteData(headerSize)
    ..setUint16(0, headerSize, Endian.little)
    ..setUint8(2, 0xda)
    ..setUint8(3, 0x27)
    ..setUint16(4, 20, Endian.little)
    ..setUint8(8, 0)   // 小端
    ..setUint8(9, 0)
    ..setUint8(10, 2);
  final hb = header.buffer.asUint8List();
  hb.setRange(12, 16, ascii.encode('CmnD'));
  final toc = ByteData(tocSize)..setUint32(0, items.length, Endian.little);
  for (var i = 0; i < items.length; i++) {
    toc
      ..setUint32(4 + i * 8, nameOffsets[i], Endian.little)
      ..setUint32(8 + i * 8, dataOffsets[i], Endian.little);
  }
  return (BytesBuilder()
        ..add(hb)
        ..add(toc.buffer.asUint8List())
        ..add(names.takeBytes())
        ..add(body.takeBytes()))
      .takeBytes();
}

/// 把 [memory] 从地址 [base] 起切成若干活动数据段(在 [cuts] 处切开),造一个 wasm。
Uint8List _wasmWithData(Uint8List memory, int base, List<int> cuts) {
  final bounds = [0, ...cuts, memory.length];
  final section = BytesBuilder()..add(_uleb(bounds.length - 1));
  for (var i = 0; i + 1 < bounds.length; i++) {
    final seg = memory.sublist(bounds[i], bounds[i + 1]);
    section
      ..add([0, 0x41, ..._sleb(base + bounds[i]), 0x0b])
      ..add(_uleb(seg.length))
      ..add(seg);
  }
  final sec = section.takeBytes();
  return (BytesBuilder()
        ..add([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
        ..add([5, 3, 1, 0, 1])   // memory section:min 1 页
        ..addByte(11)
        ..add(_uleb(sec.length))
        ..add(sec))
      .takeBytes();
}

void main() {
  final brk = List<int>.generate(64, (i) => 0x10 + i % 7);
  final dict = List<int>.generate(96, (i) => 0x80 + i % 13);
  final nrm = List<int>.generate(48, (i) => 0x40 + i % 5);
  final icu = _icuCommonData([
    ('icudt77l/brkitr/line_normal.brk', brk),
    ('icudt77l/brkitr/thaidict.dict', dict),
    ('icudt77l/nfkc.nrm', nrm),
  ]);
  // ICU 数据前面垫一段别的数据;数据段在词典中间切开,验证跨段清零
  final memory = Uint8List.fromList([...List.filled(40, 0x77), ...icu]);
  final dictStart = 40 + icu.length - nrm.length - dict.length;

  test('清零 brkitr/*.dict 的内容(跨数据段),其余字节原样不动', () {
    final wasm = _wasmWithData(memory, 1024, [dictStart + 30]);
    final r = stripIcuDictionaries(wasm);
    expect(r.removed, ['icudt77l/brkitr/thaidict.dict']);
    expect(r.zeroedBytes, dict.length);
    expect(r.bytes.length, wasm.length, reason: 'wasm 结构不变,只改数据段字节');
    // 逐字节比较:差异恰好是词典内容那 96 个非零字节
    var changed = 0;
    for (var i = 0; i < wasm.length; i++) {
      if (wasm[i] != r.bytes[i]) {
        expect(r.bytes[i], 0);
        changed++;
      }
    }
    expect(changed, dict.length);
    // 再跑一遍:目录表与其它条目完好,仍能找到 ICU 数据,词典已是零
    final again = stripIcuDictionaries(r.bytes);
    expect(again.removed, ['icudt77l/brkitr/thaidict.dict']);
    expect(again.bytes, r.bytes);
  });

  test('不是 wasm:抛 TransformFailure', () {
    expect(() => stripIcuDictionaries(Uint8List.fromList(utf8.encode('not wasm'))),
        throwsA(isA<TransformFailure>()));
  });

  test('找不到 ICU 数据(误用 chromium 版):抛 TransformFailure', () {
    final wasm = _wasmWithData(Uint8List.fromList(List.filled(256, 0x55)), 1024, []);
    expect(() => stripIcuDictionaries(wasm),
        throwsA(isA<TransformFailure>().having((e) => e.message, 'message', contains('ICU'))));
  });

  test('词典是目录表最后一项(无法确定长度):抛 TransformFailure', () {
    final tail = _icuCommonData([
      ('icudt77l/brkitr/line_normal.brk', brk),
      ('icudt77l/brkitr/thaidict.dict', dict),
    ]);
    expect(() => stripIcuDictionaries(_wasmWithData(tail, 1024, [])), throwsA(isA<TransformFailure>()));
  });

  // 真 SDK 产物:本机装了 Flutter 3.41.9 才跑。锁住"完整版瘦身后能放进单个分包"。
  final sdkWasm = File(p.join(Platform.environment['HOME'] ?? '',
      'development/flutter/bin/cache/flutter_web_sdk/canvaskit/canvaskit.wasm'));
  test('真 SDK 的完整版 canvaskit.wasm:清零 4 部词典,brotli 后放得进单个分包', () {
    final r = stripIcuDictionaries(sdkWasm.readAsBytesSync());
    expect(r.removed.map((n) => n.split('/').last).toSet(),
        {'burmesedict.dict', 'khmerdict.dict', 'laodict.dict', 'thaidict.dict'});
    final dir = Directory.systemTemp.createTempSync('mpf_ckwasm_');
    addTearDown(() => dir.deleteSync(recursive: true));
    final f = File(p.join(dir.path, 'ck.wasm'))..writeAsBytesSync(r.bytes);
    final br = Process.runSync('brotli', ['-q', '11', '-f', f.path, '-o', '${f.path}.br']);
    expect(br.exitCode, 0, reason: '${br.stderr}');
    final size = File('${f.path}.br').lengthSync();
    // 分包里还有就位探针等几百字节,留 64KB 余量
    expect(size, lessThan(kPackageLimitBytes - 64 * 1024), reason: 'brotli 后 $size 字节');
  }, skip: sdkWasm.existsSync() ? false : '本机没有 Flutter SDK 的 canvaskit.wasm');
}
