class Item {
  Item({required this.id, required this.name, this.quantity = 1, this.bought = false});

  final String id;
  final String name;
  final int quantity;
  final bool bought;

  Item copyWith({String? name, int? quantity, bool? bought}) =>
      Item(id: id, name: name ?? this.name, quantity: quantity ?? this.quantity, bought: bought ?? this.bought);
}
