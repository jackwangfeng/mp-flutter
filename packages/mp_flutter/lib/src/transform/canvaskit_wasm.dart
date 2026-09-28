import 'dart:convert';
import 'dart:typed_data';

import 'canvaskit_js.dart' show TransformFailure;

/// 完整版 CanvasKit 的 wasm 瘦身:清零内嵌 ICU 数据里的断词词典。
///
/// 为什么用完整版(`canvaskit/canvaskit.wasm`,自带 ICU)而不是 chromium 版
/// (`canvaskit/chromium/`,不带 ICU):chromium 版把断字/断词/换行交给 JS 侧,
/// 引擎用 `Intl.Segmenter` 与 V8 独有的 `Intl.v8BreakIterator` 来算
/// (engine/.../text_fragmenter.dart)。iOS 小程序跑在 JavaScriptCore 上,没有
/// v8BreakIterator,首次排版即抛 `UnimplementedError`,白屏;部分安卓微信的
/// JS 引擎连 `Intl` 都没有。完整版在 wasm 里用自带 ICU 断行,不依赖任何 Intl API。
///
/// 为什么要瘦身:完整版 wasm brotli 后约 2175KB,超过单个分包 2048KB 的上限;
/// 又不能切成几个分包拼接 —— `WXWebAssembly.instantiate` 只接受代码包内的单个
/// 文件路径,代码包里的二进制文件也读不出来(见 docs/architecture.md)。
/// ICU 数据里占大头的是泰/老/高棉/缅文的断词词典(`brkitr/*.dict`,共约
/// 515KB),清零后 brotli 约 1822KB。
///
/// 清零而不是删除:ICU 公共数据按目录表(TOC)偏移寻址,内容置零不改变任何
/// 偏移,wasm 结构也原封不动(只改数据段里的字节),零字节在 brotli 里几乎
/// 不占体积。ICU 打开这些条目时校验数据头魔数失败,按"数据不存在"处理
/// (udata.cpp checkDataItem 设非致命错误),于是这几种文字没有词典引擎,
/// 词内不再给换行机会(仍在空格处换行,整词放不下时 SkParagraph 按字形强制
/// 断开)。中文、日文、韩文、拉丁文等的换行规则(`*.brk`)原样保留,不受影响。
///
/// 结构不符合预期(不是 wasm、找不到 ICU 数据、词典是最后一个条目等)一律抛
/// [TransformFailure],不静默产出未瘦身的文件 —— 那样会在体积校验时才以
/// "分包超限"的形式报错,指向完全无关的地方。
({Uint8List bytes, List<String> removed, int zeroedBytes}) stripIcuDictionaries(Uint8List wasm) {
  final segments = _dataSegments(wasm);
  final memory = _memoryImage(wasm, segments);
  final icu = _findIcuCommonData(memory);
  if (icu == null) {
    throw const TransformFailure(
      'canvaskit.wasm 里找不到 ICU 公共数据',
      '只有完整版 CanvasKit(canvaskit/canvaskit.wasm)内嵌 ICU;是否误用了 chromium 版?',
    );
  }

  final out = Uint8List.fromList(wasm);
  final removed = <String>[];
  var zeroed = 0;
  for (var i = 0; i < icu.length; i++) {
    final item = icu[i];
    if (!_isDictionary(item.name)) continue;
    if (i + 1 >= icu.length) {
      throw TransformFailure('ICU 词典 ${item.name} 是目录表最后一项',
          '无法确定它的长度(靠下一项的偏移算),ICU 数据布局可能变了。');
    }
    final lo = item.address, hi = icu[i + 1].address;
    if (hi <= lo) {
      throw TransformFailure('ICU 目录表偏移不递增(${item.name})', 'ICU 数据布局可能变了。');
    }
    for (final s in segments) {
      final start = lo > s.address ? lo : s.address;
      final end = hi < s.address + s.length ? hi : s.address + s.length;
      if (start < end) {
        out.fillRange(s.fileOffset + (start - s.address), s.fileOffset + (end - s.address), 0);
      }
    }
    removed.add(item.name);
    zeroed += hi - lo;
  }
  return (bytes: out, removed: removed, zeroedBytes: zeroed);
}

/// ICU 断词词典:`<包名>/brkitr/<名字>.dict`(thaidict/laodict/khmerdict/burmesedict,
/// 将来若带上 cjdict 也一样清零 —— 中日文没有词典时按 `*.brk` 规则逐字可断,
/// 与现在 Flutter 自带的 ICU 数据一致)。
bool _isDictionary(String name) => name.contains('/brkitr/') && name.endsWith('.dict');

class _Segment {
  final int address;   // 线性内存地址
  final int length;
  final int fileOffset;   // 段内容在 wasm 文件里的起点
  const _Segment(this.address, this.length, this.fileOffset);
}

class _IcuItem {
  final String name;
  final int address;   // 条目内容的线性内存地址
  const _IcuItem(this.name, this.address);
}

/// 顺序读 LEB128 的游标。
class _Reader {
  final Uint8List b;
  int pos;
  _Reader(this.b, this.pos);

  int byte() => b[pos++];

  int uleb() {
    var result = 0, shift = 0;
    while (true) {
      final x = b[pos++];
      result |= (x & 0x7f) << shift;
      shift += 7;
      if (x < 0x80) return result;
    }
  }

  int sleb() {
    var result = 0, shift = 0;
    while (true) {
      final x = b[pos++];
      result |= (x & 0x7f) << shift;
      shift += 7;
      if (x < 0x80) {
        if (x & 0x40 != 0) result -= 1 << shift;
        return result;
      }
    }
  }
}

/// 解析数据段(section 11)。只接受活动段 + `i32.const` 偏移(emscripten 的产物);
/// 被动段(flag 1)没有固定地址,出现就报错 —— 这时"按地址清零"不成立。
List<_Segment> _dataSegments(Uint8List b) {
  if (b.length < 8 || b[0] != 0 || b[1] != 0x61 || b[2] != 0x73 || b[3] != 0x6d || b[4] != 1) {
    throw const TransformFailure('canvaskit.wasm 不是 wasm v1 文件', '文件头不是 \\0asm 01。');
  }
  final r = _Reader(b, 8);
  final segments = <_Segment>[];
  while (r.pos < b.length) {
    final id = r.byte();
    final size = r.uleb();
    final next = r.pos + size;
    if (id == 11) {
      final count = r.uleb();
      for (var i = 0; i < count; i++) {
        final flags = r.uleb();
        if (flags == 2) r.uleb();   // 显式内存索引
        if (flags != 0 && flags != 2) {
          throw TransformFailure('canvaskit.wasm 含被动数据段(flags=$flags)', '按地址清零 ICU 词典的前提不成立。');
        }
        if (r.byte() != 0x41) {
          throw const TransformFailure('canvaskit.wasm 数据段偏移不是 i32.const', '数据段结构不是预期的 emscripten 产物。');
        }
        final address = r.sleb();
        if (r.byte() != 0x0b) {
          throw const TransformFailure('canvaskit.wasm 数据段偏移表达式未以 end 结束', '数据段结构不是预期的 emscripten 产物。');
        }
        final length = r.uleb();
        segments.add(_Segment(address, length, r.pos));
        r.pos += length;
      }
    }
    r.pos = next;
  }
  return segments;
}

Uint8List _memoryImage(Uint8List b, List<_Segment> segments) {
  var top = 0;
  for (final s in segments) {
    if (s.address + s.length > top) top = s.address + s.length;
  }
  final memory = Uint8List(top);
  for (final s in segments) {
    memory.setRange(s.address, s.address + s.length, b, s.fileOffset);
  }
  return memory;
}

/// 在线性内存里找 ICU 公共数据(小端、dataFormat "CmnD"),返回目录表条目。
///
/// 布局(ICU udata.h / ucmndata.h):DataHeader{ headerSize:u16, magic 0xda 0x27,
/// UDataInfo{ size:u16, reserved:u16, isBigEndian:u8, charsetFamily:u8,
/// sizeofUChar:u8, reserved:u8, dataFormat[4], ... } } 之后是
/// TOC{ count:u32, entries[count]{ nameOffset:u32, dataOffset:u32 } },两个偏移都相对 TOC 起点。
List<_IcuItem>? _findIcuCommonData(Uint8List m) {
  final data = ByteData.sublistView(m);
  for (var i = 12; i + 4 <= m.length; i++) {
    if (m[i] != 0x43 || m[i + 1] != 0x6d || m[i + 2] != 0x6e || m[i + 3] != 0x44) continue;   // "CmnD"
    final h = i - 12;
    if (m[h + 2] != 0xda || m[h + 3] != 0x27 || m[h + 8] != 0) continue;   // 魔数 + 小端
    final headerSize = data.getUint16(h, Endian.little);
    final toc = h + headerSize;
    final count = data.getUint32(toc, Endian.little);
    if (count == 0 || toc + 4 + count * 8 > m.length) continue;
    final items = <_IcuItem>[];
    for (var k = 0; k < count; k++) {
      final nameOffset = data.getUint32(toc + 4 + k * 8, Endian.little);
      final dataOffset = data.getUint32(toc + 8 + k * 8, Endian.little);
      var end = toc + nameOffset;
      while (end < m.length && m[end] != 0) {
        end++;
      }
      items.add(_IcuItem(ascii.decode(m.sublist(toc + nameOffset, end), allowInvalid: true), toc + dataOffset));
    }
    return items;
  }
  return null;
}
