// 覆盖 dart2js 产物里跨分片最容易出错的构造:类继承与 mixin、闭包捕获、
// 顶层 late final、常量规范化、类型检查、异常、async、Map/Set、字符串插值。
import 'dart:async';

mixin Greeter { String greet() => 'hi ${name()}'; String name(); }
abstract class Animal { String sound(); }
class Dog extends Animal with Greeter {
  @override String sound() => 'woof';
  @override String name() => 'dog';
}
class Box<T> { final T v; const Box(this.v); }

late final int lazyValue = compute();
int compute() => [1, 2, 3].fold(0, (a, b) => a + b);

Future<void> main() async {
  final out = <String>[];
  final d = Dog();
  out.add('${d.sound()} ${d.greet()}');
  final counter = () { var n = 0; return () => ++n; }();
  counter(); out.add('counter=${counter()}');
  out.add('lazy=$lazyValue');
  out.add('const=${identical(const Box(1), const Box(1))}');
  Object o = Box<String>('x');
  out.add('is=${o is Box<String>} ${o is Box<int>}');
  try { throw StateError('boom'); } catch (e) { out.add('caught=${e.runtimeType}'); }
  await Future<void>.delayed(Duration.zero);
  out.add('async=ok');
  final m = {'b': 2, 'a': 1}; final s = {3, 1, 2};
  out.add('map=${m.keys.join(",")} set=${s.join(",")}');
  out.add('中文=${'世界😀'.length}');
  print(out.join('|'));
}
