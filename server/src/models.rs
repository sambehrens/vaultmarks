use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    /// Argon2id hash of the auth_key (not the master password)
    pub auth_hash: String,
    /// AES-256-GCM encrypted random symmetric key, base64-encoded.
    /// Encrypted with the user's wrapping key (derived from master password).
    pub protected_symmetric_key: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Profile {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    /// Encrypted profile metadata blob (E2EE — server cannot read)
    pub encrypted_metadata: Vec<u8>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Delta {
    pub sequence_id: i64,
    pub profile_id: Uuid,
    /// Encrypted Loro binary update (E2EE — server cannot read)
    pub encrypted_payload: Vec<u8>,
    pub created_at: DateTime<Utc>,
}

/// Claims embedded in the JWT
#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid, // user_id
    pub exp: usize,
    /// Token version — bumped on password change so old JWTs stop validating.
    #[serde(default)]
    pub ver: i32,
}

#[cfg(test)]
mod tests {
    use super::Claims;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn legacy_claims_default_version_to_zero() {
        let claims: Claims = serde_json::from_value(json!({
            "sub": Uuid::nil(),
            "exp": 123usize,
        }))
        .expect("legacy claims should deserialize");

        assert_eq!(claims.ver, 0);
    }
}
