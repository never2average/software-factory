use bookings_api::{app, AppState};

#[tokio::main]
async fn main() {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.expect("bind :3000");
    println!("bookings-api listening on http://localhost:3000");
    axum::serve(listener, app(AppState::default())).await.expect("server");
}
