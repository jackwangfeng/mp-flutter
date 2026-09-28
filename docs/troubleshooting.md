# 故障排查(退出码对照表)

`dart run mp_flutter`(旧用法 `dart run bin/mp_flutter.dart` 行为不变)按失败
类型分型退出码,方便脚本化调用判断"该做什么",不用去猜一堆 Dart 调用栈。
命令行会把原因打到 stderr,本页按退出码汇总原因与处理办法。

先跑一遍自检,能覆盖下面大多数环境类问题:

```bash
dart run mp_flutter doctor
```

## 退出码 0 —— 成功

产物落在 `--output`(默认 `build/weapp`,可被 `mp_flutter.yaml` 的 `output`
覆盖)。用微信开发者工具打开该目录即可运行。

## 退出码 1 —— 未分类错误 / `doctor` 有检查项未通过

两种场景共用退出码 1:

1. **主命令**:任何不属于下面 2–7、64 分型的失败(兜底),避免以"Unhandled
   exception + Dart 栈、退出码 255"的形式漏给调用方。stderr 会附带排查
   提示(Flutter/brotli/esbuild 是否可用);默认不打印完整调用栈,设置
   `MP_FLUTTER_DEBUG=1` 环境变量可取回完整栈供排障。
2. **`dart run mp_flutter doctor`**:任意一项检查(Node/esbuild/flutter/
   微信开发者工具 CLI)标 ✗ 时,`doctor` 本身以退出码 1 结束(单纯提示性的
   "esbuild 尚未安装,首次构建会自动装"不算 ✗)。

**处理**:先看 stderr 里的具体原因;不明显时设 `MP_FLUTTER_DEBUG=1` 重跑一次
拿到完整栈;常见根因是 `flutter build web --release` 在该工程里本来就跑不通
(`brotli`/Node/esbuild 缺失都有专属退出码 6,不会落到这里,见下)。

## 退出码 2 —— 包体积超限

产物某个分包(源码尺寸)超过 2048KB 上限,构建期 `SizeReport` 直接判失败,
产物不可用。

**处理**:

- 排查大依赖(尤其是打包进 assets 的图片/字体——小程序资源走 base64 装箱,
  实测比原始体积再膨胀约 33%)
- 确认没有意外把开发期资源(未压缩地图、测试图片等)带进 `assets`
- `main.dart.js` 本身会自动分片到多个分包(构建期自动,业务代码不需要
  配合;但目前与 `deferred as` 延迟加载不能同时使用),超限通常是分片之外的
  内容(资源/其它分包)本身就超过了单包上限

## 退出码 3 —— 不支持的 Flutter 版本

当前工程使用的 `flutter` 不在已验证矩阵内(见
[`docs/support-matrix.md`](support-matrix.md)):stable **3.41.9**、
`flutter_ohos` **3.41.10-ohos-0.0.2-beta**。垫片与构建期变换绑定 engine 产物的
内部形状(非公开 API),换版本前必须先跑一遍 `tools/e2e/run.sh` 回归套件。

**处理**:改用矩阵内版本;或者接受风险自行跑一遍
`tools/e2e/run.sh <stable|ohos|android>` 全量回归后再决定是否继续用未验证版本
(该退出码目前没有 `--force` 之类的绕过旗标)。

## 退出码 4 —— `flutter build web` 失败

mp_flutter 基于 Flutter 的 web target,这一步失败绝大多数时候是宿主工程本身
的问题,不是 mp_flutter 的 bug。stderr 会原样附带 Flutter 自己的完整输出。

**处理**:

1. 先确认工程本身能跑通 `flutter build web --release`(不经过 mp_flutter)
2. 常见原因:直接用了 `dart:io`、platform channel,或者依赖了不支持 web 的
   插件
3. 确认 `--flutter`/`mp_flutter.yaml` 的 `flutter` 指向的是预期的 SDK(尤其是
   同时装了 stable 与 `flutter_ohos` 两套 SDK 时,`FLUTTER_ROOT` 环境变量残留
   可能导致引擎版本与 `packages/flutter` 源码版本错配,报类似
   `Member not found` 的怪错误——`unset FLUTTER_ROOT` 后重试)

## 退出码 5 —— 构建期变换失配

`canvaskit.js` 的构建期补丁(或 esbuild 语法降级)找不到预期的代码模式,说明
上游 CanvasKit/引擎产物的内部结构变了。

**处理**:先跑一遍 `tools/e2e` 回归确认问题范围;这类失败通常需要跟着上游
产物变化更新 `packages/mp_flutter/lib/src/transform/canvaskit_js.dart` 里的
变换规则,不是使用方能自行修复的配置问题。

## 退出码 6 —— 外部工具缺失

`brotli`/`node`/`esbuild` 探测失败:

- **brotli 缺失或不可执行**:压缩 `canvaskit.wasm` 依赖它(见
  `packages/mp_flutter/lib/src/toolchain.dart` 的 `checkBrotliAvailable`),
  macOS/Linux 都不预装,是最容易踩到的首次运行失败。安装:macOS
  `brew install brotli`;Debian/Ubuntu(含 CI 的 `ubuntu-latest`)
  `apt install brotli`。`doctor` 会检查它是否可用。
- **Node 缺失或版本 < 18**:`main.dart.js` 分片需要 Node ≥18。安装/升级
  Node 后重试;`doctor` 会报告当前探测到的版本。
- **esbuild 解析失败**:解析顺序是 `--esbuild` 参数 → `mp_flutter.yaml`
  的 `esbuild` 键 → `MP_FLUTTER_ESBUILD` 环境变量 → PATH → 本机缓存
  `~/.mp_flutter/esbuild-<version>/node_modules/.bin/esbuild` → 自动
  `npm install` 安装到该缓存(仅这一步会联网,版本固定为
  `packages/mp_flutter/lib/src/esbuild_resolver.dart` 里的
  `kEsbuildVersion`)。离线环境下自动安装这一步会失败。

**处理**:

- brotli 按上面的命令安装即可,没有绕开的旗标(压缩这一步不可跳过)
- 离线时手动安装一份固定版本的 esbuild,用 `--esbuild <path>` 或
  `MP_FLUTTER_ESBUILD` 环境变量指向它,完全绕开自动安装
- `dart run mp_flutter doctor` 可以在不触发自动安装的前提下,提前看到
  esbuild 是否已就绪

## 退出码 7 —— 回退字体下载失败

引擎内置回退字体只在首次构建时下载,之后走本地缓存
(`$XDG_CACHE_HOME/mp_flutter/fonts`,未设置 `XDG_CACHE_HOME` 时用
`~/.cache/mp_flutter/fonts`)。下载失败时报这个退出码。

**处理**:检查网络或代理——支持读取 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量,
**不支持** `ALL_PROXY`/socks 代理;确认后重试即可,后续构建会命中本地缓存,
不会重复下载。

## 退出码 64 —— 参数/用法错误

以下几种情况都归到这个退出码(Unix 惯例:`EX_USAGE`):

- 命令行参数本身不合法(未知选项、缺值等),stderr 会附带完整用法说明
- `--force-platform` 单独使用而没有同时传 `--verify`(该参数只在 `--verify`
  场景下有意义)
- `--project` 缺省时,从当前目录向上查找不到任何"含 `pubspec.yaml` 且
  `dependencies` 声明了 `flutter`"的目录——多数是在工程外层目录、或非
  Flutter 工程目录下执行了命令;显式传 `--project <路径>` 可绕开自动探测
- `mp_flutter.yaml` 存在但内容不合法(不是合法 YAML、根节点不是映射、或
  某个已知键类型不对)——注意与"未知键"区分:未知键只会 warn 一次不影响
  执行,这里是配置文件本身有问题必须先修好
- `--dart-define`(或 `mp_flutter.yaml` 的 `dart_define`)里某一项格式不对
  (缺 `=`,或 KEY 为空;`mp_flutter.yaml` 的 `dart_define` 还额外要求每个
  值必须是标量——写成 `KEY:` 空着不写值,或嵌套映射/列表,都会报这个错误)
- `--private-info`(或 `mp_flutter.yaml` 的 `private_infos`)里出现不认识的
  取值——错误信息会列出全部允许值;或者合并后同时含 `getLocation` 与
  `getFuzzyLocation`(微信不允许一个小程序同时声明这两个定位接口)
- **显式指定的 Flutter SDK 与工程 `.dart_tool/package_config.json` 解析用的
  SDK 不一致**(D1,双 SDK 机器常见):没有显式传 `--flutter`/`mp_flutter.yaml`
  的 `flutter` 时,mp_flutter 优先用 `package_config.json` 里 `flutter` 包
  `rootUri` 反推出的 SDK(该工程 `flutter pub get` 时用的那一套,dart2js 实际
  编译的就是它的 `packages/flutter` 源码);显式指定了 `--flutter` 且和这个
  推断结果不一致时,直接拒绝而不是二选一悄悄跑——继续跑大概率在 dart2js 阶段
  报 `Member not found` 之类看不出根因的怪错误。**处理**:先用报错里提示的
  SDK 执行一次 `flutter pub get`,或者把 `--flutter`/`mp_flutter.yaml` 的
  `flutter` 改成指向该 SDK

**处理**:按 stderr 提示修正参数或配置文件;`--project` 相关的问题多数是
在错误的目录下执行了命令,`cd` 到目标 Flutter 工程(或其子目录)下重跑,或
显式传 `--project`。

## 上传/运行时问题(不是构建失败)

### 界面预览或真机调试报 `pkg-dart-* source size ... exceed max limit 2048KB`

**现象**:命令行构建成功(`SizeReport` 各包都在 2048KB 内),但在微信开发者工具
**界面**里点「预览」「真机调试」或「上传」时报某个 `pkg-dart-*` 分包源码尺寸超过
2048KB;用命令行(`cli preview`/`cli upload`)上传同一份产物却没问题。

**原因**:开发者工具在界面里打开工程时,会用它按项目记住的「本地设置」覆盖
`project.config.json` 里的 `es6`/`enhance`(这两项在本地设置里默认都是勾选的)。
产物里写的是 `es6: false`、`enhance: false`,但被覆盖后,上传前工具会把 dart2js
产物再做一遍 ES6→ES5/增强编译,约 1.7MB 的 dart 分片会膨胀到 4MB 左右,超过单分包
上限。命令行上传直接读 `project.config.json`,不受本地设置影响。

**处理**:在开发者工具里打开产物目录后,进「详情 → 本地设置」,取消勾选
「将 JS 编译成 ES5」和「增强编译」,再预览/上传。本地设置按项目记忆,同一个产物
目录只需要改一次;换了产物目录(比如 `-o` 指向新路径)要重新检查。构建成功的
收尾提示里也会提醒这一点。

### `--no-licenses` 之后「开源许可」页只显示应用自己

**现象**:`showLicensePage`/`showAboutDialog` 的许可证页能打开,但不列出任何第三方包。

**原因**:这是预期行为。`--no-licenses`(或 `mp_flutter.yaml` 的 `licenses: false`)
把 `assets/NOTICES` 换成了**空占位**,框架 `ServicesBinding._addLicenses` 读到空字符串,
解析出一条不属于任何包的条目,许可证页于是只剩应用自身信息;业务代码经
`LicenseRegistry.addLicense` 手动登记的条目仍会显示。

为什么不干脆不打包 NOTICES:按 Flutter 3.41.9 源码,资源 404 时引擎
`_handleFlutterAssetsMessage` 回复 `null`,`PlatformAssetBundle.load` 抛
`Unable to load asset: "NOTICES"`;这个异常发生在 `LicenseRegistry` 那条
`StreamController` 的 `onListen` 里,既不会进流也不会关闭流——许可证页的
`FutureBuilder` 永远停在加载中(一直转圈),控制台多一条未捕获错误。空占位避免了
这两件事。

**处理**:需要展示第三方许可证就不要加 `--no-licenses`;默认的 NOTICES 放在按需
分包 `pkg-notices` 里,只在打开许可证页时才下载,不影响启动。

### 远端字体(`font_base_url`)下中文显示成方块/空白

**现象**:开发者工具里正常,真机中文不显示(或只有部分字显示),控制台有
`远端字体 mp-fonts/notosanssc/... 加载失败`。

**原因与处理**(按出现频率):

1. `font_base_url` 的域名没有加进小程序后台「开发管理 → 开发设置 → 服务器域名 →
   request 合法域名」。开发者工具默认 `urlCheck: false` 不校验域名,会掩盖这个问题。
2. `mp-fonts-remote/` 没有上传,或上传后的路径与 `font_base_url` 对不上:运行时请求的
   是 `font_base_url` + `notosanssc/v37/<文件名>.woff2`,即 `mp-fonts-remote/` 目录下
   的相对路径原样拼上去。
3. CDN 返回的不是字体(登录页、防盗链页):运行时校验 woff2 魔数,不是字体就拒绝且
   不缓存,错误里会写「返回的不是 woff2」。

下载成功的分片缓存在 `wx.env.USER_DATA_PATH/mp-fonts-cache/`(上限 10MB,LRU
淘汰),下次启动直接读本地文件。

### 启动界面一直停着 / 显示「启动失败:……」

启动界面(应用名 + 进度条)在 Flutter 首帧提交后移除。首帧之前任何一步失败,
都会把错误写在启动界面上(同时弹窗),不会留下一块黑屏——按错误文案排查即可
(常见的是分包下载失败、`main.dart.js` 分片执行出错)。极少数情况下首帧钩子没报上来,
`runApp` 返回 3 秒后启动界面也会自动移除。

---

以上退出码对应源码见 `packages/mp_flutter/bin/mp_flutter.dart` 的 `runCli`;
更细的平台桥限制(不是构建期失败,而是运行时行为限制,例如
`cacheWidth`/`toByteData` 不支持、原生组件层序限制等)见
[`docs/support-matrix.md`](support-matrix.md)。
