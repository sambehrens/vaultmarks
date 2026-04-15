# Aegis Sync

Cross-browser bookmark synchronization with end-to-end encryption and conflict-free merging via CRDTs.

The server is a stateless ordered sequencer — it stores only encrypted binary blobs and can never read your bookmarks. Conflict resolution runs entirely on the client using [Loro](https://loro.dev), a CRDT library compiled to WASM.

## Features

- **End-to-end encrypted** — bookmarks are encrypted with AES-256-GCM before leaving the device; the server never sees plaintext
- **Conflict-free sync** — concurrent edits across devices are merged automatically using Loro CRDTs
- **Multiple profiles** — maintain separate bookmark sets (e.g. Work, Personal) under one account; create, rename, and delete profiles
- **Password changes** — master password can be changed without re-encrypting any data (Protected Symmetric Key model)
- **Session management** — session locks when the browser restarts by default; optionally set timeout to "Never" to stay unlocked across restarts
- **Cross-browser** — works in Chrome and Chromium-based browsers including Orion; falls back to polling where bookmark events are unavailable
- **Real-time** — WebSocket push notifications trigger an immediate pull when another device syncs

## Architecture

```
extension/          Browser extension (TypeScript + SolidJS + Loro WASM)
server/             Sync server (Rust + Axum + PostgreSQL)
```

**Security model**

```
master password + email
        │
        ▼  Argon2id (64 MB, 3 iterations)
   Master Key
        │
        ▼  HKDF-SHA256
   ┌────┴──────────────┐
   │                   │
auth key          wrapping key
(sent to server;  (encrypts the Protected Symmetric Key)
 hashed server-
 side with
 Argon2id)

Protected Symmetric Key (PSK) = AES-256-GCM(wrapping key, symmetric key)
                                              │
                                              ▼
                                      symmetric key  ← actual AES-256-GCM data key
                                      (random, never changes)
```

The PSK is stored on the server as an opaque encrypted blob. To change the master password, the client decrypts the PSK with the old wrapping key and re-encrypts it with the new one — zero data re-encryption required. The server stores `argon2id(auth_key)` — it never sees the master password, wrapping key, or symmetric key.

**Session storage**

| Storage | Contents | Cleared on |
|---|---|---|
| `chrome.storage.local` | JWT, email, profiles, active profile ID, session timeout, Protected Symmetric Key | Logout |
| `chrome.storage.session` | Symmetric encryption key bytes | Browser close |
| `chrome.storage.local` (optional) | Symmetric encryption key bytes | Logout or timeout changed to "On browser restart" |

When the service worker restarts mid-session, the JWT and PSK are restored from `chrome.storage.local` and the symmetric key from `chrome.storage.session`. If the symmetric key is missing (browser was restarted and timeout is "On browser restart"), the popup shows a lock screen — the user re-enters only their master password. The popup derives the wrapping key, decrypts the PSK from local storage, and recovers the symmetric key without any server round-trip.

**Sync flow**

```
local change → Loro op → AES-256-GCM → IndexedDB queue → POST /sync/push → Postgres
                                                                                │
                                                          WebSocket NOTIFY ◄────┘
                                                                │
                                                          GET /sync/pull
                                                                │
                                                       decrypt → Loro import → chrome.bookmarks
```

Every 50 deltas, the active client uploads a compacted snapshot (`PUT /sync/snapshot`). New devices download the snapshot first, then only replay deltas since the snapshot — keeping initial sync fast regardless of total history length.

## Tech stack

| Layer | Technology |
|---|---|
| Extension UI | SolidJS |
| CRDT | Loro WASM |
| Encryption | Web Crypto API (AES-256-GCM), @noble/hashes (Argon2id + HKDF) |
| Local storage | IndexedDB |
| Server | Rust, Axum, Tokio |
| Database | PostgreSQL |
| Real-time | WebSocket + `pg_notify` |
| Deployment | fly.io |

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Rust | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js | ≥ 22 | [nodejs.org](https://nodejs.org) or `brew install node` |
| PostgreSQL | ≥ 18 | `brew install postgresql@18` |
| sqlx-cli | any | `cargo install sqlx-cli --no-default-features --features postgres` |

## Development setup

### 1. Clone the repo

```bash
git clone <repo-url>
cd bookmark-sync
```

### 2. Start PostgreSQL

```bash
brew services start postgresql@16
```

### 3. Set up the server

```bash
cd server

# Copy the env template and fill in values
cp .env.example .env
```

Edit `server/.env`:

```env
DATABASE_URL=postgres://localhost/aegis_sync
JWT_SECRET=<any-long-random-string>
```

Generate a strong secret:
```bash
openssl rand -base64 32
```

Create the database and run migrations:
```bash
sqlx database create
sqlx migrate run
```

Start the server:
```bash
cargo run
```

The server listens on `http://localhost:3000`.

### 4. Set up the extension

```bash
cd extension
npm install
```

To watch and rebuild on file changes:
```bash
npm run dev
```

For a one-off production build:
```bash
npm run build
```

The built extension is output to `extension/dist/`.

### 5. Load the extension in your browser

#### Chrome / Chromium / Orion

1. Open `chrome://extensions` (or `about:extensions` in Orion)
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/dist/` directory

After any code change, run `npm run build` (or use `npm run dev`), then click the refresh icon on the extension card.

#### Firefox

Build the Firefox-specific distribution (replaces the Chrome manifest with the Firefox one):

```bash
npm run build:firefox
```

**Option A — `web-ext` (recommended for development):**

```bash
npm install -g web-ext
npm run build:firefox
web-ext run --source-dir dist/
```

`web-ext` auto-reloads the extension when the `dist/` directory changes. Pair it with `npm run dev` in a separate terminal for a fast feedback loop (run `build:firefox` once first to get the Firefox manifest in place, then `dev` will keep the JS up to date).

**Option B — manual load:**

1. Open `about:debugging`
2. Click **This Firefox** in the sidebar
3. Click **Load Temporary Add-on…**
4. Select `extension/dist/manifest.json`

Temporary add-ons are removed when Firefox closes. Re-load after each restart, or use `web-ext run` which handles this automatically.

> **Minimum versions:** Firefox 121 (MV3 service worker support) and Firefox 115 (`chrome.storage.session` support).

## API reference

All encrypted fields are base64-encoded AES-256-GCM blobs in JSON. The server never decrypts them.

### Auth

#### `POST /auth/register`

Creates a new account and an initial bookmark profile.

```json
{
  "email": "user@example.com",
  "auth_hash": "<base64 HKDF-derived auth key>",
  "profile_name": "Default",
  "encrypted_profile_metadata": "<base64 AES-GCM blob>",
  "protected_symmetric_key": "<base64 AES-GCM blob — symmetric key wrapped with wrapping key>"
}
```

Response:
```json
{ "token": "<JWT>", "profile_id": "<uuid>" }
```

#### `POST /auth/login`

```json
{ "email": "user@example.com", "auth_hash": "<base64>" }
```

Response:
```json
{
  "token": "<JWT>",
  "protected_symmetric_key": "<base64 AES-GCM blob>",
  "profiles": [{ "id": "<uuid>", "name": "Default", "encrypted_metadata": "<base64>" }]
}
```

The client decrypts `protected_symmetric_key` with the HKDF-derived wrapping key to recover the symmetric encryption key.

#### `POST /auth/change-password`

Requires `Authorization: Bearer <token>`.

```json
{
  "old_auth_hash": "<base64>",
  "new_auth_hash": "<base64>",
  "new_protected_symmetric_key": "<base64 — same symmetric key re-encrypted with new wrapping key>"
}
```

The server re-authenticates with `old_auth_hash` before updating. No data re-encryption is needed — only the PSK wrapper changes.

Response: `204 No Content`

### Profiles

All profile endpoints require `Authorization: Bearer <token>`.

#### `GET /profiles`

Returns all profiles for the authenticated user.

```json
{ "profiles": [{ "id": "<uuid>", "name": "Default" }] }
```

#### `POST /profiles`

Creates a new profile.

```json
{ "name": "Work", "encrypted_metadata": "<base64 AES-GCM blob>" }
```

Response:
```json
{ "id": "<uuid>", "name": "Work" }
```

#### `PATCH /profiles/{id}`

Renames a profile.

```json
{ "name": "Personal" }
```

Response: `204 No Content`

#### `DELETE /profiles/{id}`

Deletes a profile and all its deltas (cascade). Cannot delete the active profile — switch first.

Response: `204 No Content`

### Sync

#### `POST /sync/push`

Requires `Authorization: Bearer <token>`.

```json
{ "profile_id": "<uuid>", "encrypted_delta": "<base64 Loro binary update>" }
```

Response:
```json
{ "sequence_id": 42 }
```

#### `GET /sync/pull?profile_id=<uuid>&since_seq=<n>`

Requires `Authorization: Bearer <token>`.

Response:
```json
{
  "deltas": [
    { "sequence_id": 43, "encrypted_payload": "<base64>" }
  ]
}
```

#### `GET /sync/snapshot?profile_id=<uuid>`

Requires `Authorization: Bearer <token>`.

Returns the latest compacted snapshot, or `404` if none has been uploaded yet.

```json
{ "snapshot_seq": 150, "encrypted_payload": "<base64 encrypted Loro snapshot>" }
```

#### `PUT /sync/snapshot`

Requires `Authorization: Bearer <token>`.

Upserts a compacted snapshot. Only accepted if `snapshot_seq` is greater than the currently stored sequence — snapshots only move forward.

```json
{
  "profile_id": "<uuid>",
  "snapshot_seq": 150,
  "encrypted_payload": "<base64 encrypted Loro snapshot>"
}
```

Response: `204 No Content`

### WebSocket

#### `WS /ws?token=<JWT>&profile_id=<uuid>`

Server pushes a message whenever a new delta is stored for the profile:

```json
{ "sequence_id": 43 }
```

## Database schema

```sql
users             id, email, auth_hash, protected_symmetric_key, created_at
profiles          id, user_id, name, encrypted_metadata, created_at
deltas            sequence_id (BIGSERIAL), profile_id, encrypted_payload, created_at
profile_snapshots profile_id (PK), snapshot_seq, encrypted_payload, updated_at
```

`sequence_id` is a global monotonically increasing integer used as a sync cursor. Clients store their `lastSeqId` in IndexedDB per profile and pass it to `/sync/pull` to fetch only what they missed.

`profile_snapshots` holds at most one row per profile — the server upserts in place. New devices download the snapshot and only replay deltas since `snapshot_seq`, keeping initial sync fast regardless of total delta history.

## Project layout

```
extension/
├── src/
│   ├── background/     Service worker — sync loop, WebSocket, message handler
│   ├── popup/          SolidJS UI — login, lock screen, onboarding, profile
│   │                   switcher, settings, profile management, change password
│   ├── bookmarks/      chrome.bookmarks ↔ Loro bridge, echo filter, offline
│   │                   change detection (polling fallback for Orion)
│   ├── crdt/           Loro WASM wrapper
│   ├── crypto/         Argon2id + HKDF key derivation, AES-256-GCM
│   ├── sync/           HTTP push/pull/snapshot client, delta queue, WebSocket
│   ├── storage/        IndexedDB abstraction (snapshots, delta queue, meta)
│   ├── auth/           Session store — JWT, CryptoKey, PSK, profile list,
│   │                   chrome.storage persistence, lock/unlock
│   ├── config.ts       API base URL
│   └── types.ts        Popup ↔ background message protocol
├── public/
│   ├── manifest.json          Chrome / Chromium manifest
│   └── manifest.firefox.json  Firefox manifest (gecko ID, scripts vs service_worker)
└── vite.config.ts

server/
├── src/
│   ├── routes/         auth.rs, profiles.rs, sync.rs, ws.rs
│   ├── db/             queries.rs
│   ├── auth.rs         JWT issue/verify + AuthUser extractor
│   ├── error.rs        AppError → HTTP response mapping
│   ├── models.rs       User, Profile, Delta, Claims
│   └── main.rs         Router + startup
└── migrations/
    └── 001_init.sql
```

## Common tasks

```bash
# Reset the database (destructive — wipes all data)
cd server
sqlx database drop && sqlx database create && sqlx migrate run

# Add a database migration
sqlx migrate add <description>        # creates server/migrations/<ts>_<description>.sql
sqlx migrate run                      # apply pending migrations

# Check server logs with structured output
RUST_LOG=aegis_sync_server=debug cargo run

# Type-check the extension without building
cd extension && npm run lint

# Firefox: watch + auto-reload (run both in separate terminals)
cd extension && npm run build:firefox && npm run dev
web-ext run --source-dir dist/

# Point the extension at a different server
# Create extension/.env.local:
echo 'VITE_API_BASE=https://your-server.fly.dev' > extension/.env.local
npm run build
```

## Integration tests

The `tests/` directory contains end-to-end tests using [Playwright](https://playwright.dev). The global setup:

1. Starts a real PostgreSQL 16 database via [Testcontainers](https://testcontainers.com/) (requires Docker)
2. Builds the Rust server binary and spawns it on port 3001
3. Builds the extension pointed at that server
4. Each test gets a fresh Chromium instance with the extension loaded in an isolated user data directory

Tests run serially (one worker) since they share a server and database. Account isolation is achieved by generating unique email addresses per test — no truncation needed between tests.

| Spec | Coverage |
|---|---|
| `specs/auth.spec.ts` | Register (auto-detected), login, wrong password, lock/unlock, sign out |
| `specs/profiles.spec.ts` | Create, switch, rename, delete profiles; active-profile delete guard |
| `specs/sync.spec.ts` | Bookmark created in browser A appears in browser B after sync |

### Running locally

**Prerequisites:**

| Tool | Notes |
|---|---|
| Docker Desktop | Must be running before starting tests. Testcontainers uses it to spin up PostgreSQL. |
| Rust toolchain | `rustup` — used to `cargo build` the server binary |
| Node.js ≥ 22 | For the extension and test runner |

**First-time setup:**

```bash
cd tests
npm install

# Install Playwright's Chromium browser + OS dependencies
npx playwright install chromium --with-deps
```

**Running the tests:**

```bash
cd tests
npm test
```

The first run is slow — it compiles the Rust server binary (`cargo build`) and builds the extension with Vite. Subsequent runs reuse the cached binary as long as the server source hasn't changed.

```bash
# Run a single spec file
npm test -- specs/auth.spec.ts
npm test -- specs/profiles.spec.ts
npm test -- specs/sync.spec.ts

# Interactive UI mode (shows the browser, lets you step through tests)
npm run test:ui

# Line-by-line reporter (more compact output than the default)
npx playwright test --reporter=line
```

> **macOS note:** Chrome windows appear on screen during the run. This is expected — browser extensions require a headed browser; headless mode does not support the extension APIs.

### Troubleshooting

#### Docker is not running

```
Error: connect ECONNREFUSED /var/run/docker.sock
```

Start Docker Desktop and wait for it to finish initializing before re-running the tests.

---

#### Tests hang at "Get started" or time out on registration

The test setup passes `TEST_MODE=true` to the server, which switches Argon2id to minimal parameters (m=1024, t=1, p=1) so server-side hashing completes in milliseconds. If you see timeouts on the registration flow this environment variable is not reaching the server — check that the server process was started by the test setup (not a pre-existing server on port 3001).

---

#### Port 3001 already in use — tests run against the wrong server

```
Error: Address already in use (os error 48)
```

A server from a previous test run is still alive (e.g. the teardown failed to kill it). The new server fails to bind, but `waitForPort` succeeds because the old server still answers. Tests then run against the old binary, which may not have `TEST_MODE` active.

Kill the stale process before running:

```bash
lsof -ti :3001 | xargs kill -9
```

---

#### Testcontainers reaper errors

```
Error: Expected Reaper to map exposed port 8080
Error: No host port found for host IP
```

Stale testcontainers reaper containers from a previous crashed run are blocking new ones. Remove them:

```bash
docker ps -a --filter "label=org.testcontainers" --format "{{.ID}}" | xargs docker rm -f
docker ps -a --filter "name=testcontainers" --format "{{.ID}}" | xargs docker rm -f
```

Then re-run the tests.

---

#### Teardown logs "Failed to kill server: Error: kill ESRCH"

This is harmless. The server process exited on its own (e.g. due to a startup error) before teardown tried to kill it. The PG container is still stopped correctly.

---

#### Screenshot evidence on failure

The Playwright config saves a screenshot on test failure to `tests/test-results/<test-name>/`. Inspect these to see the exact UI state at the point of failure — they are especially useful for diagnosing which screen the popup was stuck on.

```bash
open tests/test-results/
```

### CI

The integration tests run automatically on push and pull requests via `.github/workflows/integration.yml` whenever `extension/`, `server/`, or `tests/` files change.

On Linux, Chrome requires a virtual display. The workflow uses `xvfb-run` for this. Docker is available by default on `ubuntu-latest` runners, so Testcontainers works without any additional setup.

If a test run fails, the Playwright HTML report is uploaded as a CI artifact (`playwright-report`) and retained for 7 days.

## Deployment (fly.io)

```bash
cd server
fly launch          # first time — provisions app and Postgres
fly deploy          # subsequent deploys

# Set secrets
fly secrets set JWT_SECRET="$(openssl rand -base64 32)"
fly secrets set DATABASE_URL="<postgres connection string>"
```
