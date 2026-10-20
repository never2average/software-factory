import '../models/item.dart';

abstract class ItemRepository {
  List<Item> all();
  Item add(String name, {int quantity = 1});
  Item toggleBought(String id);
  void remove(String id);
}

/// Keeps items in memory; everything is lost when the app restarts.
class InMemoryItemRepository implements ItemRepository {
  final _items = <String, Item>{};
  var _nextId = 1;

  @override
  List<Item> all() => _items.values.toList();

  @override
  Item add(String name, {int quantity = 1}) {
    final trimmed = name.trim();
    if (trimmed.isEmpty) throw ArgumentError('Item name is required');
    final item = Item(id: '${_nextId++}', name: trimmed, quantity: quantity);
    _items[item.id] = item;
    return item;
  }

  @override
  Item toggleBought(String id) {
    final item = _items[id];
    if (item == null) throw StateError('No item $id');
    return _items[id] = item.copyWith(bought: !item.bought);
  }

  @override
  void remove(String id) => _items.remove(id);
}
