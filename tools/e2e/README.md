# E2E 验收工程与一键运行

`tools/e2e/apps/` 下是各阶段验收用的最小 Flutter 工程(只入库源码:`lib/`、
`pubspec.yaml`、`web/`、`test/`;`.dart_tool/`、`build/`、`pubspec.lock` 等生成
产物由根 `.gitignore` 挡住,拉下来后各自 `flutter pub get` 即可):

| 目录 | 对应脚本 | 覆盖 |
| --- | --- | --- |
| `mpf_accept` | `accept.js` | Phase 1 渲染像素 + 垫片覆盖;也是 `--dart-chunk-kb` 分片验收(Phase 2 Task 2)的源工程 |
| `mpf_interact` | `accept-interact.js` | Phase 2 交互:点击/拖动滚动/文本输入 |
| `mpf_net` | `accept-net.js` | Phase 3 网络:http/dio/Image.network/shared_preferences |
| `mpf_wx` | `accept-wx.js` | Phase 4 微信能力:登录/支付/剪贴板/分享 |
| `mpf_pv` | `accept-pv.js` | Phase 5 平台视图:原生组件几何/事件回路/可选 `--semantics-mirror` |

`mpf_wx`、`mpf_pv` 依赖仓库内的 `mp_flutter_wechat`/`mp_flutter_native`,均用
相对 path(`../../../../packages/...`),clone 仓库到任意路径都能直接
`flutter pub get`。

## 前置条件

- 微信开发者工具已安装并**已登录**(CLI 只能驱动已登录的实例;不要在这里
  改开发者工具的登录/安全设置,登录不了就是 BLOCKED,不要绕过)。`drive.js`
  里硬编码的 CLI 路径是 `/Applications/wechatwebdevtools.app/Contents/MacOS/cli`。
  开发者工具的"服务端口"（设置 → 安全设置 → 开启服务端口）需要打开,`miniprogram-automator`
  才能连上。
- Node ≥ 18(`tools/e2e/package.json` 已声明依赖 `miniprogram-automator`,首次用需要
  在 `tools/e2e/` 下 `npm install`)。
- Flutter stable:默认从 `$HOME/development/flutter/bin/flutter` 自动探测(见
  `packages/mp_flutter/lib/src/flutter_build.dart` 的 `resolveFlutterBin`),
  没有的话回退 `/usr/local/bin/flutter`,再回退 PATH 里的 `flutter`。
- 跑 `ohos` config 需要环境变量 `FLUTTER_OHOS` 指向 `flutter_ohos` 的 `flutter`
  可执行文件路径(例如 `~/development/flutter_ohos/bin/flutter`)。未设置时
  `run.sh` 直接报错退出,不会静默回退到别的 flutter。
- `accept-net.js`/`accept-wx.js`/`accept-pv.js` 会自己在 `127.0.0.1:18080`
  起一个测试服务器(`tools/e2e/test-server.js`),不需要额外手动启动;但端口
  已被占用会导致这几个脚本失败。

appid 取环境变量 `MP_APPID`,缺省 `touristappid`。**`accept-wx.js` 必须用真实 appid**:游客 appid 下开发者工具的 `wx.login` 只返回字面量 `the code is a mock one`,login/后端换 openid 两条断言必然失败。

## 一键跑

```bash
tools/e2e/run.sh <stable|ohos|android> [script...]
```

- `stable`:用自动探测的 flutter 稳定版构建。
- `android`:同 `stable`,额外传 `--force-platform android`(构建 `--verify`
  页面时强制承载页用 android 平台几何,仍在本机开发者工具里跑)。
- `ohos`:用 `flutter_ohos`(取 `FLUTTER_OHOS`)构建,校验 OpenHarmony 目标下
  产物形状与 stable 一致的路径。
- `script` 缺省 = 全部五个:`accept.js accept-interact.js accept-net.js
  accept-wx.js accept-pv.js`。也可以只传一个或几个,例如:

```bash
tools/e2e/run.sh stable                 # 全部脚本跑一遍
tools/e2e/run.sh ohos accept.js         # 只用 flutter_ohos 构建并跑 accept.js
tools/e2e/run.sh android accept-pv.js   # 只用 --force-platform android 跑 accept-pv.js
```

流程:对每个脚本,先构建对应验收工程,产物落
`tools/e2e/out/<app>-<config>/`(每次构建前清空该目录),再跑对应
`accept-*.js` 断言。已知偶发(一次运行里小程序在开发者工具里被启动两次,
导致断言看到脏状态/超时)——脚本失败时自动重跑一次(只重跑脚本,不重新
构建);两次都失败才算真失败。跑完打印每个 (脚本, config) 一行 PASS/FAIL
的汇总,只要有一个 FAIL,整体以非零退出码结束。

## 手动跑(分片 / semantics-mirror 变体)

`run.sh` 默认构建不传 `--dart-chunk-kb`/`--semantics-mirror`,以下两条覆盖
面是各自脚本文件头里写明的额外变体,需要手动跑:

```bash
# accept.js:main.dart.js 分片(pkg-dart-0..N)路径
dart run packages/mp_flutter/bin/flutter_miniprogram.dart \
  --project tools/e2e/apps/mpf_accept \
  --output tools/e2e/out/mpf_accept_split --verify --appid "${MP_APPID:-touristappid}" \
  --dart-chunk-kb 400
node tools/e2e/accept.js tools/e2e/out/mpf_accept_split

# accept-pv.js:可选 WXML 伴生层(语义树镜像)
dart run packages/mp_flutter/bin/flutter_miniprogram.dart \
  --project tools/e2e/apps/mpf_pv \
  --output tools/e2e/out/mpf_pv_semantics --verify --appid "${MP_APPID:-touristappid}" \
  --semantics-mirror
node tools/e2e/accept-pv.js tools/e2e/out/mpf_pv_semantics --check-semantics
```
