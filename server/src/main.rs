mod auth;
mod db;
mod error;
mod models;
mod routes;

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, FromRef, Request},
    http::header::{AUTHORIZATION, CONTENT_TYPE},
    routing::{delete, get, patch, post},
    Router,
};
use sqlx::{
    postgres::{PgListener, PgPoolOptions},
    PgPool,
};
use tokio::sync::broadcast;
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
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
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "server=debug,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");

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

    // Body limits: tight for auth/profile metadata (16 KB), moderate for sync
    // push/pull (2 MB), larger for snapshot uploads (10 MB). Applied per-group
    // via nested routers so the /ws upgrade is never accidentally body-limited.
    let auth_routes = Router::new()
        .route("/auth/register", post(routes::auth::register))
        .route("/auth/login", post(routes::auth::login))
        .route("/auth/change-password", post(routes::auth::change_password))
        .route("/auth/account", delete(routes::auth::delete_account))
        .layer(DefaultBodyLimit::max(16 * 1024)); // 16 KB

    let profile_routes = Router::new()
        .route("/profiles", get(routes::profiles::list).post(routes::profiles::create))
        .route("/profiles/{id}", patch(routes::profiles::rename).delete(routes::profiles::delete))
        .layer(DefaultBodyLimit::max(16 * 1024)); // 16 KB

    let sync_routes = Router::new()
        .route("/sync/push", post(routes::sync::push))
        .route("/sync/pull", get(routes::sync::pull))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024)); // 2 MB

    let snapshot_routes = Router::new()
        .route("/sync/snapshot", get(routes::sync::get_snapshot).put(routes::sync::put_snapshot))
        .layer(DefaultBodyLimit::max(10 * 1024 * 1024)); // 10 MB

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(auth_routes)
        .merge(profile_routes)
        .merge(sync_routes)
        .merge(snapshot_routes)
        .route("/ws", get(routes::ws::handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers([AUTHORIZATION, CONTENT_TYPE]),
        )
        .layer(
            // Redact the JWT token from WebSocket URL logs so it isn't stored
            // in plaintext by log aggregators. The `?token=...` query parameter
            // is replaced with `?token=[redacted]` in the tracing span.
            TraceLayer::new_for_http().make_span_with(|request: &Request<Body>| {
                let uri = request.uri();
                let sanitised = if uri.path() == "/ws" {
                    let query = uri.query().unwrap_or("");
                    let redacted = query
                        .split('&')
                        .map(|pair| {
                            if pair.starts_with("token=") { "token=[redacted]" } else { pair }
                        })
                        .collect::<Vec<_>>()
                        .join("&");
                    format!("{}?{}", uri.path(), redacted)
                } else {
                    uri.to_string()
                };
                tracing::debug_span!("request", uri = %sanitised, method = %request.method())
            }),
        )
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
        let mut listener = match PgListener::connect_with(&pool).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("pg_listener: connect failed: {e}");
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                continue;
            }
        };

        if let Err(e) = listener.listen("deltas").await {
            tracing::error!("pg_listener: LISTEN failed: {e}");
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            continue;
        }

        tracing::info!("pg_listener: listening on 'deltas'");
        loop {
            match listener.recv().await {
                Ok(n) => match parse_notify(n.payload()) {
                    Some(msg) => { let _ = tx.send(msg); }
                    None => tracing::warn!("pg_listener: malformed NOTIFY payload: {:?}", n.payload()),
                },
                Err(e) => {
                    tracing::error!("pg_listener: recv error: {e} — reconnecting");
                    break;
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
