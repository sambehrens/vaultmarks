use crate::models::Claims;
use axum::{
    extract::{FromRef, FromRequestParts},
    http::{header::AUTHORIZATION, request::Parts, StatusCode},
};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use sqlx::PgPool;
use uuid::Uuid;

fn jwt_secret() -> String {
    std::env::var("JWT_SECRET").expect("JWT_SECRET must be set")
}

pub fn issue_token(user_id: Uuid, token_version: i32) -> anyhow::Result<String> {
    let exp = (chrono::Utc::now() + chrono::TimeDelta::days(30)).timestamp() as usize;
    let claims = Claims { sub: user_id, exp, ver: token_version };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(jwt_secret().as_bytes()),
    )?;
    Ok(token)
}

pub fn verify_token(token: &str) -> Result<(Uuid, i32), ()> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(jwt_secret().as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .map_err(|_| ())?;
    Ok((data.claims.sub, data.claims.ver))
}

/// Axum extractor that pulls the user_id from a `Authorization: Bearer <token>`
/// header and verifies the JWT's `ver` claim matches the user's current
/// token_version in the database. Old JWTs issued before the last password
/// change fail here with 401.
pub struct AuthUser(pub Uuid);

impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
    PgPool: FromRef<S>,
{
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(StatusCode::UNAUTHORIZED)?;

        let token = header
            .strip_prefix("Bearer ")
            .ok_or(StatusCode::UNAUTHORIZED)?;

        let (user_id, token_ver) = verify_token(token).map_err(|_| StatusCode::UNAUTHORIZED)?;

        let pool = PgPool::from_ref(state);
        let current_ver: Option<i32> =
            sqlx::query_scalar("SELECT token_version FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_optional(&pool)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        match current_ver {
            Some(v) if v == token_ver => Ok(AuthUser(user_id)),
            _ => Err(StatusCode::UNAUTHORIZED),
        }
    }
}
