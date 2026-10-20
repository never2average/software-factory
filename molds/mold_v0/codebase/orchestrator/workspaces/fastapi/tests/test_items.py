from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_create_and_get():
    r = client.post("/items", json={"name": "bolt", "quantity": 3})
    assert r.status_code == 201
    assert client.get(f"/items/{r.json()['id']}").json()["name"] == "bolt"
