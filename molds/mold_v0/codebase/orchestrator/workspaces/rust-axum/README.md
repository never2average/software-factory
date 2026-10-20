# bookings-api

Small room-bookings API (Rust, axum, Tokio).

```
cargo run      # http://localhost:3000
cargo test
```

Endpoints: `GET /health`, `GET /bookings`, `POST /bookings`, `GET /bookings/:id`. Overlapping bookings for the same
room are rejected. Bookings live in memory (`AppState`) for now and reset on restart.
