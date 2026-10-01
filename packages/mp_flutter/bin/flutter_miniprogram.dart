import 'dart:io';
import 'package:args/args.dart';
import 'package:path/path.dart' as p;
import 'package:flutter_miniprogram/src/pipeline.dart';
import 'package:flutter_miniprogram/src/flutter_build.dart';
import 'package:flutter_miniprogram/src/fonts.dart';
import 'package:flutter_miniprogram/src/version_matrix.dart';
import 'package:flutter_miniprogram/src/transform/canvaskit_js.dart';
import 'package:flutter_miniprogram/src/cjk_font.dart' show resolveCjkBoldLevel;
import 'package:flutter_miniprogram/src/config.dart';
import 'package:flutter_miniprogram/src/doctor.dart';
import 'package:flutter_miniprogram/src/size_check.dart';
import 'package:flutter_miniprogram/src/emit_project.dart' show normalizeSplashColor;
import 'package:flutter_miniprogram/src/package_root.dart';

/// flutter_miniprogram 包版本号。`--version` 与 `doctor` 都打这个。
///
/// 手动与 pubspec.yaml 的 `version:` 保持一致——Dart 没有开销对等的运行时
/// 方式读取自身包的 pubspec 只为取一个版本号(`resolvePackageRoot()` 倒是能
/// 定位到包根,但读文件+解析 YAML 只为一个字符串不值得),这两处都极少改动。
const kPackageVersion = '0.3.1';

/// [runPipeline] 的签名,供 `runCli` 测试注入——单测不应该真的跑一遍
/// `flutter build web`。
typedef PipelineRunner = Future<SizeReport> Function({
  required String projectPath,
  required String outputPath,
  required String appId,
  String? flutterBin,
  String? esbuildPath,
  bool profile,
  bool verify,
  int? dartChunkBudgetBytes,
  String? forcePlatform,
  bool requireLocation,
  List<String> privateInfos,
  bool semanticsMirror,
  bool perfHud,
  List<String> dartDefines,
  String? dartDefineFromFile,
  bool safeArea,
  String? target,
  bool licenses,
  bool shaderWarmup,
  bool shaderWarmupLight,
  String? cjkFont,
  String? cjkFontBold,
  String? fontBaseUrl,
  String? splashTitle,
  String? splashColor,
  String preload,
  String cjkFontBoldTiming,
  bool earlyWasm,
  String bootAssets,
  bool initialRenderingCache,
  bool lazyCodeLoading,
  String androidInput,
  bool inputTiming,
});

/// 探测本机 doctor 检查项的函数签名,供 `runCli` 测试注入。
///
/// [flutterBin]/[esbuildOverride] 对应 `doctor` 子命令的 `--flutter`/
/// `--esbuild`(以及 `mp_flutter.yaml` 里同名键,见 `runCli` 里的合并逻辑)。
typedef DoctorRunner = Future<List<DoctorCheck>> Function({
  String? flutterBin,
  String? esbuildOverride,
  String? projectPath,
});

/// [resolvePackageRoot] 的签名,供 `runCli` 测试注入——`e2e-driver` 子命令用它
/// 定位随包分发的 `tool/e2e/` 目录,单测不应该依赖真实的包解析。
typedef PackageRootResolver = Future<String> Function();

Future<void> main(List<String> argv) async {
  exit(await runCli(argv));
}

ArgParser buildArgParser() {
  final parser = ArgParser()
    ..addOption('project',
        abbr: 'p', help: 'Flutter 工程路径(缺省时从当前目录向上查找第一个含 pubspec.yaml 且依赖 flutter 的目录)')
    ..addOption('output', abbr: 'o', help: '产物输出路径(默认 build/weapp;可被 mp_flutter.yaml 的 output 覆盖)')
    ..addOption('appid', help: '小程序 appid(默认 touristappid;可被 mp_flutter.yaml 的 appid 覆盖)')
    ..addOption('flutter', help: 'flutter 可执行文件路径(默认自动探测;可被 mp_flutter.yaml 的 flutter 覆盖)')
    ..addOption('esbuild',
        help: 'esbuild 可执行文件路径'
            '(默认解析顺序:本参数 → mp_flutter.yaml 的 esbuild → MP_FLUTTER_ESBUILD 环境变量 → '
            'PATH → ~/.mp_flutter 缓存 → 自动安装,见 --help 之外的文档)')
    ..addFlag('profile', help: '产出未压缩代码,Dart 栈可读,用于排障', defaultsTo: false)
    ..addFlag('verify', help: '在承载页注入像素上报,供 E2E 做渲染断言', defaultsTo: false)
    ..addFlag('require-location',
        help: '声明需要定位(写入 app.json 的 requiredPrivateInfos 与权限说明)。'
            '等价于 --private-info=getLocation。可被 mp_flutter.yaml 的 require_location 覆盖。',
        defaultsTo: false)
    ..addMultiOption('private-info',
        splitCommas: false,
        help: '声明需要的用户隐私接口(写入 app.json 的 requiredPrivateInfos;可重复)。'
            '取值:getFuzzyLocation/getLocation/onLocationChange/startLocationUpdate/'
            'startLocationUpdateBackground/chooseAddress/choosePoi/chooseLocation。'
            'getLocation 与 getFuzzyLocation 不能同时声明。除本参数外的定位类接口都会自动带上'
            'permission.scope.userLocation 权限说明。与 mp_flutter.yaml 的 private_infos 合并去重'
            '(该接口还需要在小程序管理后台「开发管理 → 接口设置」里单独启用,见 README)。')
    ..addFlag('semantics-mirror',
        help: '开启 WXML 伴生层(语义树镜像,供微信页面内容索引/无障碍使用)。'
            '默认关闭:语义树本身有运行时开销,只有业务明确需要时才值得打开。'
            '可被 mp_flutter.yaml 的 semantics_mirror 覆盖。',
        defaultsTo: false)
    ..addFlag('perf-hud',
        help: '开启真机性能测量:每秒打一行 [mp-perf](fps/帧耗时/gl 调用/图片解码/长任务),'
            '冷启动阶段打 [mp-boot] 系列日志,左上角加一个可开关的性能浮层。'
            '默认关闭:关闭时不 require 任何相关模块,不产生运行时开销。'
            '可被 mp_flutter.yaml 的 perf_hud 覆盖。',
        defaultsTo: false)
    ..addFlag('input-timing',
        help: '开启输入计时诊断:每个输入相关事件打一行 [mp-t](触摸、引擎焦点、状态下发、setData、'
            '原生 focus/blur/input 带完整 e.detail、键盘高度、Flutter 排版到这次输入的文字、上屏帧),'
            '并估算按键到 JS 的延迟。默认关闭:关闭时不打包、不注入任何相关代码。'
            '可被 mp_flutter.yaml 的 input_timing 覆盖。',
        defaultsTo: false)
    ..addOption('android-input',
        allowed: kAndroidInputConfigModes,
        help: '安卓上原生输入框放哪。offscreen = 水平移出可视区、竖直位置不变(默认;安卓原生光标'
            '设不成透明,叠在输入框上会出现两根光标);overlay = 与 iOS 一样透明叠在输入框上。'
            'iOS 始终叠放。可被 mp_flutter.yaml 的 android_input 覆盖。')
    ..addFlag('safe-area',
        help: '构建期生成入口包装,把小程序安全区注入 MediaQuery.padding/viewPadding(K1)。'
            '工程若在 runApp() 之前自己创建了 WidgetsFlutterBinding 子类,会与入口包装冲突'
            '(release 下注入悄悄不生效,profile 下启动即崩 "Extension already registered")——'
            '这种工程请用 --no-safe-area 关闭本包装,直接构建 --target 指向的文件。'
            '可被 mp_flutter.yaml 的 safe_area 覆盖。',
        defaultsTo: true)
    ..addFlag('shader-warmup',
        help: '首帧之后趁空闲,在引擎的 GrDirectContext 上把常见绘制组合(圆角裁剪、图片、阴影、'
            '渐变、文字、半透明层、模糊…)各画一遍,让 GL program 提前编译,避免首次进入页面时的'
            '着色器编译卡顿(iOS 无 JIT 时单个 program 可达上百 ms)。不占冷启动;有动画/滚动时暂停。'
            '--no-shader-warmup 关闭。可被 mp_flutter.yaml 的 shader_warmup 覆盖。',
        defaultsTo: true)
    ..addFlag('shader-warmup-light',
        help: '着色器预热只画轻项(文字/纯色/图片/圆/描边/路径等),跳过阴影/模糊/颜色矩阵/混合'
            '这类真机上单个 program 可达上百 ms、没法再拆的重项——给低端机用,预热本身占的主线程'
            '时间更低,代价是这些效果仍会在第一次用到时同步编译。对 --no-shader-warmup 无效。'
            '可被 mp_flutter.yaml 的 shader_warmup_light 覆盖。',
        defaultsTo: false)
    ..addFlag('licenses',
        help: '打包第三方许可证全文 assets/NOTICES(默认打包,放在按需分包里,只在打开'
            '许可证页时下载)。--no-licenses 换成空占位,省下 NOTICES 的体积(依赖多时 1–2MB);'
            'showLicensePage 仍可打开,只是不列出第三方包。可被 mp_flutter.yaml 的 licenses 覆盖。',
        defaultsTo: true)
    ..addOption('cjk-font',
        allowed: kCjkFontLevels,
        help: '常用汉字合一字体(Noto Sans SC 子集,brotli 压缩后单独放一个首帧前分包,启动时直接读文件):'
            'full = GB2312 一二级 6763 字 + 标点/全角/Latin-1/常用符号(TTF 2.2MB,br 约 1.15MB,默认;'
            '真机实测在首帧前的关键路径之外,读取 28–30ms,首帧 354/533ms);'
            'level1 = 仅一级 3755 字(TTF 1.2MB,br 约 650KB;字表更小但真机上二级字外的常用字'
            '仍会触发回退分片下载与 fontsChange);false = 不带。'
            '首屏中文不再逐片下载回退字体、不再因字体到达整体重排;字表外的字仍按需下载分片。'
            '可被 mp_flutter.yaml 的 cjk_font 覆盖。')
    ..addFlag('no-cjk-font', negatable: false, help: '同 --cjk-font=false')
    ..addOption('cjk-font-bold',
        allowed: kCjkFontLevels,
        help: '合一字体的粗体(Noto Sans SC Bold 子集,同一 family、字重 700,单独一个分包 pkg-cjkb,'
            '与 CanvasKit 初始化并行读取,不挡首帧)。默认跟随 --cjk-font(full 约 1.17MB br,'
            'level1 约 660KB br),必须与 --cjk-font 同档;false = 不带。'
            '没有粗体时 w600 以上的中文(标题、价格)由 CanvasKit 合成加粗,每个字形首次出现都要'
            '逐点加粗轮廓:实测 30 字 22px 段落首次排版无 JIT 时 30ms(真粗体 7ms)。'
            '可被 mp_flutter.yaml 的 cjk_font_bold 覆盖。')
    ..addOption('font-base-url',
        help: '远端回退字体:回退字体分片(简体中文 Noto)不打进包,运行时从该 https 地址拉取并'
            '缓存到本地文件。构建会在产物下输出待上传目录 mp-fonts-remote/,需原样上传到该地址;'
            '该域名必须加入小程序后台 request 合法域名。可被 mp_flutter.yaml 的 font_base_url 覆盖。')
    // 冷启动开关(每项都能单独开关,方便真机 A/B;默认是冷启动方案推荐的组合)
    ..addOption('preload',
        allowed: kPreloadModes,
        help: '冷启动:app.json preloadRule 挑哪些分包预下载(额度 2MB)。auto = 推荐(目前同 dart,默认);'
            'dart = dart 分包优先(到了还要注入,先到能和 wasm 下载重叠);wasm = 0.2.3 的 wasm 优先顺序;'
            'none = 不写 preloadRule。可被 mp_flutter.yaml 的 preload 覆盖。')
    ..addOption('cjk-font-bold-timing',
        allowed: kCjkBoldTimings,
        help: '冷启动:粗体合一字体什么时候请求。after_first_frame = 首帧提交后才请求,首帧前不抢带宽,'
            '到了空闲时补注册(一次 fontsChange,默认);eager = 0.2.3 的行为,启动就请求。'
            '可被 mp_flutter.yaml 的 cjk_font_bold_timing 覆盖。')
    ..addFlag('early-wasm',
        help: '冷启动:pkg-wasm 一到就编译并实例化 CanvasKit,不等 dart 分包(默认开)。'
            '--no-early-wasm 退回全部首帧前分包就位才编译。可被 mp_flutter.yaml 的 early_wasm 覆盖。',
        defaultsTo: true)
    ..addOption('boot-assets',
        allowed: kBootAssetsModes,
        help: '冷启动:启动资源(FontManifest/AssetManifest/清单字体/Roboto)放哪。auto = 放得下就进主包'
            '(并入后主包 ≤1200KB),否则并进最小的 dart 分包,都放不下才单独成包(默认);main 同 auto;'
            'dart = 只尝试 dart 分包;package = 0.2.3 的单独 pkg-assets-boot 分包。'
            '可被 mp_flutter.yaml 的 boot_assets 覆盖。')
    ..addFlag('initial-rendering-cache',
        help: '冷启动:承载页开启静态初始渲染缓存(initialRenderingCache: static),第二次起冷启动'
            '原生启动界面直接上屏,不等主包 JS 注入(默认开)。可被 mp_flutter.yaml 的 initial_rendering_cache 覆盖。',
        defaultsTo: true)
    ..addFlag('lazy-code-loading',
        help: '冷启动:app.json 写 lazyCodeLoading: requiredComponents(按需注入,默认开)。'
            '可被 mp_flutter.yaml 的 lazy_code_loading 覆盖。',
        defaultsTo: true)
    ..addMultiOption('dart-define',
        splitCommas: false,
        help: '传给 flutter build web 的 --dart-define=KEY=VALUE(可重复;VALUE 可包含逗号)。'
            '可与 mp_flutter.yaml 的 dart_define 合并,命令行同名 KEY 覆盖配置文件的值')
    ..addOption('dart-define-from-file',
        help: '传给 flutter build web 的 --dart-define-from-file=<path>(相对路径相对 cwd 解析)')
    ..addOption('target',
        abbr: 't',
        help: 'Flutter 入口文件(默认 lib/main.dart)。相对路径锚定工程根(不是 cwd)。'
            '可被 mp_flutter.yaml 的 target 覆盖。')
    ..addOption('dart-chunk-kb', hide: true, help: '(测试用)强制 main.dart.js 分片预算,单位 KB')
    ..addOption('force-platform', hide: true, allowed: kForcePlatforms, help: '(测试用,仅与 --verify 同用)覆盖承载页传给引擎的设备平台')
    ..addFlag('help', abbr: 'h', negatable: false, help: '打印帮助信息')
    ..addFlag('version', negatable: false, help: '打印 flutter_miniprogram 版本号');
  parser.addCommand('doctor')
    ..addOption('flutter', help: 'flutter 可执行文件路径(默认自动探测;可被 mp_flutter.yaml 的 flutter 覆盖)')
    ..addOption('esbuild', help: 'esbuild 可执行文件路径(只探测,不触发自动安装;可被 mp_flutter.yaml 的 esbuild 覆盖)');
  parser.addCommand('e2e-driver');
  return parser;
}

/// 真正的 CLI 逻辑,返回进程退出码——不直接调用 [exit],方便单测在同一个
/// 进程里断言各条路径的返回码/输出,而不用真的 fork 子进程。
///
/// [stdoutSink]/[stderrSink]/[currentDir]/[doctorRunner]/[pipelineRunner]
/// 均仅供测试注入。
Future<int> runCli(
  List<String> argv, {
  StringSink? stdoutSink,
  StringSink? stderrSink,
  String Function()? currentDir,
  DoctorRunner doctorRunner = runDoctorChecks,
  PipelineRunner pipelineRunner = runPipeline,
  PackageRootResolver packageRootResolver = resolvePackageRoot,
}) async {
  final out = stdoutSink ?? stdout;
  final err = stderrSink ?? stderr;
  final parser = buildArgParser();

  final ArgResults args;
  try {
    args = parser.parse(argv);
  } on FormatException catch (e) {
    err.writeln('❌ 参数错误:${e.message}\n\n${parser.usage}');
    return 64;
  }

  if (args['help'] as bool) {
    out.writeln('flutter_miniprogram — 把 Flutter 工程编译成微信小程序\n');
    out.writeln(parser.usage);
    out.writeln('\n子命令:'
        '\n  doctor      检查本机工具链(Node/esbuild/flutter/微信开发者工具 CLI)是否就绪'
        '\n  e2e-driver  打印随包分发的 E2E 驱动脚本目录(tool/e2e/drive.js 所在目录)的绝对路径。'
        '\n              配方:'
        '\n                DIR=\$(dart run flutter_miniprogram e2e-driver)'
        '\n                cp -R "\$DIR" ./mp-e2e && (cd mp-e2e && npm i)'
        '\n              然后 require(\'./mp-e2e/drive.js\')。详见该目录下的 README.md。');
    return 0;
  }
  if (args['version'] as bool) {
    out.writeln(kPackageVersion);
    return 0;
  }

  if (args.command?.name == 'e2e-driver') {
    final root = await packageRootResolver();
    out.writeln(p.join(root, 'tool', 'e2e'));
    return 0;
  }

  if (args.command?.name == 'doctor') {
    final doctorArgs = args.command!;

    // doctor 不依赖 --project:尽力找工程根读它的 mp_flutter.yaml(flutter/
    // esbuild 覆盖),找不到就当没有配置文件,照常用默认值探测——doctor 的
    // 定位是"随时随地自检",不该因为不在工程目录里就报错退出。
    String? projectRootForDoctor;
    try {
      projectRootForDoctor = findProjectRoot((currentDir ?? () => Directory.current.path)());
    } on ProjectRootNotFound {
      projectRootForDoctor = null;
    }
    var doctorConfig = MpFlutterConfig.empty;
    if (projectRootForDoctor != null) {
      try {
        doctorConfig = loadConfig(projectRootForDoctor, warn: err.writeln);
      } on ConfigParseFailure catch (e) {
        err.writeln('⚠️  ${e.message}(doctor 忽略这份配置文件,继续用默认值探测)');
      }
    }

    String? pickDoctorPath(String argName, String? fromConfig) {
      if (doctorArgs.wasParsed(argName)) return doctorArgs[argName] as String?; // CLI:相对 cwd
      if (fromConfig == null) return null;
      // yaml 里的相对路径相对工程根解析(找不到工程根时 yaml 本来就是空的)。
      return anchorToProjectRoot(fromConfig, projectRootForDoctor!);
    }

    final flutterBin = pickDoctorPath('flutter', doctorConfig.flutter);
    final esbuildOverride = pickDoctorPath('esbuild', doctorConfig.esbuild);

    final checks = await doctorRunner(
        flutterBin: flutterBin, esbuildOverride: esbuildOverride, projectPath: projectRootForDoctor);
    for (final c in checks) {
      out.writeln(c.render());
    }
    // warnOnly 项(M4:微信开发者工具 CLI 缺失)只提示,不计入退出码——
    // 它只影响命令行自动上传/预览,不影响本地构建产物。
    return checks.any((c) => !c.ok && !c.warnOnly) ? 1 : 0;
  }

  if (args['force-platform'] != null && !(args['verify'] as bool)) {
    err.writeln('❌ 参数错误:--force-platform 只能与 --verify 同用\n\n${parser.usage}');
    return 64;
  }

  // 工程根:显式传了 --project 时行为与旧版完全一致(原样使用该路径,不做
  // 任何探测/校验);缺省时从当前目录向上找第一个"含 pubspec.yaml 且
  // dependencies 里声明了 flutter"的目录。
  final String projectPath;
  if (args.wasParsed('project')) {
    projectPath = args['project'] as String;
  } else {
    try {
      projectPath = findProjectRoot((currentDir ?? () => Directory.current.path)());
    } on ProjectRootNotFound catch (e) {
      err.writeln('❌ ${e.message}');
      return 64;
    }
  }

  // mp_flutter.yaml(可选,位于工程根)。优先级:命令行 > 配置文件 > 默认值。
  final MpFlutterConfig config;
  try {
    config = loadConfig(projectPath, warn: err.writeln);
  } on ConfigParseFailure catch (e) {
    err.writeln('❌ ${e.message}');
    return 64;
  }

  String pickStr(String argName, String? fromConfig, String fallback) =>
      args.wasParsed(argName) ? args[argName] as String : (fromConfig ?? fallback);
  bool pickBool(String argName, bool? fromConfig, bool fallback) =>
      args.wasParsed(argName) ? args[argName] as bool : (fromConfig ?? fallback);

  // 路径类的键(output/flutter/esbuild)在"命令行显式传入"时沿用 CLI 惯例
  // (相对 cwd 解析,交给下游的 File/Process 自然处理);来自 mp_flutter.yaml
  // 或内置默认值时,一律锚定到工程根——不然 `--project` 缺省、从子目录跑
  // 命令时,默认输出目录/yaml 里配的相对路径会解析到错误的地方。
  String pickPathStr(String argName, String? fromConfig, String fallback) {
    if (args.wasParsed(argName)) return args[argName] as String;
    return anchorToProjectRoot(fromConfig ?? fallback, projectPath);
  }

  String? pickPathOpt(String argName, String? fromConfig) {
    if (args.wasParsed(argName)) return args[argName] as String?;
    if (fromConfig == null) return null;
    return anchorToProjectRoot(fromConfig, projectPath);
  }

  final outputPath = pickPathStr('output', config.output, 'build/weapp');
  final appId = pickStr('appid', config.appId, 'touristappid');
  final flutterBin = pickPathOpt('flutter', config.flutter);
  final esbuildPath = pickPathOpt('esbuild', config.esbuild);
  final requireLocation = pickBool('require-location', config.requireLocation, false);
  // --require-location 向后兼容:等价于给 --private-info 补一个 getLocation,
  // 与 mp_flutter.yaml 的 private_infos / 命令行的 --private-info 合并去重
  // (见 config.dart 的 mergePrivateInfos:未知取值 / getLocation+getFuzzyLocation
  // 同时声明都在这里转成退出码 64)。
  final List<String> privateInfos;
  try {
    privateInfos = mergePrivateInfos(
      config.privateInfos ?? const [],
      [
        ...args['private-info'] as List<String>,
        if (requireLocation) 'getLocation',
      ],
    );
  } on FormatException catch (e) {
    err.writeln('❌ ${e.message}\n\n${parser.usage}');
    return 64;
  }
  final semanticsMirror = pickBool('semantics-mirror', config.semanticsMirror, false);
  final perfHud = pickBool('perf-hud', config.perfHud, false);
  final safeArea = pickBool('safe-area', config.safeArea, true);
  final licenses = pickBool('licenses', config.licenses, true);
  final shaderWarmup = pickBool('shader-warmup', config.shaderWarmup, true);
  final shaderWarmupLight = pickBool('shader-warmup-light', config.shaderWarmupLight, false);
  final cjkLevel = args['no-cjk-font'] as bool
      ? 'false'
      : (args.wasParsed('cjk-font') ? args['cjk-font'] as String : (config.cjkFont ?? 'full'));
  final String? cjkFont = cjkLevel == 'false' ? null : cjkLevel;
  final String? cjkFontBold;
  try {
    cjkFontBold = resolveCjkBoldLevel(
        cjkFont, args.wasParsed('cjk-font-bold') ? args['cjk-font-bold'] as String : config.cjkFontBold);
  } on ArgumentError catch (e) {
    err.writeln('❌ ${e.message}');
    return 64;
  }
  final preload = pickStr('preload', config.preload, 'auto');
  final cjkFontBoldTiming = pickStr('cjk-font-bold-timing', config.cjkFontBoldTiming, 'after_first_frame');
  final earlyWasm = pickBool('early-wasm', config.earlyWasm, true);
  final bootAssets = pickStr('boot-assets', config.bootAssets, 'auto');
  final initialRenderingCache = pickBool('initial-rendering-cache', config.initialRenderingCache, true);
  final lazyCodeLoading = pickBool('lazy-code-loading', config.lazyCodeLoading, true);
  final androidInput = pickStr('android-input', config.androidInput, 'offscreen');
  final inputTiming = pickBool('input-timing', config.inputTiming, false);
  final fontBaseUrl = args.wasParsed('font-base-url')
      ? args['font-base-url'] as String
      : config.fontBaseUrl;
  // 启动界面配置只来自 mp_flutter.yaml;格式错误在构建前就失败
  if (config.splashColor != null) {
    try {
      normalizeSplashColor(config.splashColor!);
    } on FormatException catch (e) {
      err.writeln('❌ ${e.message}');
      return 64;
    }
  }
  if (fontBaseUrl != null) {
    try {
      normalizeFontBaseUrl(fontBaseUrl);
    } on FormatException catch (e) {
      err.writeln('❌ ${e.message}');
      return 64;
    }
  }

  // --target/-t(M5):默认 lib/main.dart。与 output/flutter/esbuild 的"命令行
  // 相对 cwd、其余锚定工程根"惯例不同——target 指向的是工程内部的一个 Dart
  // 文件,不管来源(命令行/配置文件/默认值),相对路径都应该锚定工程根,不是
  // cwd(从子目录跑命令、或显式 --project 指向别的目录时,相对 cwd 解析大概率
  // 是错的)。这里**不**用 anchorToProjectRoot 提前拼接:下游(entrypoint.dart
  // 的 writeEntrypoint、或 --no-safe-area 时 flutter 子进程自己的
  // workingDirectory=projectPath)只会对相对路径做一次"相对工程根"的解析——
  // 这里提前拼一次、那边再拼一次会在 `--project` 本身是相对路径时双重拼接出
  // 错误路径(如 `../../lib/main.dart`)。原样传出去,交给唯一那一处解析。
  final target = args.wasParsed('target')
      ? args['target'] as String
      : (config.target ?? 'lib/main.dart');

  // dart-define:yaml 先入表,命令行同名 KEY 覆盖但不挪位置(见
  // config.dart 的 mergeDartDefines);命令行条目格式错误(缺 `=`/KEY 为空)
  // 在构建前就失败,不白等一次 flutter build。
  final List<String> dartDefines;
  try {
    dartDefines = mergeDartDefines(
      config.dartDefine ?? const {},
      args['dart-define'] as List<String>,
    );
  } on FormatException catch (e) {
    err.writeln('❌ ${e.message}\n\n${parser.usage}');
    return 64;
  }

  // --dart-define-from-file 是命令行显式传入的路径,沿用"相对 cwd"的 CLI
  // 惯例——但它最终会作为参数原样传给 flutter 子进程,而该子进程的
  // workingDirectory 是 projectPath(不是 cwd,见下面 runFlutterWebBuild 的
  // 调用),所以必须在这里把相对路径解析成绝对路径,否则 --project 缺省从
  // 子目录跑、或显式 --project 指向别的目录时,这个路径会被 flutter 错误地
  // 相对 projectPath 解析。
  final dartDefineFromFileArg = args['dart-define-from-file'] as String?;
  final String? dartDefineFromFile = dartDefineFromFileArg == null
      ? null
      : (p.isAbsolute(dartDefineFromFileArg)
          ? dartDefineFromFileArg
          : p.join((currentDir ?? () => Directory.current.path)(), dartDefineFromFileArg));

  try {
    final report = await pipelineRunner(
      projectPath: projectPath,
      outputPath: outputPath,
      appId: appId,
      flutterBin: flutterBin,
      esbuildPath: esbuildPath,
      profile: args['profile'] as bool,
      verify: args['verify'] as bool,
      dartChunkBudgetBytes: args['dart-chunk-kb'] == null
          ? null
          : int.parse(args['dart-chunk-kb'] as String) * 1024,
      forcePlatform: args['force-platform'] as String?,
      requireLocation: requireLocation,
      privateInfos: privateInfos,
      semanticsMirror: semanticsMirror,
      perfHud: perfHud,
      dartDefines: dartDefines,
      dartDefineFromFile: dartDefineFromFile,
      safeArea: safeArea,
      target: target,
      licenses: licenses,
      shaderWarmup: shaderWarmup,
      shaderWarmupLight: shaderWarmupLight,
      cjkFont: cjkFont,
      cjkFontBold: cjkFontBold,
      fontBaseUrl: fontBaseUrl,
      splashTitle: config.splashTitle,
      splashColor: config.splashColor,
      preload: preload,
      cjkFontBoldTiming: cjkFontBoldTiming,
      earlyWasm: earlyWasm,
      bootAssets: bootAssets,
      initialRenderingCache: initialRenderingCache,
      lazyCodeLoading: lazyCodeLoading,
      androidInput: androidInput,
      inputTiming: inputTiming,
    );
    if (!report.ok) {
      err.writeln('\n❌ 包体积超限,产物不可用。');
      return 2;
    }
    out.writeln('\n✓ 完成:$outputPath');
    out.writeln('  用微信开发者工具打开该目录即可运行。');
    // 开发者工具界面打开工程时,会用它按项目记住的「本地设置」覆盖
    // project.config.json 里的 es6/enhance(默认都勾选),上传时 dart 分片被
    // 再编译、膨胀超出单分包 2048KB。命令行上传不受影响。
    out.writeln('  如果用开发者工具界面打开产物,请在「详情 → 本地设置」里取消勾选'
        '「将 JS 编译成 ES5」和「增强编译」,否则上传会超出分包上限。');
    return 0;
  } on UnsupportedFlutterVersion catch (e) {
    err.writeln('❌ ${e.message}');
    return 3;
  } on FlutterSdkMismatch catch (e) {
    // D1:双 SDK 机器上,显式指定的 flutter 与工程 package_config.json 解析
    // 用的 SDK 不一致——参数/环境类问题,归到 64(EX_USAGE),不是构建失败。
    err.writeln('❌ ${e.message}');
    return 64;
  } on FlutterBuildFailure catch (e) {
    err.writeln('❌ ${e.message}');
    return 4;
  } on TransformFailure catch (e) {
    err.writeln('❌ ${e.message}');
    return 5;
  } on ToolchainMissing catch (e) {
    err.writeln('❌ ${e.message}');
    return 6;
  } on FontFetchFailure catch (e) {
    err.writeln('❌ ${e.message}');
    return 7;
  } catch (e, st) {
    // 兜底:任何未分类的失败都不能以"Unhandled exception + Dart 栈、退出码 255"
    // 的形式漏出去——255 会和上面精心区分的 2–7 混在一起,脚本化调用无从判断。
    // 栈对用户是噪音,默认不打;排障时用 MP_FLUTTER_DEBUG=1 取回。
    err.writeln('❌ 构建失败:$e');
    err.writeln('');
    err.writeln('如果这看起来像工具链问题,请检查:');
    err.writeln('  · Flutter 是否可用:${flutterBin ?? 'flutter'} --version');
    err.writeln('  · brotli 是否已安装:brotli --version(macOS: brew install brotli)');
    err.writeln('  · esbuild 是否可用(找不到会自动装到 ~/.mp_flutter,首次需要联网):'
        '${esbuildPath ?? 'esbuild'} --version');
    if (Platform.environment['MP_FLUTTER_DEBUG'] == '1') {
      err.writeln('\n$st');
    } else {
      err.writeln('(设置 MP_FLUTTER_DEBUG=1 可查看完整调用栈)');
    }
    return 1;
  }
}
