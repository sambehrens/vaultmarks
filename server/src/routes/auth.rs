use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{extract::State, http::StatusCode, Json};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::{auth::{issue_token, AuthUser}, db::queries, error::AppError};

// ── Register ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    /// HKDF-derived auth key from the client (already one step removed from master password).
    /// We hash it again with Argon2id before storage for defence-in-depth.
    pub auth_hash: String,
    /// Display name for the initial profile (e.g. "Default")
    pub profile_name: String,
    /// AES-256-GCM encrypted profile metadata blob — server cannot decrypt this.
    pub encrypted_profile_metadata: String, // base64
    /// AES-256-GCM encrypted random symmetric key (PSK), base64-encoded.
    /// Encrypted with the user's wrapping key so the server never sees the plaintext.
    pub protected_symmetric_key: String,
}

#[derive(Serialize)]
pub struct RegisterResponse {
    pub token: String,
    pub profile_id: String,
}

pub async fn register(
    State(pool): State<PgPool>,
    Json(body): Json<RegisterRequest>,
) -> Result<Json<RegisterResponse>, AppError> {
    if queries::find_user_by_email(&pool, &body.email).await?.is_some() {
        return Err(AppError::BadRequest("email already registered".into()));
    }

    let stored_hash = hash_auth_key(&body.auth_hash)?;
    let user = queries::create_user(&pool, &body.email, &stored_hash, &body.protected_symmetric_key).await?;

    let metadata_bytes = B64
        .decode(&body.encrypted_profile_metadata)
        .map_err(|_| AppError::BadRequest("invalid base64 for encrypted_profile_metadata".into()))?;

    let profile =
        queries::create_profile(&pool, user.id, &body.profile_name, &metadata_bytes).await?;

    let token = issue_token(user.id).map_err(anyhow::Error::from)?;

    Ok(Json(RegisterResponse {
        token,
        profile_id: profile.id.to_string(),
    }))
}

// ── Login ─────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub auth_hash: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub profiles: Vec<ProfileEntry>,
    /// Base64-encoded PSK — the client decrypts this with its wrapping key to
    /// recover the symmetric encryption key.
    pub protected_symmetric_key: String,
}

#[derive(Serialize)]
pub struct ProfileEntry {
    pub id: String,
    pub name: String,
    /// Base64-encoded encrypted metadata blob.
    pub encrypted_metadata: String,
}

pub async fn login(
    State(pool): State<PgPool>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    let user = queries::find_user_by_email(&pool, &body.email)
        .await?
        .ok_or(AppError::Unauthorized)?;

    verify_auth_key(&body.auth_hash, &user.auth_hash)?;

    let profiles = queries::find_profiles_by_user(&pool, user.id).await?;

    let token = issue_token(user.id).map_err(anyhow::Error::from)?;

    Ok(Json(LoginResponse {
        token,
        protected_symmetric_key: user.protected_symmetric_key,
        profiles: profiles
            .into_iter()
            .map(|p| ProfileEntry {
                id: p.id.to_string(),
                name: p.name,
                encrypted_metadata: B64.encode(&p.encrypted_metadata),
            })
            .collect(),
    }))
}

// ── Change password ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub old_auth_hash: String,
    pub new_auth_hash: String,
    /// New PSK: the same symmetric key re-encrypted with the new wrapping key.
    pub new_protected_symmetric_key: String,
}

pub async fn change_password(
    State(pool): State<PgPool>,
    AuthUser(user_id): AuthUser,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<StatusCode, AppError> {
    // Re-authenticate: fetch the current auth_hash and verify old password.
    let stored_hash = sqlx::query_scalar::<_, String>(
        "SELECT auth_hash FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&pool)
    .await?
    .ok_or(AppError::Unauthorized)?;

    verify_auth_key(&body.old_auth_hash, &stored_hash)?;

    let new_stored_hash = hash_auth_key(&body.new_auth_hash)?;
    queries::change_user_password(&pool, user_id, &new_stored_hash, &body.new_protected_symmetric_key).await?;

    Ok(StatusCode::NO_CONTENT)
}

// ── Delete account ────────────────────────────────────────────────────────────

pub async fn delete_account(
    State(pool): State<PgPool>,
    AuthUser(user_id): AuthUser,
) -> Result<StatusCode, AppError> {
    queries::delete_user(&pool, user_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn hash_auth_key(auth_key: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    // In TEST_MODE use minimal params so integration tests don't time out
    // waiting for server-side Argon2id (which can be very slow in Docker on Mac).
    let argon2 = if std::env::var("TEST_MODE").is_ok() {
        Argon2::new(
            argon2::Algorithm::Argon2id,
            argon2::Version::V0x13,
            argon2::Params::new(1024, 1, 1, None)
                .expect("valid test params"),
        )
    } else {
        Argon2::default()
    };
    argon2
        .hash_password(auth_key.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(anyhow::anyhow!("argon2 hash failed: {e}")))
}

fn verify_auth_key(auth_key: &str, stored_hash: &str) -> Result<(), AppError> {
    let parsed = PasswordHash::new(stored_hash)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("invalid stored hash: {e}")))?;
    Argon2::default()
        .verify_password(auth_key.as_bytes(), &parsed)
        .map_err(|_| AppError::Unauthorized)
}
