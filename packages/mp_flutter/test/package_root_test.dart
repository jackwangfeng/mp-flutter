import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';
import 'package:flutter_miniprogram/src/package_root.dart';

void main() {
  group('resolvePackageRoot', () {
    test('用注入的假 resolver 时,取 package:flutter_miniprogram/ 对应 lib/ 的上一级', () async {
      final fakeLib = p.join('/fake', 'path with 空格', 'flutter_miniprogram', 'lib');
      final root = await resolvePackageRoot(
        resolve: (uri) async {
          expect(uri, Uri.parse('package:flutter_miniprogram/'));
          return Uri.file(fakeLib);
        },
      );
      expect(p.normalize(root), p.normalize(p.join('/fake', 'path with 空格', 'flutter_miniprogram')));
    });

    test('resolver 返回 null(包配置解析不出来)时抛出可诊断的 StateError', () async {
      expect(
        () => resolvePackageRoot(resolve: (_) async => null),
        throwsA(isA<StateError>()
            .having((e) => e.message, 'message', contains('dart pub get'))),
      );
    });

    test('真实的 Isolate.resolvePackageUri(默认参数)在本包自身的测试环境下能解析成功', () async {
      // 不注入 resolve,走默认参数(真实 Isolate.resolvePackageUri)。
      // `dart test` 本身就在解析 flutter_miniprogram 包(否则测试代码自己都 import 不了),
      // 所以这里必然能拿到一个存在的目录,且目录里有本包的 pubspec.yaml。
      final root = await resolvePackageRoot();
      expect(Directory(root).existsSync(), isTrue);
      expect(File(p.join(root, 'pubspec.yaml')).existsSync(), isTrue);
    });
  });
}
