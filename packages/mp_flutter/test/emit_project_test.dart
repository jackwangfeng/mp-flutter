import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:mp_flutter/src/emit_project.dart';

void main() {
  late ProjectFiles files;

  setUp(() {
    files = emitProject(
      appId: 'touristappid',
      subPackageRoots: const ['pkg-wasm', 'pkg-assets'],
      entryPagePath: 'pages/flutter/flutter',
    );
  });

  test('产出 app.json / project.config.json / sitemap.json / app.js', () {
    expect(files.textFiles.keys, containsAll(
        ['app.json', 'project.config.json', 'sitemap.json', 'app.js']));
  });

  test('app.json 首页是 Flutter 承载页', () {
    final app = jsonDecode(files.textFiles['app.json']!) as Map<String, dynamic>;
    expect((app['pages'] as List).first, 'pages/flutter/flutter');
  });

  test('app.json 声明所有分包', () {
    final app = jsonDecode(files.textFiles['app.json']!) as Map<String, dynamic>;
    final roots = (app['subPackages'] as List)
        .map((e) => (e as Map)['root'] as String).toList();
    expect(roots, containsAll(['pkg-wasm', 'pkg-assets']));
  });

  test('每个分包都声明占位页(pages 为空数组会被开发者工具拒绝)并生成对应文件', () {
    final app = jsonDecode(files.textFiles['app.json']!) as Map<String, dynamic>;
    for (final sub in (app['subPackages'] as List).cast<Map<String, dynamic>>()) {
      expect(sub['pages'], [kPlaceholderPage]);
      for (final ext in ['js', 'wxml', 'json']) {
        expect(files.textFiles, contains('${sub['root']}/$kPlaceholderPage.$ext'));
      }
    }
  });

  test('preloadRoots 只预下载指定分包;为空时不写 preloadRule', () {
    final some = emitProject(
      appId: 'x', subPackageRoots: const ['a', 'b'], entryPagePath: 'pages/f/f',
      preloadRoots: const ['a'],
    );
    final app = jsonDecode(some.textFiles['app.json']!) as Map<String, dynamic>;
    expect(((app['preloadRule'] as Map)['pages/f/f'] as Map)['packages'], ['a']);

    final none = emitProject(
      appId: 'x', subPackageRoots: const ['a'], entryPagePath: 'pages/f/f',
      preloadRoots: const [],
    );
    expect(jsonDecode(none.textFiles['app.json']!), isNot(contains('preloadRule')));
  });

  group('selectPreloadPackages(同一包内页面预下载总额 2MB)', () {
    const kb = 1024;
    test('按顺序贪心,放不下的跳过但继续尝试后面更小的', () {
      final r = selectPreloadPackages(
        ['wasm', 'dart', 'assets0'],
        {'wasm': 1500 * kb, 'dart': 1800 * kb, 'assets0': 400 * kb},
      );
      expect(r, ['wasm', 'assets0']);
    });
    test('总量在额度内时全部预下载', () {
      expect(selectPreloadPackages(['a', 'b'], {'a': 100, 'b': 200}), ['a', 'b']);
    });
  });

  test('为入口页配置分包预下载', () {
    final app = jsonDecode(files.textFiles['app.json']!) as Map<String, dynamic>;
    final rule = (app['preloadRule'] as Map)['pages/flutter/flutter'] as Map;
    expect(rule['packages'], containsAll(['pkg-wasm', 'pkg-assets']));
    expect(rule['network'], 'all');
  });

  test('承载页 wxml 含 webgl 画布', () {
    final wxml = files.textFiles['pages/flutter/flutter.wxml']!;
    expect(wxml, contains('type="webgl"'));
    expect(wxml, contains('id="flutter-canvas"'));
  });

  test('承载页 wxml 含原生视图同层叠加模板(Phase 5 Task 2)', () {
    final wxml = files.textFiles['pages/flutter/flutter.wxml']!;
    expect(wxml, contains('wx:for="{{mpNativeList}}"'));
    expect(wxml, contains('class="mp-native-clip"'));
    expect(wxml, contains("mpNative[mpNid].type === 'video'"));
    expect(wxml, contains("mpNative[mpNid].type === 'map'"));
    expect(wxml, contains("mpNative[mpNid].type === 'camera'"));
    expect(wxml, contains('data-mpid="{{mpNid}}"'));
    expect(wxml, contains('bindtimeupdate="onMpNativeEvent"'));
    // Minor 4:<video> 补绑 poster(params 里已经有这个字段,以前 WXML 没读它)
    expect(wxml, contains('poster="{{mpNative[mpNid].params.poster}}"'));
  });

  test('承载页 wxml 含 WXML 伴生层模板(Phase 5 Task 4,视觉隐藏+不可交互)', () {
    final wxml = files.textFiles['pages/flutter/flutter.wxml']!;
    final wxss = files.textFiles['pages/flutter/flutter.wxss']!;
    expect(wxml, contains('wx:for="{{mpSemantics}}"'));
    expect(wxml, contains('class="mp-semantics-mirror"'));
    expect(wxml, contains('{{mps.label}}'));
    expect(wxss, contains('.mp-semantics-mirror'));
    expect(wxss, contains('opacity: 0'));
    expect(wxss, contains('pointer-events: none'));
  });

  group('--perf-hud(默认关)', () {
    test('默认(false)不生成浮层/onLaunch 计时,连不注入的原则也适用于 wxml/wxss/app.js', () {
      expect(files.textFiles['pages/flutter/flutter.wxml'], isNot(contains('mp-perf-hud')));
      expect(files.textFiles['pages/flutter/flutter.wxss'], isNot(contains('mp-perf-hud')));
      expect(files.textFiles['app.js'], isNot(contains('onLaunch')));
      expect(files.textFiles['app.js'], isNot(contains('__mpBootT0')));
    });

    test('打开后:wxml 含可开关浮层(pointer-events:none),app.js 的 onLaunch 记时间戳', () {
      final on = emitProject(
        appId: 'touristappid',
        subPackageRoots: const ['pkg-wasm', 'pkg-assets'],
        entryPagePath: 'pages/flutter/flutter',
        perfHud: true,
      );
      final wxml = on.textFiles['pages/flutter/flutter.wxml']!;
      final wxss = on.textFiles['pages/flutter/flutter.wxss']!;
      final appJs = on.textFiles['app.js']!;
      expect(wxml, contains('class="mp-perf-hud"'));
      expect(wxml, contains('wx:if="{{mpPerf.visible}}"'));
      expect(wxml, contains('{{mpPerf.fps}}'));
      expect(wxss, contains('.mp-perf-hud'));
      expect(wxss, contains('pointer-events: none'));
      expect(appJs, contains('onLaunch()'));
      expect(appJs, contains('this.__mpBootT0 = Date.now();'));
    });
  });

  test('原生输入框带会话标记(onMpBlur 据此丢弃被销毁旧框迟到的 blur)', () {
    final wxml = files.textFiles['pages/flutter/flutter.wxml']!;
    expect('data-session="{{mpInput.session}}"'.allMatches(wxml), hasLength(2),
        reason: 'input 与 textarea 都要带');
  });

  test('产出的每个 JS 文件都能通过 node --check(语法错误会让整个小程序起不来)', () {
    final dir = Directory.systemTemp.createTempSync('mpf_emit_js_');
    addTearDown(() => dir.deleteSync(recursive: true));
    for (final e in files.textFiles.entries.where((e) => e.key.endsWith('.js'))) {
      final f = File('${dir.path}/${e.key}')..createSync(recursive: true);
      f.writeAsStringSync(e.value);
      final r = Process.runSync('node', ['--check', f.path]);
      expect(r.exitCode, 0, reason: '${e.key} 语法错误:\n${r.stderr}');
    }
  });

  test('app.js 捕获未处理错误,避免静默黑屏', () {
    expect(files.textFiles['app.js']!, contains('onError'));
    expect(files.textFiles['app.js']!, contains('onUnhandledRejection'));
  });

  test('appId 写入 project.config.json', () {
    final cfg = jsonDecode(files.textFiles['project.config.json']!) as Map<String, dynamic>;
    expect(cfg['appid'], 'touristappid');
  });

  test('es6/enhance 关闭:否则上传时再编译会让 dart 分片膨胀超 2048KB', () {
    final cfg = jsonDecode(files.textFiles['project.config.json']!) as Map<String, dynamic>;
    final setting = cfg['setting'] as Map<String, dynamic>;
    expect(setting['es6'], isFalse);
    expect(setting['enhance'], isFalse);
  });

  test('requireLocation:app.json 声明 getLocation 隐私接口与权限说明;默认不声明', () {
    final on = jsonDecode(emitProject(appId: 'x', subPackageRoots: const [], entryPagePath: 'pages/f/f',
        requireLocation: true).textFiles['app.json']!) as Map<String, dynamic>;
    expect(on['requiredPrivateInfos'], ['getLocation']);
    expect(((on['permission'] as Map)['scope.userLocation'] as Map)['desc'], isNotEmpty);
    final off = jsonDecode(emitProject(appId: 'x', subPackageRoots: const [], entryPagePath: 'pages/f/f')
        .textFiles['app.json']!) as Map<String, dynamic>;
    expect(off.containsKey('requiredPrivateInfos'), isFalse);
  });

  group('privateInfos', () {
    test('多个定位类接口:全部写进 requiredPrivateInfos,并声明 scope.userLocation', () {
      final app = jsonDecode(emitProject(
        appId: 'x', subPackageRoots: const [], entryPagePath: 'pages/f/f',
        privateInfos: const ['chooseLocation', 'choosePoi'],
      ).textFiles['app.json']!) as Map<String, dynamic>;
      expect(app['requiredPrivateInfos'], ['chooseLocation', 'choosePoi']);
      expect(((app['permission'] as Map)['scope.userLocation'] as Map)['desc'], isNotEmpty);
    });

    test('chooseAddress 是地址簿,不属于定位权限:不声明 scope.userLocation', () {
      final app = jsonDecode(emitProject(
        appId: 'x', subPackageRoots: const [], entryPagePath: 'pages/f/f',
        privateInfos: const ['chooseAddress'],
      ).textFiles['app.json']!) as Map<String, dynamic>;
      expect(app['requiredPrivateInfos'], ['chooseAddress']);
      expect(app.containsKey('permission'), isFalse);
    });

    test('requireLocation 与 privateInfos 同时传:合并去重(getLocation 不重复出现)', () {
      final app = jsonDecode(emitProject(
        appId: 'x', subPackageRoots: const [], entryPagePath: 'pages/f/f',
        requireLocation: true,
        privateInfos: const ['getLocation', 'chooseLocation'],
      ).textFiles['app.json']!) as Map<String, dynamic>;
      expect(app['requiredPrivateInfos'], ['getLocation', 'chooseLocation']);
    });
  });

  test('setting 与真机验证通过的配置一致', () {
    final cfg = jsonDecode(files.textFiles['project.config.json']!) as Map<String, dynamic>;
    final setting = cfg['setting'] as Map<String, dynamic>;
    // 真机 iPhone 15 / iOS 26.5 实测通过时的值,不要随意改动(es6/enhance 见下一条用例)
    expect(setting['minified'], isFalse,
        reason: 'minified:true 会对 dart2js 产物再压一遍,未经真机验证');
    expect(cfg['libVersion'], '3.15.0');
  });
  group('原生启动界面(首帧前)', () {
    test('wxml 含启动层:应用名(转义)、进度条、错误文案;wxss 用 splash_color 背景', () {
      final f = emitProject(appId: 'x', subPackageRoots: const [], entryPagePath: 'pages/f/f',
          splashTitle: 'A&B <店>', splashColor: '#123');
      final wxml = f.textFiles['pages/f/f.wxml']!;
      expect(wxml, contains('wx:if="{{mpSplash.visible}}"'));
      expect(wxml, contains('A&amp;B &lt;店&gt;'));
      expect(wxml, contains('width:{{mpSplash.progress}}%'));
      expect(wxml, contains('{{mpSplash.error}}'));
      final wxss = f.textFiles['pages/f/f.wxss']!;
      expect(wxss, contains('background: #112233'));
      expect(wxss, contains('color: #f2f2f2'), reason: '深色背景配浅色字');
      final app = jsonDecode(f.textFiles['app.json']!) as Map<String, dynamic>;
      expect((app['window'] as Map)['navigationBarTitleText'], 'A&B <店>');
    });

    test('默认白色背景配深色字', () {
      expect(files.textFiles['pages/flutter/flutter.wxss'], contains('background: #ffffff'));
      expect(files.textFiles['pages/flutter/flutter.wxss'], contains('color: #333333'));
    });

    test('splash_color 校验', () {
      expect(normalizeSplashColor('#ABC'), '#aabbcc');
      expect(normalizeSplashColor(' #A0b1C2 '), '#a0b1c2');
      for (final bad in ['red', '#12', '#1234567', 'rgb(0,0,0)']) {
        expect(() => normalizeSplashColor(bad), throwsFormatException, reason: bad);
      }
    });
  });

  test('ignoreDirs 写进 packOptions.ignore(远端字体待上传目录不进代码包);默认不写', () {
    final f = emitProject(appId: 'x', subPackageRoots: const [], entryPagePath: 'pages/f/f',
        ignoreDirs: const ['mp-fonts-remote']);
    final cfg = jsonDecode(f.textFiles['project.config.json']!) as Map<String, dynamic>;
    expect((cfg['packOptions'] as Map)['ignore'], [{'type': 'folder', 'value': 'mp-fonts-remote'}]);
    expect(jsonDecode(files.textFiles['project.config.json']!), isNot(contains('packOptions')));
  });
}
