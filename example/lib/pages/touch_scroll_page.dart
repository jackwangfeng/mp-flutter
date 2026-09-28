import 'package:flutter/material.dart';

/// 触摸与滚动列表:一个 `ListView` + 每行的点击反馈(`GestureDetector`),
/// 用来验证 mp-flutter 的触摸桥/滚动桥零改动可用。
class TouchScrollPage extends StatefulWidget {
  const TouchScrollPage({super.key});

  @override
  State<TouchScrollPage> createState() => _TouchScrollPageState();
}

class _TouchScrollPageState extends State<TouchScrollPage> {
  final _scroll = ScrollController();
  int? _tappedIndex;
  int _scrollOffset = 0;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      final off = _scroll.offset.round();
      if ((off - _scrollOffset).abs() >= 1) {
        setState(() => _scrollOffset = off);
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Row(
            children: [
              const Text('触摸与滚动列表', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              const Spacer(),
              Text('scroll=$_scrollOffset · tap=${_tappedIndex ?? '-'}', key: const Key('touch-scroll-status')),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: ListView.builder(
            key: const Key('touch-scroll-list'),
            controller: _scroll,
            itemCount: 60,
            itemBuilder: (context, i) {
              final selected = i == _tappedIndex;
              return GestureDetector(
                onTap: () => setState(() => _tappedIndex = i),
                child: Container(
                  color: selected ? Theme.of(context).colorScheme.primaryContainer : null,
                  child: ListTile(
                    leading: CircleAvatar(child: Text('$i')),
                    title: Text('第 $i 行 —— 点我试试触摸反馈'),
                    trailing: selected ? const Icon(Icons.check_circle) : null,
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
