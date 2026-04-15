use sqlx::PgPool;
use uuid::Uuid;
use crate::models::{Delta, Profile, User};

// ── Users ────────────────────────────────────────────────────────────────────

pub async fn find_user_by_email(pool: &PgPool, email: &str) -> sqlx::Result<Option<User>> {
    sqlx::query_as::<_, User>(
        "SELECT id, email, auth_hash, protected_symmetric_key, created_at FROM users WHERE email = $1",
    )
    .bind(email)
    .fetch_optional(pool)
    .await
}

pub async fn create_user(
    pool: &PgPool,
    email: &str,
    auth_hash: &str,
    protected_symmetric_key: &str,
) -> sqlx::Result<User> {
    sqlx::query_as::<_, User>(
        "INSERT INTO users (email, auth_hash, protected_symmetric_key) VALUES ($1, $2, $3)
         RETURNING id, email, auth_hash, protected_symmetric_key, created_at",
    )
    .bind(email)
    .bind(auth_hash)
    .bind(protected_symmetric_key)
    .fetch_one(pool)
    .await
}

pub async fn change_user_password(
    pool: &PgPool,
    user_id: Uuid,
    new_auth_hash: &str,
    new_protected_symmetric_key: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE users SET auth_hash = $1, protected_symmetric_key = $2 WHERE id = $3",
    )
    .bind(new_auth_hash)
    .bind(new_protected_symmetric_key)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Profiles ─────────────────────────────────────────────────────────────────

pub async fn create_profile(
    pool: &PgPool,
    user_id: Uuid,
    name: &str,
    encrypted_metadata: &[u8],
) -> sqlx::Result<Profile> {
    sqlx::query_as::<_, Profile>(
        "INSERT INTO profiles (user_id, name, encrypted_metadata)
         VALUES ($1, $2, $3)
         RETURNING id, user_id, name, encrypted_metadata, created_at",
    )
    .bind(user_id)
    .bind(name)
    .bind(encrypted_metadata)
    .fetch_one(pool)
    .await
}

pub async fn find_profiles_by_user(pool: &PgPool, user_id: Uuid) -> sqlx::Result<Vec<Profile>> {
    sqlx::query_as::<_, Profile>(
        "SELECT id, user_id, name, encrypted_metadata, created_at
         FROM profiles WHERE user_id = $1
         ORDER BY created_at ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

/// Returns true if the profile exists and belongs to the given user.
pub async fn profile_belongs_to_user(
    pool: &PgPool,
    profile_id: Uuid,
    user_id: Uuid,
) -> sqlx::Result<bool> {
    let row = sqlx::query(
        "SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2",
    )
    .bind(profile_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

// ── Deltas ───────────────────────────────────────────────────────────────────

pub async fn insert_delta(
    pool: &PgPool,
    profile_id: Uuid,
    encrypted_payload: &[u8],
) -> sqlx::Result<Delta> {
    sqlx::query_as::<_, Delta>(
        "INSERT INTO deltas (profile_id, encrypted_payload)
         VALUES ($1, $2)
         RETURNING sequence_id, profile_id, encrypted_payload, created_at",
    )
    .bind(profile_id)
    .bind(encrypted_payload)
    .fetch_one(pool)
    .await
}

pub async fn fetch_deltas_since(
    pool: &PgPool,
    profile_id: Uuid,
    since_seq: i64,
) -> sqlx::Result<Vec<Delta>> {
    sqlx::query_as::<_, Delta>(
        "SELECT sequence_id, profile_id, encrypted_payload, created_at
         FROM deltas
         WHERE profile_id = $1 AND sequence_id > $2
         ORDER BY sequence_id ASC",
    )
    .bind(profile_id)
    .bind(since_seq)
    .fetch_all(pool)
    .await
}

// ── Profile snapshots ─────────────────────────────────────────────────────────

/// Returns the latest compacted snapshot for a profile, or None if none exists.
pub async fn get_profile_snapshot(
    pool: &PgPool,
    profile_id: Uuid,
) -> sqlx::Result<Option<(i64, Vec<u8>)>> {
    let row = sqlx::query_as::<_, (i64, Vec<u8>)>(
        "SELECT snapshot_seq, encrypted_payload
         FROM profile_snapshots WHERE profile_id = $1",
    )
    .bind(profile_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Upsert the compacted snapshot for a profile.
/// Only advances the snapshot if the new seq is strictly greater than the current one.
pub async fn upsert_profile_snapshot(
    pool: &PgPool,
    profile_id: Uuid,
    snapshot_seq: i64,
    encrypted_payload: &[u8],
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO profile_snapshots (profile_id, snapshot_seq, encrypted_payload, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (profile_id) DO UPDATE
           SET snapshot_seq      = EXCLUDED.snapshot_seq,
               encrypted_payload = EXCLUDED.encrypted_payload,
               updated_at        = now()
         WHERE profile_snapshots.snapshot_seq < EXCLUDED.snapshot_seq",
    )
    .bind(profile_id)
    .bind(snapshot_seq)
    .bind(encrypted_payload)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn rename_profile(pool: &PgPool, profile_id: Uuid, name: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE profiles SET name = $1 WHERE id = $2")
        .bind(name)
        .bind(profile_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_profile(pool: &PgPool, profile_id: Uuid) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM profiles WHERE id = $1")
        .bind(profile_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_user(pool: &PgPool, user_id: Uuid) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}
