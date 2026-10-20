//! Small room-bookings API. Bookings are kept in memory and lost on restart.
use std::sync::{Arc, Mutex};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Booking {
    pub id: u64,
    pub room: String,
    pub guest: String,
    /// ISO dates, e.g. "2026-10-11".
    pub check_in: String,
    pub check_out: String,
}

#[derive(Deserialize)]
pub struct NewBooking {
    pub room: String,
    pub guest: String,
    pub check_in: String,
    pub check_out: String,
}

#[derive(Clone, Default)]
pub struct AppState {
    bookings: Arc<Mutex<Vec<Booking>>>,
}

impl AppState {
    /// Rejects overlapping bookings for the same room.
    pub fn create(&self, b: NewBooking) -> Result<Booking, &'static str> {
        if b.check_in >= b.check_out {
            return Err("check_out must be after check_in");
        }
        let mut all = self.bookings.lock().unwrap();
        let clash = all.iter().any(|x| x.room == b.room && b.check_in < x.check_out && x.check_in < b.check_out);
        if clash {
            return Err("room already booked for those dates");
        }
        let booking = Booking { id: all.len() as u64 + 1, room: b.room, guest: b.guest, check_in: b.check_in, check_out: b.check_out };
        all.push(booking.clone());
        Ok(booking)
    }
}

async fn list(State(s): State<AppState>) -> Json<Vec<Booking>> {
    Json(s.bookings.lock().unwrap().clone())
}

async fn create(State(s): State<AppState>, Json(b): Json<NewBooking>) -> Result<(StatusCode, Json<Booking>), (StatusCode, String)> {
    s.create(b).map(|x| (StatusCode::CREATED, Json(x))).map_err(|e| (StatusCode::CONFLICT, e.to_string()))
}

async fn get_one(State(s): State<AppState>, Path(id): Path<u64>) -> Result<Json<Booking>, StatusCode> {
    s.bookings.lock().unwrap().iter().find(|b| b.id == id).cloned().map(Json).ok_or(StatusCode::NOT_FOUND)
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/bookings", get(list).post(create))
        .route("/bookings/:id", get(get_one))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_overlaps() {
        let s = AppState::default();
        let nb = |a: &str, b: &str| NewBooking { room: "101".into(), guest: "Ana".into(), check_in: a.into(), check_out: b.into() };
        assert!(s.create(nb("2026-10-10", "2026-10-12")).is_ok());
        assert!(s.create(nb("2026-10-11", "2026-10-13")).is_err());
        assert!(s.create(nb("2026-10-12", "2026-10-14")).is_ok());
    }
}
