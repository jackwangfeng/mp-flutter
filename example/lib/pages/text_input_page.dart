import 'package:flutter/material.dart';

/// 文本输入:两个 `TextField`(切换焦点)+ 一个多行输入,验证 mp-flutter 的
/// 输入桥(原生输入框叠加、IME 组合输入、焦点切换、提交/清空)零改动可用。
class TextInputPage extends StatefulWidget {
  const TextInputPage({super.key});

  @override
  State<TextInputPage> createState() => _TextInputPageState();
}

class _TextInputPageState extends State<TextInputPage> {
  final _name = TextEditingController();
  final _search = TextEditingController();
  final _note = TextEditingController();
  String _submitted = '';

  @override
  void dispose() {
    _name.dispose();
    _search.dispose();
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text('文本输入', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
        const SizedBox(height: 16),
        TextField(
          key: const Key('input-name'),
          controller: _name,
          autofocus: true,
          decoration: const InputDecoration(labelText: '姓名', border: OutlineInputBorder()),
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: 12),
        TextField(
          key: const Key('input-search'),
          controller: _search,
          decoration: InputDecoration(
            labelText: '搜索(提交后清空)',
            border: const OutlineInputBorder(),
            suffixIcon: IconButton(icon: const Icon(Icons.clear), onPressed: _search.clear),
          ),
          textInputAction: TextInputAction.search,
          onSubmitted: (v) {
            setState(() => _submitted = v);
            _search.clear();
          },
        ),
        const SizedBox(height: 12),
        TextField(
          key: const Key('input-note'),
          controller: _note,
          maxLines: 4,
          decoration: const InputDecoration(labelText: '备注(多行)', border: OutlineInputBorder()),
        ),
        const SizedBox(height: 16),
        Text('上次提交的搜索词:${_submitted.isEmpty ? '(无)' : _submitted}', key: const Key('input-submitted')),
      ],
    );
  }
}
