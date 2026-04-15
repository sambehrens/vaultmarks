CREATE EXTENSION IF NOT EXISTS pg_uuidv7;

CREATE TABLE users (
    id                       UUID PRIMARY KEY DEFAULT uuidv7(),
    email                    TEXT NOT NULL UNIQUE,
    auth_hash                TEXT NOT NULL,
    -- AES-256-GCM encrypted random symmetric key (the PSK), base64-encoded.
    -- Encrypted with the user's master-password-derived wrapping key so the
    -- server never sees the plaintext encryption key.
    protected_symmetric_key  TEXT NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
    id                    UUID PRIMARY KEY DEFAULT uuidv7(),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    encrypted_metadata    BYTEA NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE deltas (
    sequence_id         BIGSERIAL PRIMARY KEY,
    profile_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    encrypted_payload   BYTEA NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the pull query (hot path)
CREATE INDEX deltas_profile_seq ON deltas (profile_id, sequence_id);

-- One compacted snapshot per profile, replacing delta replay for new devices.
-- snapshot_seq is the sequence_id of the last delta included in this snapshot
-- so new devices only need to pull deltas with sequence_id > snapshot_seq.
CREATE TABLE profile_snapshots (
    profile_id        UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    snapshot_seq      BIGINT NOT NULL,
    encrypted_payload BYTEA NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notify channel used by LISTEN/NOTIFY for WebSocket broadcasts
-- Payload: profile_id::text || ':' || sequence_id::text
