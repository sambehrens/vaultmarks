use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
};
use futures_util::stream;
use serde::Deserialize;
use std::convert::Infallible;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{auth::verify_token, db::queries, AppState};

#[derive(Deserialize)]
pub struct EventsQuery {
    /// JWT — passed as query param since browsers can't set custom headers on EventSource.
    pub token: String,
    pub profile_id: Uuid,
}

pub async fn handler(
    State(state): State<AppState>,
    Query(params): Query<EventsQuery>,
) -> Response {
    let Ok(user_id) = verify_token(&params.token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let owned = queries::profile_belongs_to_user(&state.pool, params.profile_id, user_id)
        .await
        .unwrap_or(false);

    if !owned {
        return StatusCode::FORBIDDEN.into_response();
    }

    let profile_id = params.profile_id;

    // Bridge the broadcast channel (all profiles) to a per-profile mpsc channel.
    let (tx, rx) = tokio::sync::mpsc::channel::<i64>(16);
    let mut broadcast_rx = state.notify_tx.subscribe();

    tokio::spawn(async move {
        loop {
            match broadcast_rx.recv().await {
                Ok((pid, seq)) if pid == profile_id => {
                    if tx.send(seq).await.is_err() {
                        break; // SSE stream dropped — client disconnected
                    }
                }
                Ok(_) => {} // different profile — ignore
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("sse: receiver lagged by {n} notifications for profile {profile_id}");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let sse_stream = stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|seq| {
            let data = serde_json::json!({ "sequence_id": seq }).to_string();
            (Ok::<_, Infallible>(Event::default().data(data)), rx)
        })
    });

    Sse::new(sse_stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}
