# Vaultmarks

## Project structure

```
bookmark-sync/
├── extension/          # Browser extension (MV3, Chrome + Firefox)
├── server/             # Rust + Axum API server
└── tests/              # Playwright integration tests (Chrome, testcontainers Postgres)
```

## Extension development

```bash
cd extension

npm run lint

# Production build
npm run build

# Firefox build
npm run build:firefox
```

## Server development

Requires Postgres.

```bash
# Type-check without building
cargo check

# Lint (strict)
cargo clippy -- -D warnings

# Run unit tests (no DB needed)
cargo test --lib

# Format
cargo fmt
```

Migrations run on startup via `sqlx::migrate!()`. To add a migration, create `server/migrations/NNN_description.sql`.

## Integration tests

Tests spin up a Postgres testcontainer and build+spawn the server binary automatically. Requires Docker.

```bash
cd tests
npm install

# Run all tests
npm run test --prefix tests
```

Tests are serial (`workers: 1`) and each gets an isolated Chrome profile — no shared state between tests. The server runs with `TEST_MODE=true` (weak Argon2, no rate limiting).

## Key architectural notes

- **E2EE**: master password → Argon2id → HKDF → auth key (sent to server) + wrapping key (never sent). Wrapping key encrypts the PSK (random AES-256 key stored on server). All bookmark data is encrypted client-side before upload.
- **CRDT**: Loro (WASM) provides conflict-free bookmark sync. The extension stores a snapshot + pending delta queue in IndexedDB.
- **Echo filter**: `withEchoFilter(fn)` in `bookmarks/echo-filter.ts` prevents remotely-applied bookmark changes from re-triggering the sync listener.
- **Session locking**: locking clears the encryption key from memory but keeps the JWT. `SessionTimeout = "never"` persists the raw key bytes to `chrome.storage.local`.
- **Token versioning**: JWTs embed a `ver` claim. Every authenticated request checks `ver` against `users.token_version` in the DB. Password change bumps the version and returns a new JWT, invalidating all other sessions.
- **Rate limiting**: `/auth/*` endpoints are limited to 10 req/60 s per IP (disabled in `TEST_MODE`). SSE alarm reconnect delay is clamped to 30 s by Chrome MV3 in production (comment says 5 s — intended, but not what actually fires).

