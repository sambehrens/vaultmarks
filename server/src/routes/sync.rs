use axum::{extract::{Query, State}, http::StatusCode, Json};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{auth::AuthUser, db::queries, error::AppError};

// ── Push ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PushRequest {
    pub profile_id: Uuid,
    /// Base64-encoded AES-256-GCM encrypted Loro binary update.
    pub encrypted_delta: String,
}

#[derive(Serialize)]
pub struct PushResponse {
    pub sequence_id: i64,
}

pub async fn push(
    State(pool): State<PgPool>,
    AuthUser(user_id): AuthUser,
    Json(body): Json<PushRequest>,
) -> Result<Json<PushResponse>, AppError> {
    if !queries::profile_belongs_to_user(&pool, body.profile_id, user_id).await? {
        return Err(AppError::Forbidden);
    }

    let payload = B64
        .decode(&body.encrypted_delta)
        .map_err(|_| AppError::BadRequest("invalid base64 for encrypted_delta".into()))?;

    let delta = queries::insert_delta(&pool, body.profile_id, &payload).await?;

    // Notify any WebSocket listeners watching this profile.
    // Payload format: "{profile_id}:{sequence_id}"
    let notify_payload = format!("{}:{}", body.profile_id, delta.sequence_id);
    sqlx::query("SELECT pg_notify('deltas', $1)")
        .bind(&notify_payload)
        .execute(&pool)
        .await?;

    Ok(Json(PushResponse {
        sequence_id: delta.sequence_id,
    }))
}

// ── Pull ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PullQuery {
    pub profile_id: Uuid,
    pub since_seq: i64,
}

#[derive(Serialize)]
pub struct PullResponse {
    pub deltas: Vec<DeltaEntry>,
}

#[derive(Serialize)]
pub struct DeltaEntry {
    pub sequence_id: i64,
    /// Base64-encoded encrypted Loro binary update.
    pub encrypted_payload: String,
}

pub async fn pull(
    State(pool): State<PgPool>,
    AuthUser(user_id): AuthUser,
    Query(params): Query<PullQuery>,
) -> Result<Json<PullResponse>, AppError> {
    if !queries::profile_belongs_to_user(&pool, params.profile_id, user_id).await? {
        return Err(AppError::Forbidden);
    }

    let deltas = queries::fetch_deltas_since(&pool, params.profile_id, params.since_seq).await?;

    Ok(Json(PullResponse {
        deltas: deltas
            .into_iter()
            .map(|d| DeltaEntry {
                sequence_id: d.sequence_id,
                encrypted_payload: B64.encode(&d.encrypted_payload),
            })
            .collect(),
    }))
}

// ── Snapshot compaction ───────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SnapshotQuery {
    pub profile_id: Uuid,
}

#[derive(Serialize)]
pub struct SnapshotGetResponse {
    pub snapshot_seq: i64,
    /// Base64-encoded encrypted Loro snapshot.
    pub encrypted_payload: String,
}

#[derive(Deserialize)]
pub struct SnapshotPutRequest {
    pub profile_id: Uuid,
    /// The sequence_id of the last delta included in this snapshot.
    pub snapshot_seq: i64,
    /// Base64-encoded encrypted Loro snapshot.
    pub encrypted_payload: String,
}

/// GET /sync/snapshot — returns the latest compacted snapshot for a profile,
/// or 404 if no snapshot has been uploaded yet.
pub async fn get_snapshot(
    State(pool): State<PgPool>,
    AuthUser(user_id): AuthUser,
    Query(params): Query<SnapshotQuery>,
) -> Result<Json<SnapshotGetResponse>, AppError> {
    if !queries::profile_belongs_to_user(&pool, params.profile_id, user_id).await? {
        return Err(AppError::Forbidden);
    }

    match queries::get_profile_snapshot(&pool, params.profile_id).await? {
        Some((snapshot_seq, payload)) => Ok(Json(SnapshotGetResponse {
            snapshot_seq,
            encrypted_payload: B64.encode(&payload),
        })),
        None => Err(AppError::NotFound),
    }
}

/// PUT /sync/snapshot — upsert a compacted snapshot for a profile.
/// Only accepted if snapshot_seq is greater than the current stored seq,
/// ensuring the server snapshot only ever moves forward.
pub async fn put_snapshot(
    State(pool): State<PgPool>,
    AuthUser(user_id): AuthUser,
    Json(body): Json<SnapshotPutRequest>,
) -> Result<StatusCode, AppError> {
    if !queries::profile_belongs_to_user(&pool, body.profile_id, user_id).await? {
        return Err(AppError::Forbidden);
    }

    let payload = B64
        .decode(&body.encrypted_payload)
        .map_err(|_| AppError::BadRequest("invalid base64 for encrypted_payload".into()))?;

    queries::upsert_profile_snapshot(&pool, body.profile_id, body.snapshot_seq, &payload).await?;

    Ok(StatusCode::NO_CONTENT)
}
