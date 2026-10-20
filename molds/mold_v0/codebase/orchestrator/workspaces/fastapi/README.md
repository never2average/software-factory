# inventory-api

FastAPI service for warehouse inventory.

```
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
pytest
```

Endpoints: `GET /health`, `GET /items`, `GET /items/{id}`, `POST /items`.
Data is in memory for now.
