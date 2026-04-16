// Sync client — HTTP push/pull and WebSocket notification listener.

import { API_BASE, WS_BASE, LOG_TAG } from "../config";
import { getJwt, getActiveProfileId } from "../auth/session";
import { decrypt, fromBase64 } from "../crypto/aes";
import { getEncryptionKey } from "../auth/session";
import { peek, acknowledge } from "./delta-queue";
import type { QueuedDelta } from "../storage/db";

export interface RawDelta {
  sequenceId: number;
  payload: Uint8Array; // decrypted Loro binary update
}

// ── Fetch with timeout ────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;

/**
 * fetch() wrapper that aborts the request after FETCH_TIMEOUT_MS (default 30s).
 * A hanging server connection would otherwise block the SW indefinitely.
 */
function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface LoginResult {
  token: string;
  profiles: Array<{ id: string; name: string }>;
  protectedSymmetricKey: string;
}

/**
 * Thrown when the server returns 401 — the JWT has expired or been revoked.
 * The background catches this and forces a logout so the user is prompted to
 * re-authenticate rather than left with a silently broken extension.
 */
export class AuthExpiredError extends Error {
  constructor() { super("Session expired — please sign in again."); this.name = "AuthExpiredError"; }
}

/**
 * Thrown when the server returns 403 on an operation that should succeed for a
 * valid user — almost always because the account was deleted on another device
 * while this session's JWT was still valid. Extends AuthExpiredError so all
 * existing `instanceof AuthExpiredError` handlers trigger a logout automatically.
 */
export class AccountRevokedError extends AuthExpiredError {
  constructor() {
    super();
    this.message = "Account no longer exists — please sign in again.";
    this.name = "AccountRevokedError";
  }
}

async function throwIfNotOk(res: Response, prefix: string): Promise<void> {
  if (res.ok) return;
  if (res.status === 401) throw new AuthExpiredError();
  if (res.status === 403) throw new AccountRevokedError();
  let message = `${prefix}: ${res.status}`;
  try {
    const body = await res.json() as { error?: string };
    if (body.error) message = body.error;
  } catch { /* ignore parse errors */ }
  throw new Error(message);
}

export async function apiRegister(
  email: string,
  authKey: string,
  profileName: string,
  encryptedProfileMetadata: string,
  protectedSymmetricKey: string,
): Promise<{ token: string; profileId: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      auth_hash: authKey,
      profile_name: profileName,
      encrypted_profile_metadata: encryptedProfileMetadata,
      protected_symmetric_key: protectedSymmetricKey,
    }),
  });
  await throwIfNotOk(res, "register failed");
  const data = await res.json() as { token: string; profile_id: string };
  return { token: data.token, profileId: data.profile_id };
}

export async function apiLogin(email: string, authKey: string): Promise<LoginResult> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, auth_hash: authKey }),
  });
  await throwIfNotOk(res, "login failed");
  const data = await res.json();
  return { token: data.token, profiles: data.profiles, protectedSymmetricKey: data.protected_symmetric_key };
}

export async function apiGetProfiles(jwt: string): Promise<Array<{ id: string; name: string }>> {
  const res = await fetchWithTimeout(`${API_BASE}/profiles`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  await throwIfNotOk(res, "get profiles failed");
  const data = await res.json() as { profiles: Array<{ id: string; name: string }> };
  return data.profiles;
}

export async function apiCreateProfile(
  name: string,
  encryptedMetadata: string,
  jwt: string,
): Promise<{ id: string; name: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ name, encrypted_metadata: encryptedMetadata }),
  });
  await throwIfNotOk(res, "create profile failed");
  return res.json();
}

export async function apiRenameProfile(profileId: string, name: string, jwt: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/profiles/${profileId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ name }),
  });
  await throwIfNotOk(res, "rename profile failed");
}

export async function apiDeleteProfile(profileId: string, jwt: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/profiles/${profileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  await throwIfNotOk(res, "delete profile failed");
}

export async function apiDeleteAccount(jwt: string, authKey: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/account`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ auth_hash: authKey }),
  });
  await throwIfNotOk(res, "delete account failed");
}

export async function apiChangePassword(
  oldAuthKey: string,
  newAuthKey: string,
  newProtectedSymmetricKey: string,
  jwt: string,
): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      old_auth_hash: oldAuthKey,
      new_auth_hash: newAuthKey,
      new_protected_symmetric_key: newProtectedSymmetricKey,
    }),
  });
  await throwIfNotOk(res, "change password failed");
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

export interface ServerSnapshot {
  snapshotSeq: number;
  encryptedPayload: string; // base64
}

/**
 * Fetch the latest compacted snapshot for a profile from the server.
 * Returns null if no snapshot has been uploaded yet (404).
 */
export async function apiGetServerSnapshot(profileId: string): Promise<ServerSnapshot | null> {
  const jwt = getJwt();
  const res = await fetchWithTimeout(
    `${API_BASE}/sync/snapshot?profile_id=${profileId}`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  );
  if (res.status === 404) return null;
  await throwIfNotOk(res, "get snapshot failed");
  const data = await res.json() as { snapshot_seq: number; encrypted_payload: string };
  return { snapshotSeq: data.snapshot_seq, encryptedPayload: data.encrypted_payload };
}

/**
 * Upload a compacted snapshot for a profile to the server.
 * The server only accepts it if snapshotSeq is greater than the stored seq.
 */
export async function apiPutServerSnapshot(
  profileId: string,
  snapshotSeq: number,
  encryptedPayload: string,
): Promise<void> {
  const jwt = getJwt();
  const res = await fetchWithTimeout(`${API_BASE}/sync/snapshot`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ profile_id: profileId, snapshot_seq: snapshotSeq, encrypted_payload: encryptedPayload }),
  });
  await throwIfNotOk(res, "put snapshot failed");
}

// ── Push ──────────────────────────────────────────────────────────────────────

let _pushInProgress = false;

/**
 * Drains the local delta queue by pushing batches to the server.
 *
 * Guards against concurrent calls (e.g. from onLocalChange and the 60s alarm
 * firing simultaneously) which would peek the same batch and push duplicate
 * deltas, causing the server delta log to accumulate redundant rows.
 */
export async function pushPending(): Promise<void> {
  if (_pushInProgress) return;
  _pushInProgress = true;
  try {
    await _pushPendingInner();
  } finally {
    _pushInProgress = false;
  }
}

async function _pushPendingInner(): Promise<void> {
  const batch: QueuedDelta[] = await peek(50);
  if (batch.length === 0) return;

  const jwt = getJwt();
  const activeProfile = getActiveProfileId();
  console.log(`${LOG_TAG} pushPending: ${batch.length} delta(s), activeProfile=${activeProfile}`);
  const succeeded: string[] = [];

  for (const item of batch) {
    console.log(`${LOG_TAG} push: deltaId=${item.id} profileId=${item.profileId} bytes=${item.encryptedDelta.length}`);
    const res = await fetchWithTimeout(`${API_BASE}/sync/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ profile_id: item.profileId, encrypted_delta: item.encryptedDelta }),
    });
    if (res.ok) {
      console.log(`${LOG_TAG} push: ok for profileId=${item.profileId}`);
      succeeded.push(item.id);
    } else if (res.status === 403 && item.profileId === activeProfile) {
      // 403 on the active profile means the account was deleted server-side
      // while this JWT was still valid. Propagate so the background forces logout.
      throw new AccountRevokedError();
    } else if (res.status === 400 || res.status === 403 || res.status === 404) {
      // Unrecoverable: profile doesn't exist, doesn't belong to this user, or
      // the delta is malformed. Discard so it doesn't block subsequent pushes.
      console.warn(`${LOG_TAG} push: discarding unrecoverable delta ${item.id} (HTTP ${res.status}, profileId=${item.profileId})`);
      succeeded.push(item.id);
    } else {
      console.error(`${LOG_TAG} push: HTTP ${res.status} for profileId=${item.profileId} (activeProfile=${activeProfile})`);
      // Transient failure (auth error, server error) — stop and retry later.
      break;
    }
  }

  await acknowledge(succeeded);
}

// ── Pull ──────────────────────────────────────────────────────────────────────

/** Fetch all deltas since `sinceSeq` and decrypt them. */
export async function pullSince(sinceSeq: number, explicitProfileId?: string): Promise<RawDelta[]> {
  const profileId = explicitProfileId ?? getActiveProfileId();
  const jwt = getJwt();
  const encKey = getEncryptionKey();

  const res = await fetchWithTimeout(
    `${API_BASE}/sync/pull?profile_id=${profileId}&since_seq=${sinceSeq}`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  );
  await throwIfNotOk(res, "pull failed");

  const data: { deltas: Array<{ sequence_id: number; encrypted_payload: string }> } = await res.json();

  return Promise.all(
    data.deltas.map(async (d) => ({
      sequenceId: d.sequence_id,
      payload: await decrypt(encKey, d.encrypted_payload),
    })),
  );
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

export type OnNewSeq = (sequenceId: number) => void;

export function openWebSocket(
  profileId: string,
  token: string,
  onNewSeq: OnNewSeq,
  onReconnectNeeded: () => void,
): WebSocket {
  const url = `${WS_BASE}/ws?token=${encodeURIComponent(token)}&profile_id=${encodeURIComponent(profileId)}`;
  const ws = new WebSocket(url);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as { sequence_id: number };
      onNewSeq(msg.sequence_id);
    } catch {
      // ignore malformed frames
    }
  };

  ws.onerror = (e) => console.error(`${LOG_TAG} ws error`, e);

  ws.onclose = () => {
    console.log(`${LOG_TAG} ws closed, scheduling reconnect`);
    // Schedule a reconnect via the alarm so the service worker stays awake.
    chrome.alarms.create("ws-reconnect", { delayInMinutes: 1 / 12 }); // ~5 seconds
    onReconnectNeeded();
  };

  return ws;
}
