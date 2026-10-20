import 'package:flutter/material.dart';

import 'data/item_repository.dart';
import 'screens/list_screen.dart';

void main() {
  runApp(ShoppingListApp(repository: InMemoryItemRepository()));
}

class ShoppingListApp extends StatelessWidget {
  const ShoppingListApp({super.key, required this.repository});

  final ItemRepository repository;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Shopping List',
      theme: ThemeData(colorSchemeSeed: Colors.teal, useMaterial3: true),
      home: ListScreen(repository: repository),
    );
  }
}
