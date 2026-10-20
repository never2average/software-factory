from itertools import count

_ids = count(1)
_items: dict[int, dict] = {}


def list_items() -> list[dict]:
    return list(_items.values())


def get_item(item_id: int) -> dict | None:
    return _items.get(item_id)


def create_item(payload: dict) -> dict:
    item = {"id": next(_ids), "name": payload.get("name"), "quantity": payload.get("quantity", 0)}
    _items[item["id"]] = item
    return item
