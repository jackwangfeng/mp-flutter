import 'package:test/test.dart';
import 'package:mp_flutter/src/config.dart';

void main() {
  group('findProjectRoot —— 向上查找工程根', () {
    test('起始目录自身就是工程根:直接返回', () {
      final files = {
        '/repo/app/pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n',
      };
      final root = findProjectRoot(
        '/repo/app',
        fileExists: (path) => files.containsKey(path),
        readFile: (path) => files[path]!,
      );
      expect(root, '/repo/app');
    });

    test('从子目录向上找到含 pubspec.yaml 且依赖 flutter 的祖先目录', () {
      final files = {
        '/repo/app/pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n',
      };
      final root = findProjectRoot(
        '/repo/app/lib/src/widgets',
        fileExists: (path) => files.containsKey(path),
        readFile: (path) => files[path]!,
      );
      expect(root, '/repo/app');
    });

    test('中途有 pubspec.yaml 但不依赖 flutter(纯 Dart 包):跳过,继续往上找', () {
      final files = {
        '/repo/app/pkg/pubspec.yaml': 'name: pkg\ndependencies:\n  path: ^1.0.0\n',
        '/repo/app/pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n',
      };
      final root = findProjectRoot(
        '/repo/app/pkg',
        fileExists: (path) => files.containsKey(path),
        readFile: (path) => files[path]!,
      );
      expect(root, '/repo/app');
    });

    test('pubspec.yaml 存在但不合法 YAML:当作不匹配,继续往上找而不崩溃', () {
      final files = {
        '/repo/app/broken/pubspec.yaml': ': not: valid: yaml: [',
        '/repo/app/pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n',
      };
      final root = findProjectRoot(
        '/repo/app/broken',
        fileExists: (path) => files.containsKey(path),
        readFile: (path) => files[path]!,
      );
      expect(root, '/repo/app');
    });

    test('一路向上都找不到:抛 ProjectRootNotFound', () {
      expect(
        () => findProjectRoot('/repo/nowhere',
            fileExists: (_) => false, readFile: (_) => throw UnimplementedError()),
        throwsA(isA<ProjectRootNotFound>()),
      );
    });
  });

  group('loadConfig —— mp_flutter.yaml', () {
    test('文件不存在:返回 MpFlutterConfig.empty,不报错', () {
      final cfg = loadConfig('/repo/app', fileExists: (_) => false);
      expect(cfg.appId, isNull);
      expect(cfg.output, isNull);
      expect(cfg.requireLocation, isNull);
    });

    test('解析全部已知键', () {
      const yaml = '''
appid: wxabc123
output: build/weapp
flutter: /opt/flutter/bin/flutter
esbuild: /opt/esbuild/bin/esbuild
require_location: true
semantics_mirror: false
safe_area: false
target: lib/custom_main.dart
perf_hud: true
''';
      final cfg = loadConfig(
        '/repo/app',
        fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
        readFile: (_) => yaml,
      );
      expect(cfg.appId, 'wxabc123');
      expect(cfg.output, 'build/weapp');
      expect(cfg.flutter, '/opt/flutter/bin/flutter');
      expect(cfg.esbuild, '/opt/esbuild/bin/esbuild');
      expect(cfg.requireLocation, true);
      expect(cfg.semanticsMirror, false);
      expect(cfg.safeArea, false);
      expect(cfg.target, 'lib/custom_main.dart');
      expect(cfg.perfHud, true);
    });

    test('shader_warmup:布尔,未配置为 null', () {
      final cfg = loadConfig('/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml', readFile: (_) => 'shader_warmup: false\n',
          warn: (m) => fail('不应有未知键警告:$m'));
      expect(cfg.shaderWarmup, false);
      final empty = loadConfig('/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml', readFile: (_) => 'appid: x\n');
      expect(empty.shaderWarmup, isNull);
    });

    test('shader_warmup_light:布尔,未配置为 null', () {
      final cfg = loadConfig('/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml', readFile: (_) => 'shader_warmup_light: true\n',
          warn: (m) => fail('不应有未知键警告:$m'));
      expect(cfg.shaderWarmupLight, true);
      final empty = loadConfig('/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml', readFile: (_) => 'appid: x\n');
      expect(empty.shaderWarmupLight, isNull);
    });

    test('体积/启动界面相关键:licenses / font_base_url / splash_title / splash_color', () {
      final cfg = loadConfig(
        '/repo/app',
        fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
        readFile: (_) => 'licenses: false\nfont_base_url: https://cdn.x.com/f/\nsplash_title: 小店\nsplash_color: "#fafafa"\n',
        warn: (m) => fail('不应有未知键警告:$m'),
      );
      expect(cfg.licenses, false);
      expect(cfg.fontBaseUrl, 'https://cdn.x.com/f/');
      expect(cfg.splashTitle, '小店');
      expect(cfg.splashColor, '#fafafa');
      final empty = loadConfig('/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml', readFile: (_) => 'appid: x\n');
      expect([empty.licenses, empty.fontBaseUrl, empty.splashTitle, empty.splashColor], [null, null, null, null]);
      expect(
        () => loadConfig('/repo/app',
            fileExists: (path) => path == '/repo/app/mp_flutter.yaml', readFile: (_) => 'licenses: "no"\n'),
        throwsA(isA<ConfigParseFailure>()),
      );
    });

    test('perf_hud 未出现在文件里:为 null(区别于显式 false)', () {
      final cfg = loadConfig(
        '/repo/app',
        fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
        readFile: (_) => 'appid: wxabc123\n',
      );
      expect(cfg.perfHud, isNull);
    });

    test('perf_hud 类型不对(不是布尔值):抛 ConfigParseFailure', () {
      expect(
        () => loadConfig(
          '/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
          readFile: (_) => 'perf_hud: not-a-bool\n',
        ),
        throwsA(isA<ConfigParseFailure>()),
      );
    });

    test('safe_area 类型不对(不是布尔值):抛 ConfigParseFailure', () {
      expect(
        () => loadConfig(
          '/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
          readFile: (_) => 'safe_area: not-a-bool\n',
        ),
        throwsA(isA<ConfigParseFailure>()),
      );
    });

    test('target 类型不对(不是字符串):抛 ConfigParseFailure', () {
      expect(
        () => loadConfig(
          '/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
          readFile: (_) => 'target:\n  - a\n  - b\n',
        ),
        throwsA(isA<ConfigParseFailure>()),
      );
    });

    test('含未知键:warn 恰好一次,不抛异常,已知键仍正常生效', () {
      const yaml = '''
appid: wxabc123
totally_unknown_key: 1
''';
      final warnings = <String>[];
      final cfg = loadConfig(
        '/repo/app',
        fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
        readFile: (_) => yaml,
        warn: warnings.add,
      );
      expect(cfg.appId, 'wxabc123');
      expect(warnings.length, 1);
      expect(warnings.single, contains('totally_unknown_key'));
    });

    test('已知键类型不对(require_location 不是布尔值):抛 ConfigParseFailure', () {
      const yaml = '''
require_location: yes-please
''';
      expect(
        () => loadConfig(
          '/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
          readFile: (_) => yaml,
        ),
        throwsA(isA<ConfigParseFailure>()),
      );
    });

    test('根节点不是映射:抛 ConfigParseFailure', () {
      const yaml = '- just\n- a\n- list\n';
      expect(
        () => loadConfig(
          '/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
          readFile: (_) => yaml,
        ),
        throwsA(isA<ConfigParseFailure>()),
      );
    });

    test('空文件:返回 empty,不报错', () {
      final cfg = loadConfig(
        '/repo/app',
        fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
        readFile: (_) => '',
      );
      expect(cfg.appId, isNull);
    });

    group('dart_define', () {
      test('解析映射,值统一 stringify', () {
        const yaml = '''
dart_define:
  API_HOST: https://example.com
  RETRY: 3
  DEBUG: true
''';
        final cfg = loadConfig(
          '/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
          readFile: (_) => yaml,
        );
        expect(cfg.dartDefine, {
          'API_HOST': 'https://example.com',
          'RETRY': '3',
          'DEBUG': 'true',
        });
      });

      test('未配置:dartDefine 为 null', () {
        final cfg = loadConfig(
          '/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
          readFile: (_) => 'appid: wx123\n',
        );
        expect(cfg.dartDefine, isNull);
      });

      test('不是映射(比如写成列表):抛 ConfigParseFailure', () {
        const yaml = '''
dart_define:
  - foo
  - bar
''';
        expect(
          () => loadConfig(
            '/repo/app',
            fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
            readFile: (_) => yaml,
          ),
          throwsA(isA<ConfigParseFailure>()),
        );
      });

      test('M10:某个值为 null(yaml 里 KEY: 空着不写值):抛 ConfigParseFailure', () {
        const yaml = '''
dart_define:
  API_HOST: https://example.com
  EMPTY_ONE:
''';
        expect(
          () => loadConfig(
            '/repo/app',
            fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
            readFile: (_) => yaml,
          ),
          throwsA(isA<ConfigParseFailure>()),
        );
      });

      test('M10:某个值不是标量(嵌套映射):抛 ConfigParseFailure', () {
        const yaml = '''
dart_define:
  NESTED:
    a: 1
''';
        expect(
          () => loadConfig(
            '/repo/app',
            fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
            readFile: (_) => yaml,
          ),
          throwsA(isA<ConfigParseFailure>()),
        );
      });

      test('M10:某个值不是标量(列表):抛 ConfigParseFailure', () {
        const yaml = '''
dart_define:
  LIST_VALUE:
    - a
    - b
''';
        expect(
          () => loadConfig(
            '/repo/app',
            fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
            readFile: (_) => yaml,
          ),
          throwsA(isA<ConfigParseFailure>()),
        );
      });
    });

    group('private_infos', () {
      test('解析列表,按声明顺序', () {
        const yaml = '''
private_infos: [chooseLocation, choosePoi]
''';
        final cfg = loadConfig(
          '/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
          readFile: (_) => yaml,
        );
        expect(cfg.privateInfos, ['chooseLocation', 'choosePoi']);
      });

      test('未配置:privateInfos 为 null', () {
        final cfg = loadConfig(
          '/repo/app',
          fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
          readFile: (_) => 'appid: wx123\n',
        );
        expect(cfg.privateInfos, isNull);
      });

      test('不是列表(比如写成映射):抛 ConfigParseFailure', () {
        const yaml = '''
private_infos:
  a: 1
''';
        expect(
          () => loadConfig(
            '/repo/app',
            fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
            readFile: (_) => yaml,
          ),
          throwsA(isA<ConfigParseFailure>()),
        );
      });

      test('元素不是字符串:抛 ConfigParseFailure', () {
        const yaml = '''
private_infos: [123]
''';
        expect(
          () => loadConfig(
            '/repo/app',
            fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
            readFile: (_) => yaml,
          ),
          throwsA(isA<ConfigParseFailure>()),
        );
      });

      test('含不支持的取值:抛 ConfigParseFailure,信息列出允许值', () {
        const yaml = '''
private_infos: [notARealApi]
''';
        expect(
          () => loadConfig(
            '/repo/app',
            fileExists: (path) => path == '/repo/app/mp_flutter.yaml',
            readFile: (_) => yaml,
          ),
          throwsA(isA<ConfigParseFailure>().having(
              (e) => e.message, 'message', contains('notARealApi'))),
        );
      });
    });
  });

  group('parseDartDefineEntry —— 命令行 --dart-define=KEY=VALUE 拆分', () {
    test('正常 KEY=VALUE', () {
      final e = parseDartDefineEntry('API_HOST=https://x.com');
      expect(e.key, 'API_HOST');
      expect(e.value, 'https://x.com');
    });

    test('VALUE 含逗号:原样保留(不当分隔符)', () {
      final e = parseDartDefineEntry('LIST=a,b,c');
      expect(e.key, 'LIST');
      expect(e.value, 'a,b,c');
    });

    test('VALUE 含等号:只在第一个 = 处切分', () {
      final e = parseDartDefineEntry('TOKEN=a=b=c');
      expect(e.key, 'TOKEN');
      expect(e.value, 'a=b=c');
    });

    test('没有 =:抛 FormatException', () {
      expect(() => parseDartDefineEntry('NOEQUALSIGN'), throwsFormatException);
    });

    test('KEY 为空:抛 FormatException', () {
      expect(() => parseDartDefineEntry('=value'), throwsFormatException);
    });
  });

  group('mergeDartDefines —— yaml 与命令行合并', () {
    test('只有 yaml:原样透出,顺序即 yaml 顺序', () {
      final merged = mergeDartDefines({'A': '1', 'B': '2'}, const []);
      expect(merged, ['A=1', 'B=2']);
    });

    test('只有命令行:按出现顺序', () {
      final merged = mergeDartDefines(const {}, ['A=1', 'B=2']);
      expect(merged, ['A=1', 'B=2']);
    });

    test('yaml + 命令行覆盖同名 KEY:值被覆盖,位置不变(仍在 yaml 里的原始位置)', () {
      final merged =
          mergeDartDefines({'A': 'from-yaml', 'B': 'keep'}, ['A=from-cli']);
      expect(merged, ['A=from-cli', 'B=keep']);
    });

    test('命令行独有的新 KEY:追加在末尾,按命令行出现顺序', () {
      final merged = mergeDartDefines({'A': '1'}, ['C=3', 'B=2']);
      expect(merged, ['A=1', 'C=3', 'B=2']);
    });

    test('命令行重复同一个 KEY:后一个值覆盖前一个', () {
      final merged = mergeDartDefines(const {}, ['A=first', 'A=second']);
      expect(merged, ['A=second']);
    });

    test('命令行条目格式错误:抛 FormatException', () {
      expect(() => mergeDartDefines(const {}, ['BAD_ENTRY']), throwsFormatException);
    });
  });

  group('mergePrivateInfos —— yaml 与命令行合并(private_infos / --private-info)', () {
    test('只有 yaml:原样透出,顺序即 yaml 顺序', () {
      expect(mergePrivateInfos(['chooseLocation', 'choosePoi'], const []),
          ['chooseLocation', 'choosePoi']);
    });

    test('只有命令行:按出现顺序', () {
      expect(mergePrivateInfos(const [], ['chooseLocation', 'choosePoi']),
          ['chooseLocation', 'choosePoi']);
    });

    test('yaml + 命令行:按先出现顺序去重,yaml 在前、命令行新增的在后', () {
      expect(
        mergePrivateInfos(['chooseLocation'], ['chooseLocation', 'choosePoi']),
        ['chooseLocation', 'choosePoi'],
      );
    });

    test('命令行含不支持的取值:抛 FormatException,信息列出允许值', () {
      expect(
        () => mergePrivateInfos(const [], ['notARealApi']),
        throwsA(isA<FormatException>().having(
            (e) => e.message, 'message', contains('notARealApi'))),
      );
    });

    test('合并结果同时含 getLocation 与 getFuzzyLocation:抛 FormatException', () {
      expect(
        () => mergePrivateInfos(['getLocation'], ['getFuzzyLocation']),
        throwsA(isA<FormatException>().having(
            (e) => e.message, 'message', contains('getFuzzyLocation'))),
      );
    });

    test('kAllowedPrivateInfos 含微信文档列出的全部取值', () {
      expect(kAllowedPrivateInfos, unorderedEquals([
        'getFuzzyLocation',
        'getLocation',
        'onLocationChange',
        'startLocationUpdate',
        'startLocationUpdateBackground',
        'chooseAddress',
        'choosePoi',
        'chooseLocation',
      ]));
    });
  });

  group('冷启动开关', () {
    MpFlutterConfig load(String yaml) => loadConfig('/r',
        fileExists: (p) => p == '/r/mp_flutter.yaml', readFile: (_) => yaml, warn: (_) {});
    test('解析 preload/cjk_font_bold_timing/early_wasm/boot_assets/initial_rendering_cache/lazy_code_loading', () {
      final c = load('preload: wasm\ncjk_font_bold_timing: eager\nearly_wasm: false\nboot_assets: package\n'
          'initial_rendering_cache: false\nlazy_code_loading: false\n');
      expect(c.preload, 'wasm');
      expect(c.cjkFontBoldTiming, 'eager');
      expect(c.earlyWasm, false);
      expect(c.bootAssets, 'package');
      expect(c.initialRenderingCache, false);
      expect(c.lazyCodeLoading, false);
      expect(load('appid: x\n').preload, isNull);
    });
    test('取值不合法显式失败', () {
      expect(() => load('preload: fast\n'), throwsA(isA<ConfigParseFailure>()));
      expect(() => load('boot_assets: 1\n'), throwsA(isA<ConfigParseFailure>()));
      expect(() => load('early_wasm: yes please\n'), throwsA(isA<ConfigParseFailure>()));
    });
  });

  group('输入(android_input / input_timing)', () {
    MpFlutterConfig load(String yaml) => loadConfig('/r',
        fileExists: (p) => p == '/r/mp_flutter.yaml', readFile: (_) => yaml, warn: (_) {});
    test('解析与缺省', () {
      final c = load('android_input: overlay\ninput_timing: true\n');
      expect(c.androidInput, 'overlay');
      expect(c.inputTiming, true);
      expect(load('appid: x\n').androidInput, isNull);
      expect(load('appid: x\n').inputTiming, isNull);
    });
    test('取值不合法显式失败', () {
      expect(() => load('android_input: hidden\n'), throwsA(isA<ConfigParseFailure>()));
      expect(() => load('input_timing: 1\n'), throwsA(isA<ConfigParseFailure>()));
    });
  });
}
