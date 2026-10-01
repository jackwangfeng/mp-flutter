# 贡献指南

## 开发环境

- **Flutter**:stable **3.41.9**(默认从 `$HOME/development/flutter/bin/flutter`
  自动探测,可用 `FLUTTER_BIN` 环境变量或各脚本的 `--flutter` 覆盖)。改
  `flutter_ohos` 相关代码时还需要一份 `flutter_ohos` **3.41.10-ohos-0.0.2-beta**
  SDK,路径经环境变量 `FLUTTER_OHOS` 提供
- **Node.js ≥ 18**:`main.dart.js` 分片(`packages/mp_flutter/js/split.js`)与
  esbuild 自动安装都依赖它
- **brotli 命令行工具**(macOS:`brew install brotli`):构建管线用它压缩
  `.wasm.br`
- 微信开发者工具(仅 E2E 需要,见下),并在设置里打开"服务端口"

跑一遍自检,确认工具链就绪:

```bash
cd example && dart run flutter_miniprogram doctor
```

## 仓库结构速览

```
packages/mp_flutter/         构建管线(Dart CLI,pub.dev 包名 flutter_miniprogram)与运行时 JS 垫片
packages/mp_flutter_native/  MpVideo/MpMap/MpCamera 原生组件桥
packages/mp_flutter_wechat/  微信登录/支付等能力桥
example/                     示例工程(dogfooding 用)
tools/mp-context/            仿小程序 JS Context 单测
tools/e2e/                   微信开发者工具驱动的 E2E 回归套件
tools/ci/check.sh            本地与 CI 共用的检查脚本
docs/                        对外文档;docs/architecture.md 是设计与实现原理
```

## 本地跑单测与构建冒烟

`tools/ci/check.sh` 是本地与 CI 共用的入口,顺序跑 JS 单测、`dart analyze` +
`dart test`、`flutter test`(含 `--platform chrome` 浏览器用例)、示例工程构建
冒烟:

```bash
tools/ci/check.sh
```

同一台机器装了不止一套 Flutter SDK(比如 stable + `flutter_ohos`)时,用
`FLUTTER_BIN` 显式指定用哪个跑,避免 `FLUTTER_ROOT` 环境变量残留导致版本
错配:

```bash
FLUTTER_BIN=/path/to/stable/flutter/bin/flutter tools/ci/check.sh
```

## 跑 E2E 回归套件

E2E 需要微信开发者工具的 GUI 与登录态,不进 CI,只能本地手动跑:

```bash
tools/e2e/run.sh stable                 # 全部脚本跑一遍(默认稳定版 Flutter)
tools/e2e/run.sh ohos accept.js         # 只用 flutter_ohos 构建并跑 accept.js
tools/e2e/run.sh android accept-pv.js   # 同 stable,额外传 --force-platform android
```

前置条件、appid 约定(`accept-wx.js` 必须用真实 appid,经 `MP_APPID` 环境变量
提供)与各验收工程覆盖范围见 [`tools/e2e/README.md`](tools/e2e/README.md)。

提交前至少确认:

- `tools/ci/check.sh` 本机全绿
- 改动涉及的平台桥,对应的 `tools/e2e/run.sh stable <script>` 通过
- 触碰了 `flutter_ohos` 专属代码路径时,额外跑一次 `ohos` config

## 提交约定

- 提交信息用 `<type>: <中文描述>` 的形式(`feat`/`fix`/`test`/`docs`/`ci`/
  `refactor` 等),参照 `git log` 里的历史提交
- 涉及已知限制/风险变化的改动,同步更新
  [`docs/support-matrix.md`](docs/support-matrix.md)
- 新增/修改 CLI 退出码分型时,同步更新
  [`docs/troubleshooting.md`](docs/troubleshooting.md)

## 许可证

本项目采用 [Apache License 2.0](LICENSE);提交代码即表示同意以该许可证发布你的贡献(含第 5 条贡献条款)。
