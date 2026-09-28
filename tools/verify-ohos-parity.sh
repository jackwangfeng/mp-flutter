#!/usr/bin/env bash
# 比对 stable 与 flutter_ohos 的 web 产物形状是否一致
#
# 注 1(grep -c 修正):brief 原始版本里，"出现次数" 类检查有的用 `grep -c`、
# 有的用 `grep -o ... | wc -l`。BSD grep 的 `-c` 计的是"匹配行数"而非
# "匹配次数"，而 main.dart.js / canvaskit.js 都是压缩产物（几乎全文件一行或
# 极少行），这会让 `-c` 恒等于 0 或 1，比对失去区分度。本脚本把所有
# "出现次数"类检查统一改为 `grep -o <pattern> <file> | wc -l`，用真实出现
# 次数比对。
#
# 注 2(diff 劫持,重要,不要"顺手简化"回裸 diff):本机 PATH 里
# `/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains`
# 排在 /usr/bin 前面，其中有个同名的 `diff` 二进制——那不是 GNU/BSD diff，
# 而是 OpenHarmony 工具链自带的一个东西，对内容不同的两个文件**静默返回
# 退出码 0 且不打印任何内容**，会让"文件清单是否一致"这类检查恒为通过、
# 完全失去区分度。本脚本因此：
#   - 判断"是否一致"一律用 `cmp -s`(退出码语义可靠，不受 PATH 影响，
#     /usr/bin/cmp 在本机没有被同目录下的同名文件劫持)
#   - 需要打印具体差异时一律显式写绝对路径 `/usr/bin/diff`，禁止裸写 `diff`
# 本机同时确认 `shasum`、`find`、`sort`、`wc` 都解析到 /usr/bin/*，未被该
# toolchains 目录劫持,只有 diff 中招。
#
# 注 3(构建失败闸门,重要):`build()` 以前用 `>/dev/null 2>&1` 吞掉了
# `flutter create` / `flutter build web` 的 stdout/stderr 和退出码,后面也没
# 有任何地方检查 $S/$O 底下是否真的有产物。这意味着如果两边构建**同时失败**
# (工具链损坏、环境变了等),`occurrences()` 的 "N/A(no file)" 兜底值会两边
# 都一样、`canvaskit.wasm sha256` 两边都是空字符串、`cmp -s` 比较两份空文件
# 清单——脚本会全绿退出 0,看起来"完全一致",实际是压根没构建成功。这跟这次
# 任务本身被"劫持的 diff 静默返回 0"坑过是同一类陷阱,所以现在:
#   - 不再吞 stderr:`flutter create`/`flutter build web` 的输出被记到日志
#     文件,失败时把日志内容打到 stderr
#   - 检查真实退出码,非零立即失败
#   - 检查关键产物文件存在且非空(`main.dart.js`、`canvaskit.js`、
#     `canvaskit.wasm`),即使命令退出码是 0 也要有真产物
#   - 构建阶段失败用 **exit 2**,和"构建成功但比对出差异"的 exit 1 区分开,
#     调用方能分辨"没比成"还是"比出了不一致"
set -uo pipefail
STABLE=~/development/flutter/bin/flutter
OHOS=~/development/flutter_ohos/bin/flutter
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# 退出码约定:
#   0 = 构建成功,全部形状检查通过(一致)
#   1 = 构建成功,但至少一项形状检查失配(不一致)
#   2 = 构建阶段本身失败(create/build 出错,或产物缺失/为空)——
#       比对结果没有意义,不要当成"1"来解读

build() {   # $1=flutter bin  $2=outdir  $3=日志标签
  local bin=$1 dir=$2 label=$3
  local proj="$WORK/$dir"
  local create_log="$WORK/${dir}_create.log"
  local build_log="$WORK/${dir}_build.log"

  "$bin" create --platforms=web --project-name parity_probe "$proj" >"$create_log" 2>&1
  local rc=$?
  if [ $rc -ne 0 ]; then
    echo "!! [$label] flutter create 失败,退出码 $rc,输出:" >&2
    cat "$create_log" >&2
    return 1
  fi

  (cd "$proj" && "$bin" build web --release >"$build_log" 2>&1)
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "!! [$label] flutter build web 失败,退出码 $rc,输出:" >&2
    cat "$build_log" >&2
    return 1
  fi

  local out="$proj/build/web"
  local f
  for f in main.dart.js canvaskit/canvaskit.js canvaskit/canvaskit.wasm; do
    if [ ! -s "$out/$f" ]; then
      echo "!! [$label] flutter build web 退出码是 0,但关键产物缺失或为空: $out/$f" >&2
      return 1
    fi
  done

  echo "$out"
}

echo "== 构建 stable =="
S=$(build "$STABLE" s stable) || { echo "构建阶段失败(stable),脚本退出码 2" >&2; exit 2; }
echo "== 构建 ohos   =="
O=$(build "$OHOS" o ohos) || { echo "构建阶段失败(ohos),脚本退出码 2" >&2; exit 2; }

fail=0
check() {   # $1=描述 $2=stable值 $3=ohos值
  if [ "$2" = "$3" ]; then printf "  ✓ %-38s %s\n" "$1" "$2"
  else printf "  ✗ %-38s stable=%s ohos=%s\n" "$1" "$2" "$3"; fail=1; fi
}

occurrences() { # $1=pattern $2=file ; 真实出现次数（非行数）
  if [ -f "$2" ]; then grep -o -- "$1" "$2" 2>/dev/null | wc -l | tr -d ' '; else echo "N/A(no file)"; fi
}

echo "== 关键形状比对 =="
# 握手入口:变换器与 boot.js 依赖它
check "didCreateEngineInitializer 出现次数" \
  "$(occurrences 'didCreateEngineInitializer' "$S/main.dart.js")" \
  "$(occurrences 'didCreateEngineInitializer' "$O/main.dart.js")"
# CanvasKit 注入点
check "flutterCanvasKit 出现次数" \
  "$(occurrences 'flutterCanvasKit' "$S/main.dart.js")" \
  "$(occurrences 'flutterCanvasKit' "$O/main.dart.js")"
# canvaskit.js 的两处补丁点
check "canvaskit.js 含 import.meta 次数" \
  "$(occurrences 'import\.meta' "$S/canvaskit/canvaskit.js")" \
  "$(occurrences 'import\.meta' "$O/canvaskit/canvaskit.js")"
check "canvaskit.js 含 Safari workaround 次数" \
  "$(occurrences 'instanceof WebGLRenderingContext' "$S/canvaskit/canvaskit.js")" \
  "$(occurrences 'instanceof WebGLRenderingContext' "$O/canvaskit/canvaskit.js")"
# instantiateWasm 钩子
check "含 instantiateWasm 钩子次数" \
  "$(occurrences 'instantiateWasm' "$S/canvaskit/canvaskit.js")" \
  "$(occurrences 'instantiateWasm' "$O/canvaskit/canvaskit.js")"
# wasm 二进制是否逐字节相同(相同则可共用同一份分包资源)
check "canvaskit.wasm sha256" \
  "$(shasum -a 256 "$S/canvaskit/canvaskit.wasm" 2>/dev/null | cut -c1-16)" \
  "$(shasum -a 256 "$O/canvaskit/canvaskit.wasm" 2>/dev/null | cut -c1-16)"

echo
echo "== 产物文件清单差异 =="
LIST_S="$WORK/filelist_s.txt"
LIST_O="$WORK/filelist_o.txt"
(cd "$S" && find . -type f | sort) > "$LIST_S"
(cd "$O" && find . -type f | sort) > "$LIST_O"
if cmp -s "$LIST_S" "$LIST_O"; then
  echo "  ✓ 文件清单一致"
else
  fail=1
  echo "  ✗ 文件清单不一致:"
  /usr/bin/diff "$LIST_S" "$LIST_O"
fi

exit $fail
