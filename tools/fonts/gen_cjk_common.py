#!/usr/bin/env python3
"""生成 mp-flutter 随包分发的"常用汉字合一字体"。

产物(已入库,用户构建时不需要 Python):
  packages/mp_flutter/fonts/NotoSansSC-GB2312-L1.ttf   level1:GB2312 一级(默认)
  packages/mp_flutter/fonts/NotoSansSC-GB2312.ttf      full:一级 + 二级
只有想重新生成(换字符集、换源字体版本)时才跑本脚本:

    pip install fonttools==4.62.1
    python3 tools/fonts/gen_cjk_common.py

来源:Google Fonts 的 Noto Sans SC v37 Regular 完整 TTF(与 Flutter 3.41.9 引擎回退表里
notosanssc/v37 分片同一版本,字形逐点一致;SIL Open Font License 1.1,许可证全文见
packages/mp_flutter/fonts/OFL.txt,另见仓库 NOTICE)。
下载后按 SHA-256 校验,版本不对直接失败。

字符集:
  · GB2312 一级汉字 3755(level1);full 再加二级汉字 3008(如 昵/浏/渲);
  · GB2312 第 1–3 区符号(中文标点、序号、全角 ASCII);
  · ASCII 0x20–0x7E、Latin-1 补充 U+00A0–00FF(¥ × ÷ ° ± · 等,价格/数量里天天见)、
    CJK 符号与标点 U+3000–303F、全角 ASCII U+FF01–FF5E 与全角货币 U+FFE0–FFE6;
  · 常用符号(真机数据:回退分片 fontFallbackData 解出的 slice 里,除生僻假名/拼音
    附标外,常混有这类符号,单独一片也要整片下载):通用标点全块 U+2000–206F(破折号/
    省略号/引号/‹›/千分号等)、箭头全块 U+2190–21FF、€℃№™、常用数学运算符
    ∑√∞∫≈≠≤≥、带圈数字 ①–⑳(U+2460–2473)、制表符小集合(┌┐└┘├┤┬┴┼─│)、
    几何图形/五角星(●○■□▲△▼▽◆◇★☆)。

格式选 TTF 而不是 woff2:woff2 每次建 FreeType face 都要整份 brotli 解压 + 重建 glyf,
CanvasKit 里一份 2MB 的 woff2 在 node(JIT)上约 18ms/次,iOS 小程序(无 JIT)估计要
二三百毫秒且一次启动会解好几次;TTF 直接建 face,约 0.2ms。代价是包体积(woff2 976KB,
TTF 2.1MB)。去掉 hinting 与排版表(GSUB/GPOS/vmtx 等):横排中文用不上,字形不变。

输出是确定的(不写当前时间戳),同样输入每次得到同样字节。
"""
import hashlib
import os
import sys
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

SRC_URL = 'https://fonts.gstatic.com/s/notosanssc/v37/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYxNavzT.ttf'
SRC_SHA256 = '2556422841d76fd6dbb9461d16ca48fd75c6961bdfa9d73682b367c36abf7084'

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FONT_DIR = os.path.join(ROOT, 'packages', 'mp_flutter', 'fonts')
# 两档:level1 = GB2312 一级 3755 字(默认);full = 一级 + 二级 6763 字
OUTS = {
    'level1': os.path.join(FONT_DIR, 'NotoSansSC-GB2312-L1.ttf'),
    'full': os.path.join(FONT_DIR, 'NotoSansSC-GB2312.ttf'),
}
CACHE = os.path.join(os.path.expanduser(os.environ.get('XDG_CACHE_HOME', '~/.cache')),
                     'mp_flutter', 'fonts', 'NotoSansSC-v37-full.ttf')


def gb2312_rows(rows):
    out = []
    for r in rows:
        for c in range(0xA1, 0xFF):
            try:
                out.append(bytes([0xA0 + r, c]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    return out


def charset(level):
    chars = set(gb2312_rows(range(16, 56)))      # 一级 3755
    if level == 'full':
        chars |= set(gb2312_rows(range(56, 88)))  # 二级 3008
    chars |= set(gb2312_rows(range(1, 4)))       # 符号、序号、全角
    cps = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + list(range(0x3000, 0x3040)) \
        + list(range(0xFF01, 0xFF5F)) + list(range(0xFFE0, 0xFFE7)) \
        + list(range(0x2000, 0x2070))  # 通用标点全块(破折号/省略号/引号/千分号/‹›等,含旧版单列的几个)
    cps += list(range(0x2190, 0x2200))  # 箭头全块(← ↑ → ↓ ↔ ⇒ 等)
    cps += [0x20AC, 0x2103, 0x2116, 0x2122]  # € ℃ № ™(货币/letterlike,不在通用标点块里)
    cps += [0x2211, 0x221A, 0x221E, 0x222B, 0x2248, 0x2260, 0x2264, 0x2265]  # 常用数学运算符 ∑ √ ∞ ∫ ≈ ≠ ≤ ≥
    cps += list(range(0x2460, 0x2474))  # 带圈数字 ①–⑳
    cps += [0x2500, 0x2502, 0x250C, 0x2510, 0x2514, 0x2518, 0x251C, 0x2524, 0x252C, 0x2534, 0x253C]  # 制表符(小集合,常见表格分隔线)
    cps += [0x25A0, 0x25A1, 0x25B2, 0x25B3, 0x25BC, 0x25BD, 0x25C6, 0x25C7, 0x25CB, 0x25CF, 0x2605, 0x2606]  # 几何图形/五角星(●○■□▲△▼▽◆◇★☆)
    chars |= {chr(c) for c in cps}
    return sorted(ord(c) for c in chars)


def source_font():
    if not os.path.exists(CACHE):
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        print('下载 ' + SRC_URL)
        with urllib.request.urlopen(SRC_URL, timeout=120) as r:
            data = r.read()
        tmp = CACHE + '.part'
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, CACHE)
    data = open(CACHE, 'rb').read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SRC_SHA256:
        sys.exit('源字体 SHA-256 不符(%s),删除 %s 后重试;若上游换了文件请核对版本后更新 SRC_SHA256' % (digest, CACHE))
    return CACHE


def build(src, level, out):
    cps = charset(level)
    opts = subset.Options()
    opts.hinting = False
    opts.layout_features = []
    opts.drop_tables += ['GSUB', 'GPOS', 'GDEF', 'BASE', 'vhea', 'vmtx', 'STAT', 'DSIG']
    opts.name_IDs = ['*']
    opts.name_languages = ['*']
    opts.notdef_outline = True
    font = TTFont(src, recalcTimestamp=False)
    s = subset.Subsetter(opts)
    s.populate(unicodes=cps)
    s.subset(font)
    # OFL 要求随字体附许可声明:写进 name 表(ID 13 许可说明,ID 14 已是许可 URL),
    # 完整许可证文本在 packages/mp_flutter/fonts/OFL.txt
    font['name'].setName('This Font Software is licensed under the SIL Open Font License, Version 1.1. '
                         'This license is available with a FAQ at: https://openfontlicense.org', 13, 3, 1, 0x409)
    missing = [c for c in cps if c not in font.getBestCmap()]
    if missing:
        print('源字体缺 %d 个码点(忽略): %s' % (len(missing), ''.join(chr(c) for c in missing[:40])))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    font.save(out)
    data = open(out, 'rb').read()
    print('%-6s %s  %d 字节  %d 个码点  sha256=%s' % (level, out, len(data), len(font.getBestCmap()),
                                                 hashlib.sha256(data).hexdigest()))


def main():
    src = source_font()
    for level, out in OUTS.items():
        build(src, level, out)


if __name__ == '__main__':
    main()
