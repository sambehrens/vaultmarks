use axum::{
    extract::{
        ws::{Message, WebSocket},
        Query, State, WebSocketUpgrade,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{auth::verify_token, db::queries, AppState};

#[derive(Deserialize)]
pub struct WsQuery {
    /// JWT — passed as query param since browsers can't set custom headers on WebSocket upgrades.
    pub token: String,
    pub profile_id: Uuid,
}

pub async fn handler(
    State(state): State<AppState>,
    Query(params): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let Ok(user_id) = verify_token(&params.token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    ws.on_upgrade(move |socket| {
        handle_socket(
            socket,
            state.pool,
            state.notify_tx,
            user_id,
            params.profile_id,
        )
    })
}

async fn handle_socket(
    mut socket: WebSocket,
    pool: PgPool,
    notify_tx: broadcast::Sender<(Uuid, i64)>,
    user_id: Uuid,
    profile_id: Uuid,
) {
    let owned = queries::profile_belongs_to_user(&pool, profile_id, user_id)
        .await
        .unwrap_or(false);

    if !owned {
        let _ = socket.send(Message::Close(None)).await;
        return;
    }

    // Subscribe before entering the loop so we don't miss notifications that
    // arrive between the ownership check and the first recv() call.
    let mut rx = notify_tx.subscribe();

    tracing::debug!("ws: user {user_id} subscribed to profile {profile_id}");

    loop {
        tokio::select! {
            result = rx.recv() => {
                match result {
                    Ok((pid, seq)) if pid == profile_id => {
                        let msg = json!({ "sequence_id": seq }).to_string();
                        if socket.send(Message::Text(msg.into())).await.is_err() {
                            break; // client disconnected
                        }
                    }
                    Ok(_) => {} // different profile — ignore
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // Fell behind by n messages. The client will catch up
                        // on the next poll; no action needed.
                        tracing::warn!("ws: receiver lagged by {n} notifications for profile {profile_id}");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    tracing::debug!("ws: user {user_id} disconnected from profile {profile_id}");
}
