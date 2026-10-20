import 'package:flutter_test/flutter_test.dart';
import 'package:shopping_list/data/item_repository.dart';

void main() {
  test('adds and toggles items', () {
    final repo = InMemoryItemRepository();
    final item = repo.add('Milk', quantity: 2);
    expect(repo.all(), hasLength(1));
    expect(repo.toggleBought(item.id).bought, isTrue);
  });

  test('rejects empty names', () {
    expect(() => InMemoryItemRepository().add('  '), throwsArgumentError);
  });
}
