# Flutter 3.47.9 字体补丁回归验证

日期：2026-11-07。发布版本：flutter_miniprogram 0.3.6。

## 原因与修复

Issue #2 报告 0.3.5 在 Flutter 3.47.9 构建时报“回退字体补丁 B 失配”。
入口白名单虽然已放开，字体补丁仍通过 `version.version == '3.47.4'` 选择新版路径。
真实 3.47.9 因而错误进入旧版 `ensureFontsSupportText` 分支。

现在根据生成的 JS 结构选择补丁：新版唯一的 `unresolvedCodepoints()` 调用，
或旧版唯一的缺字检测入口。缺失、重复、两种入口混合时继续报错，不跳过字体修复。
已审查构建实现中的其他精确版本判断，未发现其他用于选择变换路径的判断。

## 实际验证

使用从 Flutter 官方 Git 仓库检出的 3.47.9 SDK：
framework `c197ca5199e9ee5661e865596c9c07294dfab51c`，
engine `89c39edfdfae2949f6806e4a315c0c08522238b7`，Dart 3.13.7。

| 检查 | 结果 |
|---|---|
| v0.3.5 原版源码构建 mpf_accept | 复现 issue 中相同的补丁 B 失配 |
| 修复后 release / profile 构建 | 通过，使用默认合一中文字体，未用 cjk_font: false 绕过 |
| 静态分析、386 项 Dart 测试、消费者冒烟 | 通过 |
| Node 运行时/构建变换、桥接包、Chrome、example 测试及构建 | 本地完整 tools/ci/check.sh 通过 |
| 3.41.9 / 3.47.4 / 3.47.9 GitHub CI | [三版本 CI 通过](https://github.com/jackwangfeng/mp-flutter/actions/runs/42366900562) |
| accept.js（release） | 像素、垫片、随机数、中文排版通过 |
| accept-interact.js | 点击、滚动、安全区、中文/emoji 输入、提交与清空、输入框切换、push/pushReplacement 通过，控制台无 error |
| accept-net.js | 网络、图片缩放与像素、PNG 编解码、并发、超时取消、存储冷启动恢复通过 |
| accept-wx.js | 登录 code、模拟后端交换、会话检查、支付失败诊断、剪贴板和分享通过；不代表真实支付成功 |
| accept-pv.js | 原生视图同步几何、滚动、事件回路、控制器通过 |
| accept.js（profile） | 像素、垫片、随机数、中文排版通过 |

首次本地 E2E 的前两项因公开检出目录未安装 miniprogram-automator 而未执行；
安装锁定依赖后逐项补跑通过。首次消费者冒烟曾在 e2e-driver 子进程启动时失败；
单独复测及随后完整检查均通过，未通过跳过或修改断言掩盖该次失败。

发布后另在全新工程中通过正常 `flutter pub get` 安装 pub.dev 的 0.3.6，
确认依赖来源为 hosted/pub.dev/flutter_miniprogram-0.3.6，使用真实 3.47.9
再次构建通过，没有使用源码 path 依赖替代正式分发包。这份产物的开发者工具
像素、垫片、随机数与中文排版验收也通过。

最终代码的[三版本 CI](https://github.com/jackwangfeng/mp-flutter/actions/runs/42367283460)亦全部通过。

## 复跑

先用目标 SDK 在验收工程执行 `flutter pub get`，在 tools/e2e 中执行 `npm ci`，
开启已登录的微信开发者工具 CLI 服务端口，然后在仓库根运行：

```sh
FLUTTER_BIN=/absolute/flutter-3.47.9/bin/flutter tools/ci/check.sh
FLUTTER_BIN=/absolute/flutter-3.47.9/bin/flutter MP_APPID=<appid> tools/e2e/run.sh stable
```

profile 使用 CLI 的 `--profile --verify` 构建 mpf_accept，再运行 accept.js。

本记录为构建和开发者工具证据，没有重新做 iOS/Android 真机验收，
不代表所有 Flutter 版本、设备或支付等线上能力均已验证。
