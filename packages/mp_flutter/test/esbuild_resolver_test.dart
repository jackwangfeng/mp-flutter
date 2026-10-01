import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';
import 'package:flutter_miniprogram/src/esbuild_resolver.dart';
import 'package:flutter_miniprogram/src/toolchain.dart';

ProcessResult _ok([String stdout = '']) => ProcessResult(0, 0, stdout, '');
ProcessResult _fail([String stderr = 'boom']) => ProcessResult(0, 1, '', stderr);

void main() {
  late Directory tmp;
  setUp(() => tmp = Directory.systemTemp.createTempSync('mpf_esbuild_resolver_'));
  tearDown(() => tmp.deleteSync(recursive: true));

  group('resolveEsbuild —— 解析顺序', () {
    test('1. override 且文件存在:原样返回,不碰 PATH/缓存/安装', () async {
      final f = File(p.join(tmp.path, 'esbuild'))..writeAsStringSync('');
      var called = false;
      final path = await resolveEsbuild(
        override: f.path,
        run: (exe, args, {environment, includeParentEnvironment = true}) async {
          called = true;
          return _ok();
        },
      );
      expect(path, f.path);
      expect(called, isFalse);
    });

    test('override 指定但文件不存在:抛 ToolchainMissing 并带出路径', () async {
      final missing = p.join(tmp.path, 'nope', 'esbuild');
      await expectLater(
        resolveEsbuild(override: missing),
        throwsA(isA<ToolchainMissing>()
            .having((e) => e.message, 'message', contains(missing))),
      );
    });

    test('2. 未指定 override,env[MP_FLUTTER_ESBUILD] 存在:返回该路径', () async {
      final f = File(p.join(tmp.path, 'esbuild'))..writeAsStringSync('');
      var called = false;
      final path = await resolveEsbuild(
        env: {'MP_FLUTTER_ESBUILD': f.path},
        run: (exe, args, {environment, includeParentEnvironment = true}) async {
          called = true;
          return _ok();
        },
      );
      expect(path, f.path);
      expect(called, isFalse);
    });

    test('env[MP_FLUTTER_ESBUILD] 指向不存在的文件:抛 ToolchainMissing', () async {
      final missing = p.join(tmp.path, 'nope-env-esbuild');
      await expectLater(
        resolveEsbuild(env: {'MP_FLUTTER_ESBUILD': missing}),
        throwsA(isA<ToolchainMissing>()
            .having((e) => e.message, 'message', contains(missing))),
      );
    });

    test('3. override/env 都没有,PATH 上有 esbuild:返回裸命令名 "esbuild"', () async {
      final path = await resolveEsbuild(
        env: {},
        cacheHome: p.join(tmp.path, 'cache'),
        run: (exe, args, {environment, includeParentEnvironment = true}) async {
          expect(exe, Platform.isWindows ? 'where' : 'which');
          expect(args, ['esbuild']);
          return _ok('/usr/local/bin/esbuild\n');
        },
      );
      expect(path, 'esbuild');
    });

    test('4. PATH 没有,但缓存目录里已有对应版本:返回缓存路径,不触发安装', () async {
      final cacheHome = p.join(tmp.path, 'cache');
      final cachedBin =
          p.join(cacheHome, 'esbuild-$kEsbuildVersion/node_modules/.bin/esbuild');
      File(cachedBin)..createSync(recursive: true)..writeAsStringSync('');

      var npmCalled = false;
      final path = await resolveEsbuild(
        env: {},
        cacheHome: cacheHome,
        run: (exe, args, {environment, includeParentEnvironment = true}) async {
          if (exe == 'npm') npmCalled = true;
          return _fail(); // which/where 找不到
        },
      );
      expect(path, cachedBin);
      expect(npmCalled, isFalse);
    });

    test('5. 都没有:自动执行 npm install --prefix <缓存> esbuild@<ver>,断言命令行,不真的联网',
        () async {
      final cacheHome = p.join(tmp.path, 'cache');
      final installDir = p.join(cacheHome, 'esbuild-$kEsbuildVersion');
      final cachedBin = p.join(installDir, 'node_modules/.bin/esbuild');

      final calls = <List<String>>[];
      final path = await resolveEsbuild(
        env: {},
        cacheHome: cacheHome,
        run: (exe, args, {environment, includeParentEnvironment = true}) async {
          calls.add([exe, ...args]);
          if (exe == 'npm') {
            // 模拟 npm install 的落盘效果,不真的联网。
            File(cachedBin)..createSync(recursive: true)..writeAsStringSync('');
            return _ok();
          }
          return _fail(); // which/where
        },
      );

      expect(path, cachedBin);
      final npmCall = calls.firstWhere((c) => c.first == 'npm');
      expect(npmCall,
          ['npm', 'install', '--prefix', installDir, 'esbuild@$kEsbuildVersion']);
    });

    test('自动安装失败(npm 退出码非 0):抛 ToolchainMissing 带出 stderr', () async {
      await expectLater(
        resolveEsbuild(
          env: {},
          cacheHome: p.join(tmp.path, 'cache'),
          run: (exe, args, {environment, includeParentEnvironment = true}) async {
            if (exe == 'npm') return _fail('network unreachable');
            return _fail();
          },
        ),
        throwsA(isA<ToolchainMissing>()
            .having((e) => e.message, 'message', contains('network unreachable'))),
      );
    });

    test('自动安装时找不到 npm 可执行文件:抛 ToolchainMissing 提示手动安装', () async {
      await expectLater(
        resolveEsbuild(
          env: {},
          cacheHome: p.join(tmp.path, 'cache'),
          run: (exe, args, {environment, includeParentEnvironment = true}) async {
            if (exe == 'npm') throw const ProcessException('npm', []);
            return _fail();
          },
        ),
        throwsA(isA<ToolchainMissing>()
            .having((e) => e.message, 'message', contains('npm'))),
      );
    });

    test('npm 声称成功但产物结构对不上(缓存路径仍不存在):抛 ToolchainMissing', () async {
      await expectLater(
        resolveEsbuild(
          env: {},
          cacheHome: p.join(tmp.path, 'cache'),
          run: (exe, args, {environment, includeParentEnvironment = true}) async {
            if (exe == 'npm') return _ok(); // 不真的创建 cachedBin
            return _fail();
          },
        ),
        throwsA(isA<ToolchainMissing>()
            .having((e) => e.message, 'message', contains('仍不存在'))),
      );
    });
  });

  group('resolveEsbuild —— probeOnly(doctor 用,不触发安装)', () {
    test('override/env/PATH/缓存都能命中时,probeOnly 不改变返回值', () async {
      final cacheHome = p.join(tmp.path, 'cache');
      final cachedBin =
          p.join(cacheHome, 'esbuild-$kEsbuildVersion/node_modules/.bin/esbuild');
      File(cachedBin)..createSync(recursive: true)..writeAsStringSync('');
      final path = await resolveEsbuild(
        env: {},
        cacheHome: cacheHome,
        probeOnly: true,
        run: (exe, args, {environment, includeParentEnvironment = true}) async => _fail(),
      );
      expect(path, cachedBin);
    });

    test('都探测不到时:抛 EsbuildNotInstalled,不调用 npm(不联网/不落盘)', () async {
      var npmCalled = false;
      await expectLater(
        resolveEsbuild(
          env: {},
          cacheHome: p.join(tmp.path, 'cache'),
          probeOnly: true,
          run: (exe, args, {environment, includeParentEnvironment = true}) async {
            if (exe == 'npm') npmCalled = true;
            return _fail();
          },
        ),
        throwsA(isA<EsbuildNotInstalled>()),
      );
      expect(npmCalled, isFalse);
    });

    test('probeOnly 下 override 指定但文件不存在:仍抛 ToolchainMissing(不是 EsbuildNotInstalled)',
        () async {
      final missing = p.join(tmp.path, 'nope-probe-only');
      await expectLater(
        resolveEsbuild(override: missing, probeOnly: true),
        throwsA(isA<ToolchainMissing>()),
      );
    });
  });

  group('warnIfEsbuildVersionMismatch(M8)—— PATH 上的 esbuild 版本提示', () {
    test('版本一致:不警告', () async {
      final warnings = <String>[];
      await warnIfEsbuildVersionMismatch(
        'esbuild',
        run: (exe, args, {environment, includeParentEnvironment = true}) async =>
            _ok('$kEsbuildVersion\n'),
        warn: warnings.add,
      );
      expect(warnings, isEmpty);
    });

    test('版本不一致:警告一次,带出两个版本号', () async {
      final warnings = <String>[];
      await warnIfEsbuildVersionMismatch(
        'esbuild',
        run: (exe, args, {environment, includeParentEnvironment = true}) async => _ok('0.19.2\n'),
        warn: warnings.add,
      );
      expect(warnings.length, 1);
      expect(warnings.single, allOf(contains('0.19.2'), contains(kEsbuildVersion)));
    });

    test('探测本身失败(非零退出码):不警告、不抛异常', () async {
      final warnings = <String>[];
      await warnIfEsbuildVersionMismatch(
        'esbuild',
        run: (exe, args, {environment, includeParentEnvironment = true}) async => _fail(),
        warn: warnings.add,
      );
      expect(warnings, isEmpty);
    });

    test('探测抛异常(可执行文件其实不存在):不警告、不向上抛异常', () async {
      final warnings = <String>[];
      await warnIfEsbuildVersionMismatch(
        'esbuild',
        run: (exe, args, {environment, includeParentEnvironment = true}) async =>
            throw const ProcessException('esbuild', []),
        warn: warnings.add,
      );
      expect(warnings, isEmpty);
    });
  });
}
