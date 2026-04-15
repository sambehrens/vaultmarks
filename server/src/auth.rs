use axum::{extract::FromRequestParts, http::{header::AUTHORIZATION, request::Parts, StatusCode}};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use uuid::Uuid;
use crate::models::Claims;

fn jwt_secret() -> String {
    std::env::var("JWT_SECRET").expect("JWT_SECRET must be set")
}

pub fn issue_token(user_id: Uuid) -> anyhow::Result<String> {
    let exp = (chrono::Utc::now() + chrono::TimeDelta::days(365)).timestamp() as usize;
    let claims = Claims { sub: user_id, exp };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(jwt_secret().as_bytes()),
    )?;
    Ok(token)
}

pub fn verify_token(token: &str) -> Result<Uuid, ()> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(jwt_secret().as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| ())?;
    Ok(data.claims.sub)
}

/// Axum extractor that pulls the user_id from a `Authorization: Bearer <token>` header.
pub struct AuthUser(pub Uuid);

impl<S: Send + Sync> FromRequestParts<S> for AuthUser {
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(StatusCode::UNAUTHORIZED)?;

        let token = header
            .strip_prefix("Bearer ")
            .ok_or(StatusCode::UNAUTHORIZED)?;

        let user_id = verify_token(token).map_err(|_| StatusCode::UNAUTHORIZED)?;
        Ok(AuthUser(user_id))
    }
}
