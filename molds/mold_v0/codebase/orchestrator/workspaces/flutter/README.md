# shopping_list

Small Flutter app for a household shopping list (Flutter + Dart, Material 3).

```
flutter pub get
flutter run        # pick a simulator or device
flutter test
```

`ListScreen` adds items and checks them off. Items live in `InMemoryItemRepository` (lib/data), so they reset when
the app restarts.
