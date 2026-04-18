// In-memory session store.
//
// Persistence strategy:
//   chrome.storage.local  — JWT, email, profiles, activeProfileId, sessionTimeout,
//                           protectedSymmetricKey (PSK — safe to store; requires
//                           wrapping key derived from master password to decrypt).
//                           Survives browser restarts; cleared on logout.
//                           When sessionTimeout === "never", also stores encryptionKeyRaw
//                           so the key survives browser restarts (no lock screen).
//   chrome.storage.session — encryptionKeyRaw (always, regardless of timeout setting).
//                           Memory-backed; cleared when the browser closes.
//                           When timeout is "on_restart" this is the only copy,
//                           so the user sees the lock screen after a browser restart.

import type { ProfileInfo, SessionTimeout } from "../types";
import { LOG_TAG, STORAGE_KEYS } from "../config";

interface Session {
  jwt: string;
  email: string;
  encryptionKey: CryptoKey | null; // null only transiently during restore
  encryptionKeyRaw: Uint8Array | undefined; // kept so timeout changes can re-persist it
  /** Base64-encoded PSK: the random symmetric key encrypted with the wrapping key. */
  protectedSymmetricKey: string;
  userId: string;
  profiles: ProfileInfo[];
  activeProfileId: string;
}

// Keys written to chrome.storage.local (survive browser close).
const LOCAL_KEYS = [
  STORAGE_KEYS.jwt,
  STORAGE_KEYS.email,
  STORAGE_KEYS.profiles,
  STORAGE_KEYS.activeProfileId,
  STORAGE_KEYS.protectedSymmetricKey,
];

let _session: Session | null = null;
let _sessionTimeout: SessionTimeout = "on_restart";

// ── Session timeout ────────────────────────────────────────────────────────────

export function getSessionTimeout(): SessionTimeout {
  return _sessionTimeout;
}

export function setSessionTimeout(value: SessionTimeout): void {
  _sessionTimeout = value;
  chrome.storage.local.set({ [STORAGE_KEYS.sessionTimeout]: value });
  if (value === "never" && _session?.encryptionKeyRaw) {
    // Persist key to local storage so it survives browser restarts.
    chrome.storage.local.set({ [STORAGE_KEYS.encryptionKeyRaw]: Array.from(_session.encryptionKeyRaw) });
  } else if (value === "on_restart") {
    // Remove the persisted key — next browser restart will require password entry.
    chrome.storage.local.remove(STORAGE_KEYS.encryptionKeyRaw);
  }
}

// ── Mutators ──────────────────────────────────────────────────────────────────

export function setSession(s: {
  jwt: string;
  email: string;
  encryptionKey: CryptoKey;
  encryptionKeyRaw: Uint8Array;
  protectedSymmetricKey: string;
  userId: string;
  profiles: ProfileInfo[];
  activeProfileId: string;
}): void {
  _session = {
    jwt: s.jwt,
    email: s.email,
    encryptionKey: s.encryptionKey,
    encryptionKeyRaw: s.encryptionKeyRaw,
    protectedSymmetricKey: s.protectedSymmetricKey,
    userId: s.userId,
    profiles: s.profiles,
    activeProfileId: s.activeProfileId,
  };
  chrome.storage.local.set({
    [STORAGE_KEYS.jwt]:                   s.jwt,
    [STORAGE_KEYS.email]:                 s.email,
    [STORAGE_KEYS.profiles]:              s.profiles,
    [STORAGE_KEYS.activeProfileId]:       s.activeProfileId,
    [STORAGE_KEYS.protectedSymmetricKey]: s.protectedSymmetricKey,
  });
  chrome.storage.session.set({ encryptionKeyRaw: Array.from(s.encryptionKeyRaw) });
  if (_sessionTimeout === "never") {
    chrome.storage.local.set({ [STORAGE_KEYS.encryptionKeyRaw]: Array.from(s.encryptionKeyRaw) });
  }
}

export function clearSession(): void {
  _session = null;
  chrome.storage.session.clear();
  chrome.storage.local.remove([...LOCAL_KEYS, STORAGE_KEYS.encryptionKeyRaw]);
}

/** Update the stored PSK after a successful password change (new wrapping key). */
export function updateProtectedSymmetricKey(psk: string): void {
  if (!_session) throw new Error("Not logged in");
  _session.protectedSymmetricKey = psk;
  chrome.storage.local.set({ [STORAGE_KEYS.protectedSymmetricKey]: psk });
}

/** Swap the stored JWT after the server re-issues one (e.g. on password change). */
export function updateJwt(jwt: string): void {
  if (!_session) throw new Error("Not logged in");
  _session.jwt = jwt;
  chrome.storage.local.set({ [STORAGE_KEYS.jwt]: jwt });
}

/**
 * Lock the session: clear the encryption key from memory and from session
 * storage, but keep the JWT and profile metadata so the user only needs to
 * re-enter their master password (not their email too).
 */
export function lockSession(): void {
  if (!_session) return;
  _session.encryptionKey = null;
  _session.encryptionKeyRaw = undefined;
  chrome.storage.session.remove("encryptionKeyRaw");
  chrome.storage.local.remove(STORAGE_KEYS.encryptionKeyRaw);
}

export function setEncryptionKey(key: CryptoKey, rawBytes: Uint8Array): void {
  if (!_session) throw new Error("No session to unlock");
  _session.encryptionKey = key;
  _session.encryptionKeyRaw = rawBytes;
  chrome.storage.session.set({ encryptionKeyRaw: Array.from(rawBytes) });
  if (_sessionTimeout === "never") {
    chrome.storage.local.set({ [STORAGE_KEYS.encryptionKeyRaw]: Array.from(rawBytes) });
  }
}

/**
 * Attempt to restore a session from persistent storage on service worker
 * startup. Returns true if a JWT was found.
 */
export async function restoreFromSessionStorage(): Promise<boolean> {
  const local = await chrome.storage.local.get([
    STORAGE_KEYS.jwt, STORAGE_KEYS.email, STORAGE_KEYS.profiles,
    STORAGE_KEYS.activeProfileId, STORAGE_KEYS.sessionTimeout,
    STORAGE_KEYS.encryptionKeyRaw, STORAGE_KEYS.protectedSymmetricKey,
  ]) as Record<string, any>;

  // Always load the timeout setting, even if not logged in.
  _sessionTimeout = local[STORAGE_KEYS.sessionTimeout] ?? "on_restart";

  if (!local[STORAGE_KEYS.jwt] || !local[STORAGE_KEYS.email] ||
      !local[STORAGE_KEYS.profiles] || !local[STORAGE_KEYS.activeProfileId] ||
      !local[STORAGE_KEYS.protectedSymmetricKey]) {
    return false;
  }

  // Try session storage first for key bytes (covers SW restarts within a browser session).
  const session = await chrome.storage.session.get("encryptionKeyRaw") as {
    encryptionKeyRaw?: number[];
  };

  // Fall back to local storage if timeout is "never" (key survives browser restarts).
  const keyNumbers = session.encryptionKeyRaw ??
    (_sessionTimeout === "never" ? local[STORAGE_KEYS.encryptionKeyRaw] : undefined);

  let encryptionKey: CryptoKey | null = null;
  let encryptionKeyRaw: Uint8Array | undefined;

  if (keyNumbers) {
    try {
      const bytes = new Uint8Array(keyNumbers);
      encryptionKey = await crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      );
      encryptionKeyRaw = bytes;
    } catch (err) {
      console.warn(`${LOG_TAG} encryptionKeyRaw could not be imported, falling back to locked state:`, err);
      chrome.storage.session.remove("encryptionKeyRaw");
      if (_sessionTimeout === "never") chrome.storage.local.remove(STORAGE_KEYS.encryptionKeyRaw);
    }
  }

  _session = {
    jwt: local[STORAGE_KEYS.jwt],
    email: local[STORAGE_KEYS.email],
    encryptionKey,
    encryptionKeyRaw,
    protectedSymmetricKey: local[STORAGE_KEYS.protectedSymmetricKey],
    userId: "",
    profiles: local[STORAGE_KEYS.profiles],
    activeProfileId: local[STORAGE_KEYS.activeProfileId],
  };
  return true;
}

// ── Accessors ─────────────────────────────────────────────────────────────────

export function isLoggedIn(): boolean {
  return _session !== null;
}

/** True when we have a JWT but no encryption key (browser was restarted). */
export function isLocked(): boolean {
  return _session !== null && _session.encryptionKey === null;
}

export function getEmail(): string | undefined {
  return _session?.email;
}

export function getJwt(): string {
  if (!_session) throw new Error("Not logged in");
  return _session.jwt;
}

export function getEncryptionKey(): CryptoKey {
  if (!_session) throw new Error("Not logged in");
  if (!_session.encryptionKey) throw new Error("Session is locked — encryption key not available");
  return _session.encryptionKey;
}

export function getProtectedSymmetricKey(): string {
  if (!_session) throw new Error("Not logged in");
  return _session.protectedSymmetricKey;
}

export function getActiveProfileId(): string {
  if (!_session) throw new Error("Not logged in");
  return _session.activeProfileId;
}

export function getProfiles(): ProfileInfo[] {
  return _session?.profiles ?? [];
}

export function getActiveProfile(): ProfileInfo | undefined {
  if (!_session) return undefined;
  return _session.profiles.find((p) => p.id === _session!.activeProfileId);
}

export function addProfile(profile: ProfileInfo): void {
  if (!_session) throw new Error("Not logged in");
  _session.profiles = [..._session.profiles, profile];
  chrome.storage.local.set({ [STORAGE_KEYS.profiles]: _session.profiles });
}

export function removeProfile(profileId: string): void {
  if (!_session) return;
  _session.profiles = _session.profiles.filter((p) => p.id !== profileId);
  chrome.storage.local.set({ [STORAGE_KEYS.profiles]: _session.profiles });
}

/** Replace the full profiles list (e.g. after a server sync that added new profiles). */
export function updateProfiles(profiles: ProfileInfo[]): void {
  if (!_session) return;
  _session.profiles = profiles;
  chrome.storage.local.set({ [STORAGE_KEYS.profiles]: profiles });
}

export function switchProfile(profileId: string): void {
  if (!_session) throw new Error("Not logged in");
  if (!_session.profiles.find((p) => p.id === profileId)) {
    throw new Error("Profile not found");
  }
  _session.activeProfileId = profileId;
  chrome.storage.local.set({ [STORAGE_KEYS.activeProfileId]: profileId });
}
