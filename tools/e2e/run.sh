#!/usr/bin/env bash
# 一键跑 E2E 验收:构建对应验收工程 → 跑对应 accept-*.js 脚本 → 汇总。
#
#   tools/e2e/run.sh <config> [script...]
#
# config:
#   stable  - 用默认(自动探测)的 flutter 稳定版构建
#   android - 同 stable,额外传 --force-platform android(仍用真机原生组件几何)
#   ios     - 同 stable,额外传 --force-platform ios:垫片遮蔽 Intl.v8BreakIterator
#             与 Intl.Segmenter,模拟 iOS 真机的 JavaScriptCore
#   android-noIntl - 同 stable,额外传 --force-platform android-noIntl:垫片把
#             Intl 整个遮蔽掉,模拟没有 Intl 的安卓真机 JS 引擎
#   ohos    - 用 flutter_ohos 构建,flutter 二进制取环境变量 FLUTTER_OHOS
#             (未设置则报错退出,不静默回退到别的 flutter)
#
# script 缺省 = 全部(accept.js accept-interact.js accept-net.js accept-wx.js
# accept-pv.js)。也可以传一个或多个具体脚本名(不带路径),例如:
#   tools/e2e/run.sh ohos accept.js
#   tools/e2e/run.sh android accept-pv.js
#
# appid 取环境变量 MP_APPID,缺省 touristappid。
#
# 每个脚本:构建对应验收工程 → 产物落 tools/e2e/out/<app>-<config> → 跑脚本
# 断言。已知偶发(一次运行里小程序在开发者工具里被启动两次,导致断言看到脏
# 状态)——脚本失败时自动重跑一次(只重跑脚本,不重新构建),两次都失败才算
# 真失败。最后打印汇总行,每个 (脚本, config) 一行 PASS/FAIL;只要有一个
# FAIL,整体以非零退出码结束。
#
# 单脚本超时(2026-09-27 实测:accept-net.js 在 `await server.close()` 上挂住
# 近 4 小时,run.sh 跟着挂死——根因是 test-server.js 的 keep-alive socket 不
# 会自己断,已在 test-server.js 修复;这里再加一层兜底,不管以后是不是还会
# 冒出别的挂死原因):每次 `node accept-*.js` 调用(含重跑那次)都限时
# E2E_SCRIPT_TIMEOUT 秒(默认 360 = 6 分钟),超时就杀掉整棵子进程树、按失败
# 处理,然后继续跑下一个脚本,不让一个卡住的脚本拖死整次 run。
# 注:不用 set -u —— 本机 /usr/bin/env bash 解析到系统自带的 bash 3.2(macOS
# 从不升级自带 bash),3.2 下 set -u 加空数组的 "${arr[@]}" 展开会误报
# "unbound variable"(4.4+ 才修好这个边角情况),FLUTTER_BIN_ARGS/
# FORCE_PLATFORM_ARGS 在 stable config 下就是空数组,踩得上。改为在每处用到
# 环境变量的地方显式 `${VAR:-}` 兜底,不整体依赖 -u。
set -o pipefail

# 双 SDK 机器上的坑(M7,与 tools/ci/check.sh 做法一致):`flutter`/`dart`
# 官方启动脚本会把 FLUTTER_ROOT export 出来,子进程继承。如果调用本脚本的
# 外层 shell 之前用别的 SDK(比如 flutter_ohos fork)跑过 flutter/dart 命令,
# FLUTTER_ROOT 会残留指向那个 fork——下面每个 `dart run mp_flutter` 调用即便
# 传了正确的 --flutter,子进程内部 pub 解析 package:flutter 源码时仍可能优先
# 信这个环境变量。显式 unset 以绝后患(mp_flutter 自身调 flutter 子进程时也
# 会再 unset 一次,见 flutter_build.dart,这里是双保险)。
unset FLUTTER_ROOT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APPS_DIR="$SCRIPT_DIR/apps"
OUT_DIR="$SCRIPT_DIR/out"
MP_FLUTTER_BIN="$REPO_ROOT/packages/mp_flutter/bin/mp_flutter.dart"

APPID="${MP_APPID:-touristappid}"
SCRIPT_TIMEOUT="${E2E_SCRIPT_TIMEOUT:-360}"   # 秒;单次 node accept-*.js 调用的超时

# 递归杀掉 $1 的整棵子进程树(不含自身),再杀 $1 自身。macOS 系统自带的 bash
# 是 3.2、没有 GNU coreutils 的 `timeout`/`gtimeout`,只能自己拼:非交互式
# shell 下后台任务不会自动进新 pgid,不能靠 `kill -- -$pgid`,改用
# `pgrep -P` 逐层找子进程。
kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null
}

# run_with_timeout <超时秒数> <命令...>:后台跑命令,轮询是否结束;超时就
# kill_tree 整棵子树(先 TERM,给 2s 收尾,还活着再 KILL),返回 124。命令
# 自身的 stdout/stderr 直接透传,不吞。
run_with_timeout() {
  local timeout_secs="$1"; shift
  "$@" &
  local pid=$!
  local waited=0
  local interval=2
  while true; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      return $?
    fi
    if [ "$waited" -ge "$timeout_secs" ]; then
      echo "⏱️  [timeout] 超过 ${timeout_secs}s 没结束,杀掉整棵子进程树(pid=$pid): $*" >&2
      kill_tree "$pid"
      sleep 2
      kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep "$interval"
    waited=$((waited + interval))
  done
}

usage() {
  echo "用法: $0 <stable|ohos|android|ios|android-noIntl> [script...]" >&2
  echo "  script 缺省 = 全部:accept.js accept-interact.js accept-net.js accept-wx.js accept-pv.js" >&2
}

CONFIG="${1:-}"
if [ -z "$CONFIG" ]; then usage; exit 64; fi
shift || true

case "$CONFIG" in
  stable|android|ohos|ios|android-noIntl) ;;
  *) echo "❌ 未知 config: $CONFIG(只支持 stable|ohos|android|ios|android-noIntl)" >&2; usage; exit 64 ;;
esac

# ohos 的 flutter 路径必须显式给,不猜、不回退——猜错了会悄悄拿 stable 的
# flutter 构建出"看起来是 ohos 其实是 stable"的产物,比直接报错更难查。
FLUTTER_BIN_ARGS=()
if [ "$CONFIG" = "ohos" ]; then
  if [ -z "${FLUTTER_OHOS:-}" ]; then
    echo "❌ config=ohos 需要环境变量 FLUTTER_OHOS 指向 flutter_ohos 的 flutter 可执行文件路径" >&2
    echo "   例如: export FLUTTER_OHOS=\$HOME/development/flutter_ohos/bin/flutter" >&2
    exit 64
  fi
  if [ ! -x "$FLUTTER_OHOS" ]; then
    echo "❌ FLUTTER_OHOS=$FLUTTER_OHOS 不存在或不可执行" >&2
    exit 64
  fi
  FLUTTER_BIN_ARGS=(--flutter "$FLUTTER_OHOS")
fi

FORCE_PLATFORM_ARGS=()
case "$CONFIG" in
  android|ios|android-noIntl) FORCE_PLATFORM_ARGS=(--force-platform "$CONFIG") ;;
esac

# script 名 -> 验收工程目录名(见各 accept-*.js 文件头)
app_for_script() {
  case "$1" in
    accept.js) echo mpf_accept ;;
    accept-interact.js) echo mpf_interact ;;
    accept-net.js) echo mpf_net ;;
    accept-wx.js) echo mpf_wx ;;
    accept-pv.js) echo mpf_pv ;;
    *) echo "" ;;
  esac
}

ALL_SCRIPTS=(accept.js accept-interact.js accept-net.js accept-wx.js accept-pv.js)
if [ "$#" -gt 0 ]; then
  SCRIPTS=("$@")
else
  SCRIPTS=("${ALL_SCRIPTS[@]}")
fi

mkdir -p "$OUT_DIR"

RESULTS=()   # 每项: "script|config|PASS或FAIL"
OVERALL=0

for script in "${SCRIPTS[@]}"; do
  app="$(app_for_script "$script")"
  if [ -z "$app" ]; then
    echo "❌ 未知脚本: $script(只支持: ${ALL_SCRIPTS[*]})" >&2
    RESULTS+=("$script|$CONFIG|FAIL(未知脚本)")
    OVERALL=1
    continue
  fi
  script_path="$SCRIPT_DIR/$script"
  app_path="$APPS_DIR/$app"
  out_path="$OUT_DIR/${app}-${CONFIG}"

  echo "== [$CONFIG] 构建 $app → $out_path =="
  rm -rf "$out_path"
  (cd "$REPO_ROOT" && dart run "$MP_FLUTTER_BIN" \
    --project "$app_path" \
    --output "$out_path" \
    --verify \
    --appid "$APPID" \
    "${FLUTTER_BIN_ARGS[@]}" \
    "${FORCE_PLATFORM_ARGS[@]}")
  build_rc=$?
  if [ $build_rc -ne 0 ]; then
    echo "❌ [$CONFIG] $app 构建失败(exit $build_rc),跳过 $script" >&2
    RESULTS+=("$script|$CONFIG|FAIL(构建失败)")
    OVERALL=1
    continue
  fi

  echo "== [$CONFIG] 跑 $script($out_path),超时 ${SCRIPT_TIMEOUT}s =="
  run_with_timeout "$SCRIPT_TIMEOUT" node "$script_path" "$out_path"
  run_rc=$?
  if [ $run_rc -ne 0 ]; then
    reason=$([ $run_rc -eq 124 ] && echo "超时" || echo "exit $run_rc")
    echo "⚠️  [$CONFIG] $script 第一次失败($reason),已知偶发(小程序单次运行内被启动两次/开发者工具连接卡死),自动重跑一次" >&2
    run_with_timeout "$SCRIPT_TIMEOUT" node "$script_path" "$out_path"
    run_rc=$?
  fi

  if [ $run_rc -eq 0 ]; then
    RESULTS+=("$script|$CONFIG|PASS")
  elif [ $run_rc -eq 124 ]; then
    RESULTS+=("$script|$CONFIG|FAIL(超时 ${SCRIPT_TIMEOUT}s)")
    OVERALL=1
  else
    RESULTS+=("$script|$CONFIG|FAIL(exit $run_rc)")
    OVERALL=1
  fi
done

echo
echo "== 汇总(config=$CONFIG) =="
for r in "${RESULTS[@]}"; do
  IFS='|' read -r s c st <<< "$r"
  printf "  %-20s %-8s %s\n" "$s" "$c" "$st"
done

exit $OVERALL
