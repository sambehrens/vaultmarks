use axum::{extract::State, Json};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{auth::AuthUser, db::queries, error::AppError};

#[derive(Serialize)]
pub struct ProfileListItem {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct ListProfilesResponse {
    pub profiles: Vec<ProfileListItem>,
}

pub async fn list(
    State(pool): State<PgPool>,
    AuthUser(user_id): AuthUser,
) -> Result<Json<ListProfilesResponse>, AppError> {
    let profiles = queries::find_profiles_by_user(&pool, user_id).await?;
    Ok(Json(ListProfilesResponse {
        profiles: profiles
            .into_iter()
            .map(|p| ProfileListItem { id: p.id.to_string(), name: p.name })
            .collect(),
    }))
}

#[derive(Deserialize)]
pub struct CreateProfileRequest {
    pub name: String,
    /// AES-256-GCM encrypted profile metadata blob — server cannot decrypt this.
    pub encrypted_metadata: String, // base64
}

#[derive(Serialize)]
pub struct CreateProfileResponse {
    pub id: String,
    pub name: String,
}

pub async fn create(
    State(pool): State<PgPool>,
    AuthUser(user_id): AuthUser,
    Json(body): Json<CreateProfileRequest>,
) -> Result<Json<CreateProfileResponse>, AppError> {
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("profile name cannot be empty".into()));
    }

    let metadata = B64
        .decode(&body.encrypted_metadata)
        .map_err(|_| AppError::BadRequest("invalid base64 for encrypted_metadata".into()))?;

    let profile = queries::create_profile(&pool, user_id, body.name.trim(), &metadata).await?;

    Ok(Json(CreateProfileResponse {
        id: profile.id.to_string(),
        name: profile.name,
    }))
}

#[derive(Deserialize)]
pub struct RenameProfileRequest {
    pub name: String,
}

pub async fn rename(
    State(pool): State<PgPool>,
    AuthUser(user_id): AuthUser,
    axum::extract::Path(profile_id): axum::extract::Path<Uuid>,
    Json(body): Json<RenameProfileRequest>,
) -> Result<axum::http::StatusCode, AppError> {
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("profile name cannot be empty".into()));
    }
    if !queries::profile_belongs_to_user(&pool, profile_id, user_id).await? {
        return Err(AppError::Forbidden);
    }
    queries::rename_profile(&pool, profile_id, body.name.trim()).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub async fn delete(
    State(pool): State<PgPool>,
    AuthUser(user_id): AuthUser,
    axum::extract::Path(profile_id): axum::extract::Path<Uuid>,
) -> Result<axum::http::StatusCode, AppError> {
    if !queries::profile_belongs_to_user(&pool, profile_id, user_id).await? {
        return Err(AppError::Forbidden);
    }
    queries::delete_profile(&pool, profile_id).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
