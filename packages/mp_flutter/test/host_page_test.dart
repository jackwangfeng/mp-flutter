import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:mp_flutter/src/pipeline.dart';

/// 在 node 里用假 Page/wx/require 跑生成的承载页,返回 [scenario] 打印的 JSON。
///
/// [bootMode]:'reentry' 让 boot() 以 MP_REENTRY reject;'ok' 让它 resolve。
/// [scenario] 是一段 JS,可用 `page`(已 onLoad 的实例)、`calls`(调用记录)、
/// `done(obj)`(输出结果)。
Future<Map<String, dynamic>> runHostPage(String js,
    {required String bootMode, Map<String, dynamic> options = const {}, required String scenario}) async {
  final dir = Directory.systemTemp.createTempSync('mpf_host_');
  addTearDown(() => dir.deleteSync(recursive: true));
  File('${dir.path}/page.js').writeAsStringSync(js);
  File('${dir.path}/run.js').writeAsStringSync('''
const src = require('fs').readFileSync(__dirname + '/page.js', 'utf8');
const calls = [];
let def = null;
const wx = {
  createSelectorQuery: () => ({ select: () => ({ node: (cb) => ({ exec: () => cb({ node: {} }) }) }) }),
  getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, pixelRatio: 3 }),
  restartMiniProgram: (o) => calls.push('restart ' + o.path),
  showModal: () => {},
  showShareMenu: (o) => calls.push('showShareMenu ' + JSON.stringify(o.menus)),
};
// 假 CanvasKit Surface 与 GL:scenario 改 pixel 后调 flush() 模拟一帧
function FakeSurface() {}
FakeSurface.prototype.flush = function () { return 'flushed'; };
let pixel = [0, 0, 0, 0];
const gl = { drawingBufferWidth: 100, drawingBufferHeight: 100, RGBA: 0, UNSIGNED_BYTE: 0,
  readPixels: (x, y, w, h, f, t, out) => out.set(pixel) };
const flush = () => new FakeSurface().flush();
const app = {};
const reentry = Object.assign(new Error('reentry'), { code: 'MP_REENTRY' });
const req = (p) => {
  if (/boot\\.js\$/.test(p)) return { boot: (o) => { globalThis.__onStage = o.onStage; globalThis.__bootOpts = o; calls.push('boot platform=' + o.platform + (o.simulate ? ' simulate=' + o.simulate : ''));
    return ${bootMode == 'reentry' ? 'Promise.reject(reentry)' : "Promise.resolve({ shim: { pointerState: { down: 0 } }, CK: { Surface: FakeSurface } })"}; } };
  if (/canvaskit-loader\\.js\$/.test(p)) return { acquireGlContext: () => gl };
  if (/touch-bridge\\.js\$/.test(p)) return { createTouchBridge: () => ({ cancelAll() {}, handle() {} }) };
  if (/text-bridge\\.js\$/.test(p)) return {
    createViewSync: () => ({ apply() {}, nativeInput() {} }),
    createTextBridge: () => ({
      nativeBlur: (s) => calls.push('nativeBlur ' + s),
      pause: () => calls.push('pause'), resume: () => calls.push('resume'),
      nativeInput() {}, nativeConfirm() {}, dispose() {}, wake: () => calls.push('wake'),
    }),
  };
  if (/native-views\\.js\$/.test(p)) return {
    createNativeViews: () => ({
      dispatchEvent: (id, type) => calls.push('dispatchEvent ' + id + ' ' + type),
      stop: () => calls.push('nativeStop'),
    }),
  };
  if (/semantics-mirror\\.js\$/.test(p)) return {
    createSemanticsMirror: () => ({
      start: () => calls.push('semanticsMirrorStart'),
      stop: () => calls.push('semanticsMirrorStop'),
    }),
  };
  if (/perf-hud\\.js\$/.test(p)) return {
    createBootTimer: (o) => ({
      mark: (stage) => calls.push('bootMark:' + stage),
      finish: () => calls.push('bootFinish'),
    }),
    createFrameProf: () => ({ frame() {}, take() { return null; } }),
    createPkgTrace: (o) => ({ fake: 'pkgTrace', hasWx: !!o.wx, t0: o.t0 }),
    createPerfHud: () => ({
      note: () => {},
      start: () => calls.push('perfHudStart'),
      stop: () => calls.push('perfHudStop'),
    }),
  };
  return {};   // mp-manifest.js
};
const quiet = { log() {}, error() {} };
new Function('Page', 'wx', 'require', 'getApp', 'console', src)((o) => { def = o; }, wx, req, () => app, quiet);
const page = Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)),
  setData(patch) { Object.assign(this.data, patch); } });
page.onLoad(${jsonEncode(options)});
// 输出后立即退出:承载页有 3 秒的启动界面兜底定时器,不必等它
const done = (o) => process.stdout.write(JSON.stringify(o) + '\\n', () => process.exit(0));
setTimeout(() => { $scenario }, 20);
''');
  final r = await Process.run('node', ['${dir.path}/run.js']);
  expect(r.exitCode, 0, reason: r.stderr.toString());
  return jsonDecode(r.stdout.toString().trim().split('\n').last) as Map<String, dynamic>;
}

void main() {
  group('buildHostPageJs 参数', () {
    test('--force-platform 只能与 --verify 同用', () {
      expect(() => buildHostPageJs(verify: false, forcePlatform: 'android'), throwsArgumentError);
    });
    test('--force-platform 只接受 ios/android/android-noIntl', () {
      expect(() => buildHostPageJs(verify: true, forcePlatform: 'harmony'), throwsArgumentError);
    });
    test('非 verify 构建不传平台覆盖', () {
      expect(buildHostPageJs(verify: false), isNot(contains('platform:')));
    });
  });

  test('--force-platform android:承载页把平台覆盖传给 boot', () async {
    final r = await runHostPage(buildHostPageJs(verify: true, forcePlatform: 'android'),
        bootMode: 'ok', scenario: 'done({ calls });');
    expect(r['calls'], contains('boot platform=android'));
  });

  test('--force-platform ios:平台 ios,并让垫片模拟 JavaScriptCore(无 v8BreakIterator/Segmenter)', () async {
    final r = await runHostPage(buildHostPageJs(verify: true, forcePlatform: 'ios'),
        bootMode: 'ok', scenario: 'done({ calls });');
    expect(r['calls'], contains('boot platform=ios simulate=ios'));
  });

  test('--force-platform android-noIntl:平台 android,并让垫片模拟没有 Intl', () async {
    final r = await runHostPage(buildHostPageJs(verify: true, forcePlatform: 'android-noIntl'),
        bootMode: 'ok', scenario: 'done({ calls });');
    expect(r['calls'], contains('boot platform=android simulate=android-noIntl'));
  });

  test('--verify 像素上报:每帧读取,只在与上次上报值不同时上报', () async {
    final r = await runHostPage(buildHostPageJs(verify: true), bootMode: 'ok', scenario: '''
      const ret = flush();
      flush(); flush();                       // 未变化:不重复上报
      pixel = [255, 0, 0, 255]; flush(); flush();
      for (let i = 0; i < 10; i++) flush();   // 远超旧的 5 帧上限
      pixel = [0, 255, 0, 255]; flush();
      done({ ret, px: app.__mpVerify.filter((l) => l.startsWith('PIXEL|')) });''');
    expect(r['ret'], 'flushed');
    expect(r['px'], [
      'PIXEL|center|0,0,0,0', 'PIXEL|corner|0,0,0,0',
      'PIXEL|center|255,0,0,255', 'PIXEL|corner|255,0,0,255',
      'PIXEL|center|0,255,0,255', 'PIXEL|corner|0,255,0,255',
    ]);
  });

  test('--verify 承载页 JS 语法有效(node --check)', () async {
    final dir = Directory.systemTemp.createTempSync('mpf_host_chk_');
    addTearDown(() => dir.deleteSync(recursive: true));
    final f = File('${dir.path}/page.js')..writeAsStringSync(buildHostPageJs(verify: true));
    final r = await Process.run('node', ['--check', f.path]);
    expect(r.exitCode, 0, reason: r.stderr.toString());
  });

  test('默认构建承载页 JS 语法有效(node --check),且含分享钩子', () async {
    final dir = Directory.systemTemp.createTempSync('mpf_host_chk2_');
    addTearDown(() => dir.deleteSync(recursive: true));
    final js = buildHostPageJs(verify: false);
    final f = File('${dir.path}/page.js')..writeAsStringSync(js);
    final r = await Process.run('node', ['--check', f.path]);
    expect(r.exitCode, 0, reason: r.stderr.toString());
    expect(js, contains('onShareAppMessage'));
    expect(js, contains('onShareTimeline'));
  });

  test('onLoad 声明分享菜单(showShareMenu 不存在时忽略,不报错)', () async {
    final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: 'done({ calls });');
    expect(r['calls'], contains('showShareMenu ["shareAppMessage","shareTimeline"]'));
  });

  test('onShareAppMessage:未设置分享信息时只带默认 path', () async {
    final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
      done({ msg: page.onShareAppMessage(), timeline: page.onShareTimeline() });''');
    expect(r['msg'], {'path': '/pages/flutter/flutter'});
    expect(r['timeline'], <String, dynamic>{});
  });

  test('onShareAppMessage/onShareTimeline:设置分享信息后返回设置值', () async {
    final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
      page.mpShim = { wechat: { getShareInfo: () => ({ title: '限时特惠', path: '/pages/flutter/flutter?sku=1', imageUrl: 'a.png', query: 'sku=1' }) } };
      done({ msg: page.onShareAppMessage(), timeline: page.onShareTimeline() });''');
    expect(r['msg'], {
      'path': '/pages/flutter/flutter?sku=1',
      'title': '限时特惠',
      'imageUrl': 'a.png',
    });
    expect(r['timeline'], {'title': '限时特惠', 'query': 'sku=1', 'imageUrl': 'a.png'});
  });

  test('默认构建:boot 不带平台覆盖(按真机平台)', () async {
    final r = await runHostPage(buildHostPageJs(verify: false),
        bootMode: 'ok', scenario: 'done({ calls });');
    expect(r['calls'], contains('boot platform=undefined'));
  });

  test('重入:重启小程序,path 带 mpRestarted=1', () async {
    final r = await runHostPage(buildHostPageJs(verify: false),
        bootMode: 'reentry', scenario: 'done({ calls, err: page.data.mpError });');
    expect(r['calls'], contains('restart /pages/flutter/flutter?mpRestarted=1'));
    expect(r['err'], '');
  });

  test('重启后仍重入:直接报错,不再重启(防循环)', () async {
    final r = await runHostPage(buildHostPageJs(verify: false),
        bootMode: 'reentry', options: {'mpRestarted': '1'},
        scenario: 'done({ calls, err: page.data.mpError });');
    expect((r['calls'] as List).where((c) => '$c'.startsWith('restart')), isEmpty);
    expect(r['err'], contains('重启后仍检测到引擎重入'));
  });

  test('onMpBlur 把原生框的 data-session 交给桥比对', () async {
    final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
      page.onMpBlur({ currentTarget: { dataset: { session: 3 } } });
      page.onMpBlur({});
      done({ calls });''');
    expect(r['calls'], containsAllInOrder(['nativeBlur 3', 'nativeBlur undefined']));
  });

  test('onHide 暂停文本桥轮询,onShow 恢复', () async {
    final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
      page.onHide(); page.onShow();
      done({ calls });''');
    expect(r['calls'], containsAllInOrder(['pause', 'resume']));
  });

  test('初始数据带 mpNative/mpNativeList,供原生组件的 wx:for 绑定', () async {
    final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
      done({ mpNative: page.data.mpNative, mpNativeList: page.data.mpNativeList });''');
    expect(r['mpNative'], <String, dynamic>{});
    expect(r['mpNativeList'], <dynamic>[]);
  });

  test('onMpNativeEvent 把 dataset.mpid 与事件类型转发给原生视图同步层', () async {
    final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
      page.onMpNativeEvent({ type: 'timeupdate', currentTarget: { dataset: { mpid: '7' } } });
      done({ calls });''');
    expect(r['calls'], contains('dispatchEvent 7 timeupdate'));
  });

  test('onUnload 停止原生视图同步层', () async {
    final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
      page.onUnload();
      done({ calls });''');
    expect(r['calls'], contains('nativeStop'));
  });

  group('--semantics-mirror(默认关)', () {
    test('默认(false)不 require semantics-mirror.js,也不启动伴生层', () async {
      final js = buildHostPageJs(verify: false);
      expect(js, isNot(contains('semantics-mirror.js')));
      final r = await runHostPage(js, bootMode: 'ok', scenario: 'done({ calls });');
      expect(r['calls'], isNot(contains('semanticsMirrorStart')));
    });

    test('打开后:boot 成功即 start(),onUnload 时 stop()', () async {
      final js = buildHostPageJs(verify: false, semanticsMirror: true);
      expect(js, contains('semantics-mirror.js'));
      final r = await runHostPage(js, bootMode: 'ok', scenario: '''
        page.onUnload();
        done({ calls });''');
      expect(r['calls'], containsAllInOrder(['semanticsMirrorStart', 'semanticsMirrorStop']));
    });

    test('初始数据带 mpSemantics 空数组,供 wx:for 绑定', () async {
      final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
        done({ mpSemantics: page.data.mpSemantics });''');
      expect(r['mpSemantics'], <dynamic>[]);
    });
  });

  test('shader_warmup:默认告诉 boot 预热,关闭时显式 shaderWarmup: false', () {
    expect(buildHostPageJs(verify: false), contains('shaderWarmup: true'));
    expect(buildHostPageJs(verify: false, shaderWarmup: false), contains('shaderWarmup: false'));
  });

  test('shader_warmup_light:默认 false,开启时显式告诉 boot 只画轻项', () {
    expect(buildHostPageJs(verify: false), contains('shaderWarmupLight: false'));
    expect(buildHostPageJs(verify: false, shaderWarmupLight: true), contains('shaderWarmupLight: true'));
  });

  test('onMpTouch 维护 mpShim.pointerState.down(供 shader-warmup 判断手指是否按着);onHide 清零', () async {
    final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
      const seen = [];
      page.onMpTouch({ type: 'touchstart', touches: [{}] });
      seen.push(page.mpShim.pointerState.down);
      page.onMpTouch({ type: 'touchstart', touches: [{}, {}] });
      seen.push(page.mpShim.pointerState.down);
      page.onMpTouch({ type: 'touchend', touches: [{}] });
      seen.push(page.mpShim.pointerState.down);
      page.onHide();
      seen.push(page.mpShim.pointerState.down);
      done({ seen });
    ''');
    expect(r['seen'], [1, 2, 1, 0]);
  });

  // M4 修复:按事件次数 ±1 时,两根手指分两次 touchstart 按下、一个 touchend
  // (changedTouches 含 2 个,e.touches 变空)一起抬起,down 会一直卡在 1。
  // 改成直接取 e.touches.length 后,一次 touchend 清空 touches 就能归零。
  test('M4 修复:一次 touchend 抬起多根手指(e.touches 变空)后 down 立即归零,不卡住', () async {
    final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
      const seen = [];
      page.onMpTouch({ type: 'touchstart', touches: [{}] });
      seen.push(page.mpShim.pointerState.down);
      page.onMpTouch({ type: 'touchstart', touches: [{}, {}] });
      seen.push(page.mpShim.pointerState.down);
      page.onMpTouch({ type: 'touchend', touches: [] });
      seen.push(page.mpShim.pointerState.down);
      done({ seen });
    ''');
    expect(r['seen'], [1, 2, 0]);
  });

  test('onMpTouch 没有 touches 字段时按 0 处理', () async {
    final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
      page.onMpTouch({ type: 'touchstart' });
      done({ down: page.mpShim.pointerState.down });
    ''');
    expect(r['down'], 0);
  });

  group('--perf-hud(默认关)', () {
    test('默认(false)不 require perf-hud.js,也不打计时/不启动 HUD', () async {
      final js = buildHostPageJs(verify: false);
      expect(js, isNot(contains('perf-hud.js')));
      final r = await runHostPage(js, bootMode: 'ok', scenario: 'done({ calls });');
      expect(r['calls'], isNot(anyElement(contains('perfHud'))));
      expect(r['calls'], isNot(anyElement(contains('bootMark'))));
    });

    test('打开后:onLoad 即打 onLoad 阶段计时,boot 成功即启动 HUD,onUnload 时停止', () async {
      final js = buildHostPageJs(verify: false, perfHud: true);
      expect(js, contains('perf-hud.js'));
      // 首帧前的诊断行(合一字体 fetch/解析)经 boot 的 perfLog 打出;HUD 拿到解析去重统计
      expect(js, contains('perfLog: (line) => console.log(line)'));
      expect(js, contains('typefaceMemo: r.shim.typefaceMemo'));
      expect(buildHostPageJs(verify: false), isNot(contains('perfLog')));
      final r = await runHostPage(js, bootMode: 'ok', scenario: '''
        page.onUnload();
        done({ calls });''');
      expect(r['calls'], contains('bootMark:onLoad'));
      expect(r['calls'], containsAllInOrder(['perfHudStart', 'perfHudStop']));
    });

    test('打开后:分包时间线(createPkgTrace)以 wx 与同一 t0 建好,经 pkgTrace 传给 boot', () async {
      final r = await runHostPage(buildHostPageJs(verify: false, perfHud: true), bootMode: 'ok', scenario: '''
        done({ trace: __bootOpts.pkgTrace });''');
      expect(r['trace']['fake'], 'pkgTrace');
      expect(r['trace']['hasWx'], true);
      final off = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
        done({ has: 'pkgTrace' in __bootOpts });''');
      expect(off['has'], false);
    });

    test('初始数据带 mpPerf(fps/avg 面板初始值),浮层默认不可见', () async {
      final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
        done({ mpPerf: page.data.mpPerf });''');
      expect(r['mpPerf'], {'visible': false, 'fps': 0, 'avg': 0});
    });
  });

  group('原生启动界面(首帧前)', () {
    test('初始可见、进度 0;每个启动阶段推进度(不超过 95%),首帧提交即移除', () async {
      final r = await runHostPage(buildHostPageJs(verify: false, bootStages: 4), bootMode: 'ok', scenario: '''
        const init = Object.assign({}, page.data.mpSplash);
        __onStage('subpackage:pkg-dart-0'); const p1 = page.data.mpSplash.progress;
        __onStage('canvaskit'); __onStage('crypto'); __onStage('dart-chunks'); __onStage('dart-main');
        const p5 = page.data.mpSplash.progress;
        __onStage('first-frame');
        done({ init, p1, p5, after: page.data.mpSplash });''');
      expect(r['init'], {'visible': true, 'progress': 0, 'error': ''});
      expect(r['p1'], 25);
      expect(r['p5'], 95);
      expect((r['after'] as Map)['visible'], false);
    });

    test('启动失败(首帧前):错误文案写到启动界面上,不留黑屏', () async {
      final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'reentry',
          options: {'mpRestarted': '1'}, scenario: 'done({ sp: page.data.mpSplash });');
      final sp = r['sp'] as Map;
      expect(sp['visible'], true);
      expect(sp['error'], contains('重入'));
    });

    test('首帧之后的失败不盖住页面(只写 mpError)', () async {
      final r = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
        __onStage('first-frame'); page.fail('late');
        done({ sp: page.data.mpSplash, err: page.data.mpError });''');
      expect((r['sp'] as Map)['visible'], false);
      expect((r['sp'] as Map)['error'], '');
      expect(r['err'], 'late');
    });

    test('perf-hud 打开时 onStage 同时喂给启动计时器与启动界面', () async {
      final r = await runHostPage(buildHostPageJs(verify: false, perfHud: true), bootMode: 'ok', scenario: '''
        __onStage('canvaskit'); __onStage('first-frame');
        done({ calls, sp: page.data.mpSplash });''');
      expect(r['calls'], containsAllInOrder(['bootMark:canvaskit', 'bootMark:first-frame', 'bootFinish']));
      expect((r['sp'] as Map)['visible'], false);
    });
  });

  group('冷启动开关透传给 boot', () {
    test('默认 earlyWasm=true、粗体 after-first-frame;可分别关掉', () async {
      final d = await runHostPage(buildHostPageJs(verify: false), bootMode: 'ok', scenario: '''
        done({ early: __bootOpts.earlyWasm, bold: __bootOpts.cjkBoldTiming });''');
      expect(d, {'early': true, 'bold': 'after-first-frame'});
      final o = await runHostPage(buildHostPageJs(verify: false, earlyWasm: false, cjkFontBoldTiming: 'eager'),
          bootMode: 'ok', scenario: '''
        done({ early: __bootOpts.earlyWasm, bold: __bootOpts.cjkBoldTiming });''');
      expect(o, {'early': false, 'bold': 'eager'});
    });
  });
}
