from fastapi import FastAPI, HTTPException

from app import store

app = FastAPI(title="inventory-api")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/items")
def list_items():
    return store.list_items()


@app.get("/items/{item_id}")
def get_item(item_id: int):
    item = store.get_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="not found")
    return item


@app.post("/items", status_code=201)
def create_item(payload: dict):
    return store.create_item(payload)
