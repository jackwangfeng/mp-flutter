#!/usr/bin/env bash
# mp-flutter 本地与 CI 共用的检查脚本(Phase 6 Task 5)。
#
# 顺序:
#   1. node --test tools/mp-context/*.test.js
#   2. node --test packages/mp_flutter/js/test/*.test.js
#   3. dart analyze + dart test(packages/mp_flutter,含 tag=slow 的消费者冒烟)
#   4. flutter test(mp_flutter_native、mp_flutter_wechat、example)
#      + flutter test --platform chrome(两个包各自的 @TestOn('browser') 用例)
#   5. 构建冒烟:example 走 `dart run mp_flutter`,断言 app.json 存在
#      (各分包 ≤2048KB 由 mp_flutter 自身的 SizeReport 在构建期校验,
#      超限直接非零退出,这里不重复实现体积检查)
#
# 用法:直接 `tools/ci/check.sh` 跑全部;`FLUTTER_BIN=/path/to/flutter tools/ci/check.sh`
# 可指定用哪个 flutter(默认优先 $HOME/development/flutter/bin/flutter,
# 与 packages/mp_flutter/lib/src/flutter_build.dart 的 resolveFlutterBin 探测顺序一致,
# 否则退回 PATH 上的 flutter——CI 里就是 subosito/flutter-action 装的那个)。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"

# ---------------------------------------------------------------------------
# flutter/dart 二进制选择
#
# 本机(以及理论上任何同时装了 stable 与其它 fork/发行版 Flutter SDK 的机器)
# 有个坑:`flutter`/`dart` 官方启动脚本会把 FLUTTER_ROOT 作为环境变量 export
# 出来(见 bin/internal/shared.sh),子进程会继承。如果调用本脚本的外层 shell
# 之前用别的 SDK(比如 flutter_ohos fork)跑过 flutter/dart 命令,FLUTTER_ROOT
# 会残留指向那个 fork——即便这里选中的是 stable 的 flutter 可执行文件,内部
# pub 解析 `flutter` 包源码时优先信环境变量,导致"跑的是 stable 引擎,却编译
# fork 的 packages/flutter 源码"这种版本错配(dart2js 报 `Member not found:
# 'ohos'`,因为 stable 引擎没有那个平台分支)。显式 unset 以绝后患。
unset FLUTTER_ROOT

if [[ -n "${FLUTTER_BIN:-}" ]]; then
  : # 调用方显式指定
elif [[ -x "$HOME/development/flutter/bin/flutter" ]]; then
  FLUTTER_BIN="$HOME/development/flutter/bin/flutter"
elif command -v flutter >/dev/null 2>&1; then
  FLUTTER_BIN="$(command -v flutter)"
else
  echo "❌ 找不到 flutter 可执行文件(FLUTTER_BIN 未设置,\$HOME/development/flutter 不存在,PATH 上也没有 flutter)" >&2
  exit 1
fi
FLUTTER_DIR="$(cd "$(dirname "$FLUTTER_BIN")" && pwd -P)"
# 把选中的 flutter 所在目录塞到 PATH 最前面:保证脚本内所有 `flutter`/`dart`
# 调用(包括 mp_flutter 内部 Process.run 出去的子进程)解析到同一套 SDK。
export PATH="$FLUTTER_DIR:$PATH"
export DART="$FLUTTER_DIR/dart" # packages/mp_flutter/js/test/split.test.js 用它编译 fixture

echo "== flutter --version =="
flutter --version
echo

step() { echo; echo "———— $1 ————"; }

step "1/6 node --test tools/mp-context/*.test.js"
node --test tools/mp-context/*.test.js

step "2/6 node --test packages/mp_flutter/js/test/*.test.js"
node --test packages/mp_flutter/js/test/*.test.js

step "3/6 dart analyze(packages/mp_flutter)"
(cd packages/mp_flutter && dart analyze)

step "4/6 dart test(packages/mp_flutter,含 tag=slow 消费者冒烟)"
(cd packages/mp_flutter && dart test)
(cd packages/mp_flutter && dart test --run-skipped -t slow test/consumer_smoke_test.dart)

step "5/6 flutter test(mp_flutter_native / mp_flutter_wechat / example)"
(cd packages/mp_flutter_native && flutter test)
(cd packages/mp_flutter_native && flutter test --platform chrome test/registry_web_browser_test.dart)
(cd packages/mp_flutter_wechat && flutter test)
(cd packages/mp_flutter_wechat && flutter test --platform chrome test/channel_web_browser_test.dart)
(cd example && flutter test)

step "6/6 构建冒烟:dart run mp_flutter(example)"
rm -rf example/build/weapp
# 显式 --flutter(M7):不依赖 D1 加入的 package_config.json 自动探测,也不
# 依赖 PATH 顺序——本脚本已经确定了要用哪个 SDK($FLUTTER_BIN),直接告诉
# mp_flutter,避免它探测到与 example/.dart_tool/package_config.json 不一致的
# 另一套 SDK 而报 FlutterSdkMismatch(双 SDK 机器上很容易踩到)。
(cd example && dart run mp_flutter --flutter "$FLUTTER_BIN")
test -f example/build/weapp/app.json || {
  echo "❌ 构建冒烟失败:example/build/weapp/app.json 不存在" >&2
  exit 1
}
echo "✓ app.json 存在;各分包体积已由 mp_flutter 构建期 SizeReport 校验(超限会非零退出)"

echo
echo "======================"
echo "✓ 全部检查通过"
echo "======================"
