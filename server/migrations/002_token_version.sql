-- Token versioning: bumped on password change to invalidate JWTs issued before
-- the change. Every authenticated request re-reads this value and rejects any
-- JWT whose embedded `ver` claim doesn't match.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
