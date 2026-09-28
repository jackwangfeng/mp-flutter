import 'dart:isolate';

import 'package:path/path.dart' as p;

/// `Isolate.resolvePackageUri` 的签名,供测试注入假实现。
typedef PackageUriResolver = Future<Uri?> Function(Uri packageUri);

/// 定位 `mp_flutter` 包的根目录(即 `pubspec.yaml` 所在目录)。
///
/// Phase 6 之前,运行时目录(`runtime/`)与分片工具(原 `tools/dart-split`、
/// `tools/esbuild`)都是靠 `Platform.script` 往上跳固定层数推出仓库根——这个
/// 假设只在"本仓库内直接跑源码"时成立。一旦 `mp_flutter` 被别的工程当
/// `dev_dependencies`(path 或将来发布到 pub)引入,`dart run mp_flutter` 走的
/// 是编译好的 snapshot,`Platform.script` 指向消费者工程 `.dart_tool` 下的临时
/// 产物,再也不在本包源码树下,往上跳固定层数会跳到完全无关的目录。
///
/// `Isolate.resolvePackageUri` 走的是包配置(`.dart_tool/package_config.json`),
/// 不管以什么方式启动都能正确解析到 `package:mp_flutter/` 对应的 `lib/`
/// 目录,上溯一级就是包根——这对 path 依赖和已发布依赖都成立。
///
/// [resolve] 仅供测试注入:传入一个返回固定假 URI 的桩函数,绕开真实的包
/// 解析(单元测试环境未必真的把自己当 `package:mp_flutter` 加载)。
Future<String> resolvePackageRoot({
  PackageUriResolver resolve = Isolate.resolvePackageUri,
}) async {
  final uri = await resolve(Uri.parse('package:mp_flutter/'));
  if (uri == null) {
    throw StateError(
      '无法解析 package:mp_flutter/ 对应的目录。\n'
      '通常意味着包配置缺失或损坏——请在依赖 mp_flutter 的工程里执行一次 '
      '`dart pub get`(或 `flutter pub get`)后重试。',
    );
  }
  // uri 形如 file:///.../mp_flutter/lib/ ——上溯一级得到包根。
  final libDir = p.normalize(p.fromUri(uri));
  return p.dirname(libDir);
}
