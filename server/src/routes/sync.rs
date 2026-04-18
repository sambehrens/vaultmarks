use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
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

    // Atomic insert + notify: if either fails the whole push fails, so the
    // client never sees a sequence_id for a delta that subscribers weren't
    // told about. (Postgres delivers NOTIFY payloads on COMMIT — issuing the
    // two statements in the same tx ensures subscribers only hear about
    // deltas that were actually committed.)
    let mut tx = pool.begin().await?;

    let delta = sqlx::query_as::<_, crate::models::Delta>(
        "INSERT INTO deltas (profile_id, encrypted_payload)
         VALUES ($1, $2)
         RETURNING sequence_id, profile_id, encrypted_payload, created_at",
    )
    .bind(body.profile_id)
    .bind(&payload)
    .fetch_one(&mut *tx)
    .await?;

    let notify_payload = format!("{}:{}", body.profile_id, delta.sequence_id);
    sqlx::query("SELECT pg_notify('deltas', $1)")
        .bind(&notify_payload)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

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
    /// True when more than 500 deltas are available after `since_seq`.
    /// The client should pull again with `since_seq` set to the last
    /// `sequence_id` received until `has_more` is false.
    pub has_more: bool,
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
    if params.since_seq < 0 {
        return Err(AppError::BadRequest("since_seq must be >= 0".into()));
    }

    if !queries::profile_belongs_to_user(&pool, params.profile_id, user_id).await? {
        return Err(AppError::Forbidden);
    }

    let (deltas, has_more) =
        queries::fetch_deltas_since(&pool, params.profile_id, params.since_seq).await?;

    Ok(Json(PullResponse {
        deltas: deltas
            .into_iter()
            .map(|d| DeltaEntry {
                sequence_id: d.sequence_id,
                encrypted_payload: B64.encode(&d.encrypted_payload),
            })
            .collect(),
        has_more,
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
/// Only accepted if snapshot_seq is greater than the current stored seq and
/// corresponds to an actual delta that has been committed.
pub async fn put_snapshot(
    State(pool): State<PgPool>,
    AuthUser(user_id): AuthUser,
    Json(body): Json<SnapshotPutRequest>,
) -> Result<StatusCode, AppError> {
    if !queries::profile_belongs_to_user(&pool, body.profile_id, user_id).await? {
        return Err(AppError::Forbidden);
    }

    // Validate that snapshot_seq references a real committed delta to prevent
    // a client from uploading a fabricated high seq that starves new-device pulls.
    let max_seq = queries::max_sequence_id(&pool, body.profile_id).await?;
    match max_seq {
        None => return Err(AppError::BadRequest("no deltas exist for this profile".into())),
        Some(max) if body.snapshot_seq > max => {
            return Err(AppError::BadRequest(
                "snapshot_seq exceeds the latest committed delta".into(),
            ));
        }
        _ => {}
    }

    let payload = B64
        .decode(&body.encrypted_payload)
        .map_err(|_| AppError::BadRequest("invalid base64 for encrypted_payload".into()))?;

    queries::upsert_profile_snapshot(&pool, body.profile_id, body.snapshot_seq, &payload).await?;

    Ok(StatusCode::NO_CONTENT)
}
