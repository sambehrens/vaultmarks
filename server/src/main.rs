mod auth;
mod db;
mod error;
mod models;
mod routes;

use axum::{extract::FromRef, Router, routing::{delete, get, post}};
use sqlx::{postgres::{PgListener, PgPoolOptions}, PgPool};
use tokio::sync::broadcast;
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use uuid::Uuid;

/// Notification that a new delta was pushed for a profile.
/// Broadcast to all WebSocket handlers watching that profile.
pub type NotifyTx = broadcast::Sender<(Uuid, i64)>;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    /// Shared sender — WebSocket handlers call `.subscribe()` to get a receiver.
    pub notify_tx: NotifyTx,
}

/// Allows existing route handlers that extract `State(pool): State<PgPool>`
/// to continue working without modification.
impl FromRef<AppState> for PgPool {
    fn from_ref(state: &AppState) -> Self {
        state.pool.clone()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "aegis_sync_server=debug,tower_http=debug".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set");

    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&database_url)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    // Capacity: 256 buffered notifications. Lagged receivers simply miss
    // stale notifications and rely on the next poll to catch up — fine for sync.
    let (notify_tx, _) = broadcast::channel::<(Uuid, i64)>(256);

    // Spawn the single shared PgListener task.
    tokio::spawn(run_pg_listener(pool.clone(), notify_tx.clone()));

    let state = AppState { pool, notify_tx };

    let app = Router::new()
        .route("/auth/register", post(routes::auth::register))
        .route("/auth/login", post(routes::auth::login))
        .route("/auth/change-password", post(routes::auth::change_password))
        .route("/auth/account", delete(routes::auth::delete_account))
        .route("/profiles", get(routes::profiles::list).post(routes::profiles::create))
        .route("/profiles/{id}", axum::routing::patch(routes::profiles::rename).delete(routes::profiles::delete))
        .route("/sync/push", post(routes::sync::push))
        .route("/sync/pull", get(routes::sync::pull))
        .route("/sync/snapshot", get(routes::sync::get_snapshot).put(routes::sync::put_snapshot))
        .route("/ws", get(routes::ws::handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers([AUTHORIZATION, CONTENT_TYPE]),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    tracing::info!("listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;

    Ok(())
}

/// Holds a single `PgListener` for the entire process lifetime.
/// Parses incoming notifications and broadcasts `(profile_id, sequence_id)`
/// to all subscribed WebSocket handlers. Reconnects automatically on error.
async fn run_pg_listener(pool: PgPool, tx: NotifyTx) {
    loop {
        match PgListener::connect_with(&pool).await {
            Err(e) => {
                tracing::error!("pg_listener: connect failed: {e}");
            }
            Ok(mut listener) => {
                if let Err(e) = listener.listen("deltas").await {
                    tracing::error!("pg_listener: LISTEN failed: {e}");
                } else {
                    tracing::info!("pg_listener: listening on 'deltas'");
                    loop {
                        match listener.recv().await {
                            Ok(n) => {
                                if let Some(msg) = parse_notify(n.payload()) {
                                    // Ignore send errors — they just mean no
                                    // WebSocket clients are currently subscribed.
                                    let _ = tx.send(msg);
                                }
                            }
                            Err(e) => {
                                tracing::error!("pg_listener: recv error: {e} — reconnecting");
                                break;
                            }
                        }
                    }
                }
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    }
}

/// Parses `"{profile_id}:{sequence_id}"` notification payloads.
fn parse_notify(payload: &str) -> Option<(Uuid, i64)> {
    let (pid, seq) = payload.split_once(':')?;
    Some((pid.parse().ok()?, seq.parse().ok()?))
}
