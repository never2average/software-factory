import 'package:flutter/material.dart';

import '../data/item_repository.dart';

class ListScreen extends StatefulWidget {
  const ListScreen({super.key, required this.repository});

  final ItemRepository repository;

  @override
  State<ListScreen> createState() => _ListScreenState();
}

class _ListScreenState extends State<ListScreen> {
  final _controller = TextEditingController();

  void _add() {
    if (_controller.text.trim().isEmpty) return;
    setState(() => widget.repository.add(_controller.text));
    _controller.clear();
  }

  @override
  Widget build(BuildContext context) {
    final items = widget.repository.all();
    return Scaffold(
      appBar: AppBar(title: const Text('Shopping List')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              Expanded(child: TextField(controller: _controller, decoration: const InputDecoration(hintText: 'Add an item'))),
              IconButton(icon: const Icon(Icons.add), onPressed: _add),
            ]),
          ),
          Expanded(
            child: items.isEmpty
                ? const Center(child: Text('Nothing on the list yet.'))
                : ListView(
                    children: [
                      for (final item in items)
                        CheckboxListTile(
                          title: Text(item.name),
                          subtitle: Text('x${item.quantity}'),
                          value: item.bought,
                          onChanged: (_) => setState(() => widget.repository.toggleBought(item.id)),
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}
