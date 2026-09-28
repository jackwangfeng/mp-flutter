import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:yaml/yaml.dart';

/// 把相对路径锚定到工程根;绝对路径原样返回。
///
/// `mp_flutter.yaml` 里的 `output`/`flutter`/`esbuild`,以及命令行缺省时
/// 用到的内置默认值(比如 `build/weapp`),都应该相对**工程根**解析——
/// 一旦 `--project` 缺省、从子目录里跑命令(向上探测出的工程根不等于
/// cwd),相对 cwd 解析就会把产物/工具路径解析到错误的位置。
///
/// 命令行显式传入的相对路径不经过这个函数:沿用"相对路径相对 cwd"的
/// CLI 惯例,不做锚定改动。
String anchorToProjectRoot(String path, String projectRoot) {
  return p.isAbsolute(path) ? path : p.join(projectRoot, path);
}

/// `--project` 缺省时,从 cwd 向上找不到任何"含 pubspec.yaml 且依赖了
/// flutter"的目录。
///
/// 只在**没有显式传 `--project`** 时才会走这条自动探测路径——显式传参的
/// 旧用法(`--project foo --output bar`)行为不变,不做任何校验/搜索。
class ProjectRootNotFound implements Exception {
  final String startDir;
  const ProjectRootNotFound(this.startDir);

  String get message =>
      '找不到 Flutter 工程根:从 $startDir 向上查找,没有发现任何目录同时满足'
      '"含 pubspec.yaml"与"pubspec.yaml 的 dependencies 里声明了 flutter"。\n'
      '请显式传入 --project <路径>,或者在目标 Flutter 工程(或其子目录)下运行本命令。';

  @override
  String toString() => 'ProjectRootNotFound: $message';
}

/// `mp_flutter.yaml` 存在但解析失败(不是合法 YAML、根节点不是映射、或某个
/// 已知键的值类型不对)。
///
/// 与"未知键"故意区分对待:未知键大概率是新旧版本键名变化,warn 一次就够;
/// 这里是配置文件本身有问题,继续跑大概率会用到错的值,必须显式失败。
class ConfigParseFailure implements Exception {
  final String path;
  final String reason;
  const ConfigParseFailure(this.path, this.reason);

  String get message => '$path 解析失败:$reason';

  @override
  String toString() => 'ConfigParseFailure: $message';
}

/// 从 [startDir] 向上查找第一个同时满足下列条件的目录,作为工程根:
///
///  1. 含 `pubspec.yaml`
///  2. 该 `pubspec.yaml` 的 `dependencies` 下声明了 `flutter`
///     (标准 Flutter 工程的写法:`flutter: { sdk: flutter }`)
///
/// 找不到时抛 [ProjectRootNotFound]。
///
/// [fileExists]/[readFile] 仅供测试注入,绕开真实文件系统。
String findProjectRoot(
  String startDir, {
  bool Function(String path)? fileExists,
  String Function(String path)? readFile,
}) {
  final exists = fileExists ?? (path) => File(path).existsSync();
  final read = readFile ?? (path) => File(path).readAsStringSync();

  var dir = p.normalize(p.absolute(startDir));
  while (true) {
    final pubspecPath = p.join(dir, 'pubspec.yaml');
    if (exists(pubspecPath)) {
      if (_dependsOnFlutter(read(pubspecPath))) return dir;
    }
    final parent = p.dirname(dir);
    if (parent == dir) break; // 已到文件系统根,不能再往上
    dir = parent;
  }
  throw ProjectRootNotFound(startDir);
}

bool _dependsOnFlutter(String pubspecYaml) {
  Object? doc;
  try {
    doc = loadYaml(pubspecYaml);
  } on YamlException {
    // 这个 pubspec.yaml 本身就不合法——当作"不是它"处理,继续往上找,
    // 而不是让探测过程崩溃(可能是别的工具占用的同名文件)。
    return false;
  }
  if (doc is! Map) return false;
  final deps = doc['dependencies'];
  return deps is Map && deps.containsKey('flutter');
}

/// `mp_flutter.yaml`(可选,位于工程根)里认识的键。
const kKnownConfigKeys = <String>{
  'appid',
  'output',
  'flutter',
  'esbuild',
  'require_location',
  'private_infos',
  'semantics_mirror',
  'dart_define',
  'safe_area',
  'target',
  'perf_hud',
  'licenses',
  'cjk_font',
  'cjk_font_bold',
  'font_base_url',
  'splash_title',
  'splash_color',
};

/// `cjk_font` / `--cjk-font` 的取值。`false` 表示关闭。
const kCjkFontLevels = ['level1', 'full', 'false'];

/// `private_infos` / `--private-info` 支持的取值(微信「用户隐私相关接口」,
/// 详见开放文档「用户隐私保护指引」)。写进 app.json 的 `requiredPrivateInfos`
/// 前必须在这个集合里,否则大概率是拼写错误或微信新增/改名的接口,悄悄透传
/// 给 app.json 只会在真机/审核阶段才暴露。
const kAllowedPrivateInfos = <String>[
  'getFuzzyLocation',
  'getLocation',
  'onLocationChange',
  'startLocationUpdate',
  'startLocationUpdateBackground',
  'chooseAddress',
  'choosePoi',
  'chooseLocation',
];

/// [kAllowedPrivateInfos] 里会触发 `permission.scope.userLocation` 权限说明的
/// 定位类接口子集——`chooseAddress` 是地址簿(收货地址),跟定位权限无关。
const kLocationScopePrivateInfos = <String>{
  'getFuzzyLocation',
  'getLocation',
  'onLocationChange',
  'startLocationUpdate',
  'startLocationUpdateBackground',
  'choosePoi',
  'chooseLocation',
};

/// `mp_flutter.yaml` 解析结果。字段为 null 表示该键未出现在配置文件里
/// (与"显式配置了 false/空字符串"区分开,交给调用方按"命令行 > 配置文件 >
/// 默认值"的优先级合并)。
class MpFlutterConfig {
  final String? appId;
  final String? output;
  final String? flutter;
  final String? esbuild;
  final bool? requireLocation;
  final List<String>? privateInfos;
  final bool? semanticsMirror;
  final Map<String, String>? dartDefine;
  final bool? safeArea;
  final String? target;
  final bool? perfHud;
  final bool? licenses;
  /// `cjk_font`:'level1' / 'full' / 'false'(true 视为 full,与默认值一致)。null = 未配置。
  final String? cjkFont;
  /// `cjk_font_bold`:'level1' / 'full' / 'false'。null = 未配置(或写 true),跟随 cjk_font。
  final String? cjkFontBold;
  final String? fontBaseUrl;
  final String? splashTitle;
  final String? splashColor;

  const MpFlutterConfig({
    this.appId,
    this.output,
    this.flutter,
    this.esbuild,
    this.requireLocation,
    this.privateInfos,
    this.semanticsMirror,
    this.dartDefine,
    this.safeArea,
    this.target,
    this.perfHud,
    this.licenses,
    this.cjkFont,
    this.cjkFontBold,
    this.fontBaseUrl,
    this.splashTitle,
    this.splashColor,
  });

  static const empty = MpFlutterConfig();
}

/// 加载工程根下可选的 `mp_flutter.yaml`。文件不存在时返回
/// [MpFlutterConfig.empty],不算错误——配置文件本来就是可选的。
///
/// 未知键只经 [warn] 提示一次,不会导致失败(多半是版本升级后键名变化的
/// 旧配置文件,因为一个不认识的键就拒绝构建会阻塞正常使用)。已知键的值
/// 类型不对(比如 `require_location: 1` 而不是 `true`)则抛
/// [ConfigParseFailure]——用错的值悄悄跑下去比显式失败更糟。
///
/// [fileExists]/[readFile] 仅供测试注入;[warn] 默认写 stderr。
MpFlutterConfig loadConfig(
  String projectRoot, {
  bool Function(String path)? fileExists,
  String Function(String path)? readFile,
  void Function(String message)? warn,
}) {
  final exists = fileExists ?? (path) => File(path).existsSync();
  final read = readFile ?? (path) => File(path).readAsStringSync();
  final warnFn = warn ?? (m) => stderr.writeln(m);

  final path = p.join(projectRoot, 'mp_flutter.yaml');
  if (!exists(path)) return MpFlutterConfig.empty;

  Object? doc;
  try {
    doc = loadYaml(read(path));
  } on YamlException catch (e) {
    throw ConfigParseFailure(path, '不是合法的 YAML:$e');
  }
  if (doc == null) return MpFlutterConfig.empty; // 空文件
  if (doc is! Map) {
    throw ConfigParseFailure(
        path, '根节点必须是一个映射(key: value 形式),实际是 ${doc.runtimeType}');
  }
  // 绑到一个静态类型就是 Map 的变量:上面的 `doc is! Map` 只在本层提升类型,
  // 下面的嵌套闭包(asString/asBool)捕获的是外层变量,拿到的仍是 Object?,
  // 需要一个类型明确的绑定而不是每次都重新做同样的 is 检查。
  final Map map = doc;

  final unknown =
      map.keys.map((k) => '$k').where((k) => !kKnownConfigKeys.contains(k)).toList();
  if (unknown.isNotEmpty) {
    warnFn('⚠️  $path 含未知配置键:${unknown.join(', ')}(已忽略,不影响其余键生效;'
        '如果这是拼写错误,请对照支持的键:${kKnownConfigKeys.join(', ')})');
  }

  String? asString(String key) {
    final v = map[key];
    if (v == null) return null;
    if (v is String) return v;
    throw ConfigParseFailure(path, '$key 必须是字符串,实际是:$v(${v.runtimeType})');
  }

  bool? asBool(String key) {
    final v = map[key];
    if (v == null) return null;
    if (v is bool) return v;
    throw ConfigParseFailure(path, '$key 必须是布尔值(true/false),实际是:$v(${v.runtimeType})');
  }

  String? asCjkLevel(String key) {
    final v = map[key];
    if (v == null) return null;
    if (v == true) return 'full';
    if (v == false) return 'false';
    if (v is String && kCjkFontLevels.contains(v)) return v;
    throw ConfigParseFailure(path, '$key 只能是 level1 / full / false,实际是:$v(${v.runtimeType})');
  }

  // cjk_font_bold:true = 跟随 cjk_font(与不写相同)
  String? asCjkBoldLevel(String key) {
    final v = map[key];
    if (v == null || v == true) return null;
    if (v == false) return 'false';
    if (v is String && kCjkFontLevels.contains(v)) return v;
    throw ConfigParseFailure(path, '$key 只能是 level1 / full / false,实际是:$v(${v.runtimeType})');
  }

  List<String>? asPrivateInfoList(String key) {
    final v = map[key];
    if (v == null) return null;
    if (v is! List) {
      throw ConfigParseFailure(
          path, '$key 必须是字符串列表,实际是:$v(${v.runtimeType})');
    }
    final result = <String>[];
    for (final item in v) {
      if (item is! String) {
        throw ConfigParseFailure(
            path, '$key 的元素必须是字符串,实际是:$item(${item.runtimeType})');
      }
      if (!kAllowedPrivateInfos.contains(item)) {
        throw ConfigParseFailure(path,
            '$key 含不支持的取值:"$item"(仅支持:${kAllowedPrivateInfos.join(', ')})');
      }
      result.add(item);
    }
    return result;
  }

  Map<String, String>? asStringMap(String key) {
    final v = map[key];
    if (v == null) return null;
    if (v is! Map) {
      throw ConfigParseFailure(
          path, '$key 必须是映射(key: value 形式),实际是:$v(${v.runtimeType})');
    }
    // 值统一 stringify:yaml 里 `KEY: 1`/`KEY: true` 这类非字符串标量写法也
    // 应该能透传给 flutter build web(--dart-define 的值本来就是字符串)。
    // M10:值是 null(yaml 里 `KEY:` 空着不写值)或不是标量(嵌套映射/列表)
    // 时必须显式失败——`'$val'` 会分别 stringify 成字面量 "null"/
    // "{...}"/"[...]" 这种业务代码本来就没写、也大概率不是本意的字符串,
    // 悄悄透传给 flutter build web 会造成很难查的行为(dart-define 的值
    // 变成了字面 "null"),必须在这里显式拒绝而不是尽力而为。
    final result = <String, String>{};
    v.forEach((k, val) {
      if (val == null || val is Map || val is List) {
        throw ConfigParseFailure(path,
            '$key.$k 的值必须是标量(字符串/数字/布尔值),不能是 null 或映射/列表,实际是:$val(${val.runtimeType})');
      }
      result['$k'] = '$val';
    });
    return result;
  }

  return MpFlutterConfig(
    appId: asString('appid'),
    output: asString('output'),
    flutter: asString('flutter'),
    esbuild: asString('esbuild'),
    requireLocation: asBool('require_location'),
    privateInfos: asPrivateInfoList('private_infos'),
    semanticsMirror: asBool('semantics_mirror'),
    dartDefine: asStringMap('dart_define'),
    safeArea: asBool('safe_area'),
    target: asString('target'),
    perfHud: asBool('perf_hud'),
    licenses: asBool('licenses'),
    cjkFont: asCjkLevel('cjk_font'),
    cjkFontBold: asCjkBoldLevel('cjk_font_bold'),
    fontBaseUrl: asString('font_base_url'),
    splashTitle: asString('splash_title'),
    splashColor: asString('splash_color'),
  );
}

/// 解析一条命令行 `--dart-define=KEY=VALUE` 原始字符串,拆成 KEY/VALUE。
///
/// 只在**第一个** `=` 处切分——VALUE 本身可能含 `=`(比如 base64/JSON 片段)。
/// KEY 必须非空且原始字符串必须含 `=`,否则抛 [FormatException],由 CLI 转成
/// 退出码 64、给出可读的错误信息(而不是让某个 KEY 悄悄变成空字符串)。
MapEntry<String, String> parseDartDefineEntry(String raw) {
  final idx = raw.indexOf('=');
  if (idx <= 0) {
    throw FormatException(
        '--dart-define 格式错误:"$raw"(必须是 KEY=VALUE 形式,KEY 不能为空)');
  }
  return MapEntry(raw.substring(0, idx), raw.substring(idx + 1));
}

/// 合并 `mp_flutter.yaml` 的 `dart_define` 与命令行 `--dart-define`。
///
/// 优先级:命令行同名 KEY 覆盖 yaml 里的值,但**不改变原有位置**——Dart 的
/// `Map` 默认按插入顺序迭代,给已存在的 key 重新赋值不会把它挪到末尾。命令行
/// 独有的新 KEY 按命令行出现顺序追加在末尾。整体顺序稳定,方便产物可复现、
/// 排查构建参数。
///
/// [fromCli] 里任意一条格式错误都会让整个调用抛 [FormatException]
/// (见 [parseDartDefineEntry])。
List<String> mergeDartDefines(Map<String, String> fromYaml, List<String> fromCli) {
  final merged = Map<String, String>.of(fromYaml);
  for (final raw in fromCli) {
    final entry = parseDartDefineEntry(raw);
    merged[entry.key] = entry.value;
  }
  return [for (final e in merged.entries) '${e.key}=${e.value}'];
}

/// 合并 `mp_flutter.yaml` 的 `private_infos` 与命令行 `--private-info`。
///
/// 按先出现顺序去重:yaml 里的条目在前,命令行独有的新条目按出现顺序追加在
/// 末尾(与已有条目重复的命令行条目不会再挪位置/重复出现)。
///
/// yaml 侧的取值已经在 [loadConfig] 里校验过(见 `asPrivateInfoList`);这里
/// 只校验 [fromCli] ——不在 [kAllowedPrivateInfos] 里的值会抛 [FormatException]
/// (由调用方转成退出码 64)。合并结果同时含 `getLocation` 与 `getFuzzyLocation`
/// 时也抛 [FormatException]——微信不允许一个小程序同时声明这两个定位接口。
List<String> mergePrivateInfos(List<String> fromYaml, List<String> fromCli) {
  final merged = <String>[];
  for (final v in fromYaml) {
    if (!merged.contains(v)) merged.add(v);
  }
  for (final v in fromCli) {
    if (!kAllowedPrivateInfos.contains(v)) {
      throw FormatException(
          '--private-info 不支持的取值:"$v"(仅支持:${kAllowedPrivateInfos.join(', ')})');
    }
    if (!merged.contains(v)) merged.add(v);
  }
  if (merged.contains('getLocation') && merged.contains('getFuzzyLocation')) {
    throw FormatException('private_infos 不能同时包含 getLocation 与 getFuzzyLocation'
        '(微信不允许同一小程序同时声明这两个定位接口)');
  }
  return merged;
}
