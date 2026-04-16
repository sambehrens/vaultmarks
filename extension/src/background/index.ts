// Background service worker — single owner of all state.
// Orchestrates: crypto → auth → Loro doc → sync → bookmark bridge.

import { encrypt, decrypt } from "../crypto/aes";
import { initDoc, exportSnapshot, exportEmptySnapshot, importUpdate, getBookmarksFromSnapshot } from "../crdt/loro-doc";
import { loadSnapshot, saveSnapshot, getMeta, setMeta, clearDeltaQueue, deleteProfileData, clearAllLocalData } from "../storage/db";
import {
  setSession,
  clearSession,
  lockSession,
  isLoggedIn,
  isLocked,
  getJwt,
  getEmail,
  getEncryptionKey,
  setEncryptionKey,
  getActiveProfileId,
  getProfiles,
  getActiveProfile,
  addProfile,
  removeProfile,
  updateProfiles,
  switchProfile as switchSessionProfile,
  restoreFromSessionStorage,
  getSessionTimeout,
  setSessionTimeout,
  updateProtectedSymmetricKey,
} from "../auth/session";
import {
  apiLogin,
  apiRegister,
  apiCreateProfile,
  apiRenameProfile,
  apiDeleteProfile,
  apiGetProfiles,
  apiGetServerSnapshot,
  apiPutServerSnapshot,
  apiChangePassword,
  apiDeleteAccount,
  pushPending,
  pullSince,
  openEventStream,
  SseConnection,
} from "../sync/client";
import { enqueueDelta } from "../sync/delta-queue";
import {
  initBrowserRoots,
  attachBookmarkListeners,
  detachBookmarkListeners,
  applyRemoteUpdateOnly,
  reconcileBookmarks,
  bootstrapFromChrome,
  resetVersionCursor,
  loadMapping,
  hasEstablishedMapping,
  mergeLocalChangesIntoDoc,
  exportAndEnqueueLocalChanges,
  computeOfflineChanges,
  computeLocalImportDiff,
  mergeImportIntoDoc,
  clearManagedBookmarks,
} from "../bookmarks/bridge";
import { AuthExpiredError } from "../sync/client";
import type { ExtMessage, ExtResponse, ProfileInfo, PendingChanges, ImportDiff } from "../types";
import { LOG_TAG, PENDING_IMPORT_KEY } from "../config";

// ── Auth expiry ───────────────────────────────────────────────────────────────

/**
 * Called whenever a network operation returns 401 (AuthExpiredError).
 * Tears down the sync session and logs out so the popup shows the login form
 * rather than leaving the extension in a silently broken state.
 */
function onAuthExpired(): void {
  console.warn(`${LOG_TAG} JWT expired — logging out`);
  handleLogout().catch(console.error);
}

// ── State ─────────────────────────────────────────────────────────────────────

let sse: SseConnection | null = null;
let lastSynced: number | undefined;

// When the user unlocks and there are offline changes, initialization pauses
// here until the user decides whether to keep or discard those changes.
let _pendingChanges: PendingChanges | null = null;
let _pendingUnlockProfileId: string | null = null;

// When an existing user logs in on a new device that already has bookmarks,
// initialization pauses here until the user decides how to handle the conflict.
let _pendingImport: { profileId: string; diff: ImportDiff } | null = null;

function setPendingImport(value: { profileId: string; diff: ImportDiff } | null): void {
  _pendingImport = value;
  if (value) {
    chrome.storage.session.set({ [PENDING_IMPORT_KEY]: value });
  } else {
    chrome.storage.session.remove(PENDING_IMPORT_KEY);
  }
}

// ── Startup: restore session if SW was restarted within a browser session ─────
//
// Two promises gate different callers:
//
//   _sessionReady    — resolves after the fast chrome.storage.session read.
//                      GET_STATUS awaits this so the popup never flashes "logged
//                      out" due to a race with the async restore.
//
//   _startupComplete — resolves after initializeDocs + startSync finish.
//                      Alarm handlers await this so they never try to sync
//                      before the Loro doc is initialized and the WebSocket is
//                      open — which was causing the "interaction required to
//                      get updates" bug.

let _resolveSessionReady!: () => void;
const _sessionReady = new Promise<void>((r) => { _resolveSessionReady = r; });

let _resolveStartupComplete!: () => void;
const _startupComplete = new Promise<void>((r) => { _resolveStartupComplete = r; });

// Detect browser-specific bookmark root IDs (Firefox uses "toolbar_____" etc.
// instead of Chrome's "1", "2", "3") before any bookmark operation.
initBrowserRoots().catch(console.error);

restoreFromSessionStorage().then(async (restored) => {
  _resolveSessionReady(); // unblock GET_STATUS immediately
  if (!restored) {
    setIcon("signedout");
    _resolveStartupComplete();
    return;
  }
  if (!isLocked()) {
    setIconLocked(false); // extension reload resets the icon to the manifest default (signedout)
    // Check if a pending import conflict was waiting for user input before the SW was killed.
    const stored = await chrome.storage.session.get(PENDING_IMPORT_KEY) as Record<string, any>;
    if (stored[PENDING_IMPORT_KEY]) {
      _pendingImport = stored[PENDING_IMPORT_KEY];
      console.log(`${LOG_TAG} session restored with pending import conflict — waiting for user resolution`);
      await initializeDocs(getActiveProfileId());
      // Do NOT startSync — the user must resolve the conflict first.
    } else {
      console.log(`${LOG_TAG} session fully restored from session storage`);
      await initializeDocs(getActiveProfileId());
      startSync();
    }
  } else {
    console.log(`${LOG_TAG} session partially restored (locked) — key bytes missing`);
    setIconLocked(true);
    // Only push already-encrypted pending deltas (no key needed).
    // Don't open the event stream — incoming deltas require decryption.
    // startSync() runs after the user enters their master password.
    pushPending().catch((err) => {
      if (err instanceof AuthExpiredError) { onAuthExpired(); return; }
      console.error(err);
    });
  }
  _resolveStartupComplete(); // unblock alarm handlers
}).catch((err) => {
  console.error(err);
  _resolveSessionReady();
  _resolveStartupComplete();
});

// ── Keyboard commands ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "next-profile" && command !== "prev-profile") return;
  await _sessionReady; // ensure session is restored if SW was sleeping
  if (!isLoggedIn() || isLocked()) return;
  const profiles = getProfiles();
  if (profiles.length <= 1) return;
  const currentIdx = profiles.findIndex((p) => p.id === getActiveProfileId());
  const delta = command === "next-profile" ? 1 : -1;
  const nextIdx = (currentIdx + delta + profiles.length) % profiles.length;
  const result = await handleSwitchProfile(profiles[nextIdx].id);
  if (result.type === "SWITCH_SUCCESS") {
    // Notify the popup if it happens to be open so it can update immediately.
    chrome.runtime.sendMessage({ type: "PROFILE_SWITCHED", profileId: profiles[nextIdx].id }).catch(() => {});
  }
});

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ExtMessage, _sender, sendResponse: (r: ExtResponse) => void) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((err: unknown) => {
        console.error(`${LOG_TAG} message handler error`, err);
      });
    return true; // keep channel open for async response
  },
);

async function handleMessage(msg: ExtMessage): Promise<ExtResponse> {
  switch (msg.type) {
    case "LOGIN":
      return handleLogin(msg.email, msg.authKey, new Uint8Array(msg.wrappingKeyBytes));
    case "UNLOCK":
      return handleUnlock(new Uint8Array(msg.encryptionKeyBytes));
    case "LOGOUT":
      return handleLogout(msg.clearBookmarks);
    case "GET_STATUS":
      await _sessionReady;
      return {
        type: "STATUS",
        isLoggedIn: isLoggedIn(),
        isLocked: isLocked(),
        email: getEmail(),
        profile: getActiveProfile(),
        profiles: getProfiles(),
        lastSynced,
        pendingChanges: _pendingChanges ?? undefined,
        pendingImport: _pendingImport?.diff,
        sessionTimeout: getSessionTimeout(),
      };
    case "RESOLVE_LOCKED_CHANGES":
      return handleResolveLockedChanges(msg.apply);
    case "RESOLVE_IMPORT":
      return handleResolveImport(msg.choice, { profileName: msg.profileName, excludeDuplicates: msg.excludeDuplicates, targetProfileId: msg.targetProfileId });
    case "LOCK":
      return handleLock();
    case "SWITCH_PROFILE":
      return handleSwitchProfile(msg.profileId);
    case "CREATE_PROFILE":
      return handleCreateProfile(msg.name);
    case "DELETE_PROFILE":
      return handleDeleteProfile(msg.profileId);
    case "RENAME_PROFILE":
      return handleRenameProfile(msg.profileId, msg.name);
    case "SET_SESSION_TIMEOUT":
      setSessionTimeout(msg.value);
      return { type: "SET_SESSION_TIMEOUT_SUCCESS" };
    case "SYNC":
      return handleSync();
    case "RECOMPUTE_IMPORT_DIFF":
      return handleRecomputeImportDiff(msg.profileId);
    case "CHANGE_PASSWORD":
      return handleChangePassword(msg.oldAuthKey, msg.newAuthKey, msg.newProtectedSymmetricKey);
    case "EXPORT_PROFILE":
      return handleExportProfile(msg.profileId);
    case "DELETE_ACCOUNT":
      return handleDeleteAccount(msg.authKey);
  }
}

// ── Login flow ────────────────────────────────────────────────────────────────

async function handleLogin(
  email: string,
  authKey: string,
  wrappingKeyBytes: Uint8Array,
): Promise<ExtResponse> {
  try {
    // Import the wrapping key so we can decrypt the PSK returned by the server.
    const wrappingKey = await crypto.subtle.importKey(
      "raw",
      wrappingKeyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );

    // Try login first; fall back to register for first-time users.
    let token: string;
    let profiles: ProfileInfo[];
    let protectedSymmetricKey: string;
    let isNewAccount = false;

    try {
      const result = await apiLogin(email, authKey);
      token = result.token;
      profiles = result.profiles;
      protectedSymmetricKey = result.protectedSymmetricKey;
    } catch (loginErr) {
      // Only attempt registration if the account genuinely doesn't exist yet.
      try {
        // Generate a random symmetric key — this is the actual data encryption key.
        const symmetricKeyBytes = crypto.getRandomValues(new Uint8Array(32));
        // Wrap it with the wrapping key to create the PSK for server storage.
        protectedSymmetricKey = await encrypt(wrappingKey, symmetricKeyBytes);
        const placeholderMetadata = await encrypt(
          await crypto.subtle.importKey("raw", symmetricKeyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
          new TextEncoder().encode("{}"),
        );
        const reg = await apiRegister(email, authKey, "Default", placeholderMetadata, protectedSymmetricKey);
        token = reg.token;
        profiles = [{ id: reg.profileId, name: "Default" }];
        isNewAccount = true;
      } catch (regErr) {
        const msg = regErr instanceof Error ? regErr.message : String(regErr);
        if (msg === "email already registered") {
          throw new Error("Incorrect email or password.");
        }
        throw loginErr;
      }
    }

    // Decrypt the PSK with the wrapping key to recover the symmetric encryption key.
    if (!protectedSymmetricKey) {
      throw new Error("Server did not return a protected_symmetric_key — the server may need to be updated and the database reset.");
    }
    const symmetricKeyBytes = await decrypt(wrappingKey, protectedSymmetricKey);
    const encryptionKey = await crypto.subtle.importKey(
      "raw",
      symmetricKeyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );

    const activeProfileId = profiles[0].id;

    setSession({ jwt: token, email, encryptionKey, encryptionKeyRaw: symmetricKeyBytes, protectedSymmetricKey: protectedSymmetricKey!, userId: "", profiles, activeProfileId });

    // mergeOffline=false: offline bookmark merging belongs in the unlock flow,
    // not login. Merging here would push Chrome's local bookmarks to the server
    // as if they were intentional edits, overwriting the account's synced state.
    const { pendingImport, bootstrapped } = await initializeDocs(activeProfileId, false, true);
    if (pendingImport) {
      setPendingImport({ profileId: activeProfileId, diff: pendingImport });
      // Don't call startSync yet — a WS-triggered reconcile would overwrite Chrome
      // before the user has decided what to do with their local bookmarks.
      return { type: "LOGIN_SUCCESS", profiles, pendingImport };
    }
    setIconLocked(false);
    startSync();

    return { type: "LOGIN_SUCCESS", profiles, bootstrapped, isNewAccount };
  } catch (err) {
    return { type: "LOGIN_ERROR", error: String(err) };
  }
}

// ── Unlock flow (restore encryption key after SW restart) ─────────────────────

async function handleUnlock(encryptionKeyBytes: Uint8Array): Promise<ExtResponse> {
  try {
    const encryptionKey = await crypto.subtle.importKey(
      "raw",
      encryptionKeyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    setEncryptionKey(encryptionKey, encryptionKeyBytes);

    const profileId = getActiveProfileId();
    await loadMapping(profileId);
    const storedSnapshot = await loadSnapshot(profileId);

    if (storedSnapshot) {
      // Hydrate doc and check whether the user made any changes while locked.
      await initDoc(storedSnapshot);
      resetVersionCursor();
      const changes = await computeOfflineChanges();
      if (changes.added > 0 || changes.removed > 0 || changes.modified > 0) {
        // Pause initialization — wait for the user to decide what to do.
        _pendingChanges = changes;
        _pendingUnlockProfileId = profileId;
        // Keep the locked icon while the resolution panel is showing.
        setIconLocked(true);
        return {
          type: "UNLOCK_SUCCESS",
          profile: getActiveProfile(),
          profiles: getProfiles(),
          pendingChanges: changes,
        };
      }
    }

    // No offline changes (or no snapshot) — complete initialization normally.
    _pendingChanges = null;
    _pendingUnlockProfileId = null;
    await initializeDocs(profileId);
    setIconLocked(false);
    startSync();
    return { type: "UNLOCK_SUCCESS", profile: getActiveProfile(), profiles: getProfiles() };
  } catch (err) {
    return { type: "UNLOCK_ERROR", error: String(err) };
  }
}

/**
 * Complete the initialization that was paused while waiting for the user to
 * resolve offline changes. Called after RESOLVE_LOCKED_CHANGES.
 *
 * Precondition: initDoc() and loadMapping() have already been called (done
 * inside handleUnlock before pausing).
 */
async function completeUnlockInit(profileId: string, applyLocalChanges: boolean): Promise<void> {
  if (applyLocalChanges) {
    await mergeLocalChangesIntoDoc();
    // Enqueue the delta so offline changes reach the server.
    await exportAndEnqueueLocalChanges();
  }
  const lastSeq: number = (await getMeta<number>(`lastSeqId-${profileId}`)) ?? 0;
  await syncFrom(profileId, lastSeq, false, /* exclusive */ false);
  await reconcileBookmarks();
  attachBookmarkListeners();
}

async function handleResolveLockedChanges(apply: boolean): Promise<ExtResponse> {
  const profileId = _pendingUnlockProfileId;
  if (!profileId) return { type: "RESOLVE_ERROR", error: "No pending unlock to resolve." };
  _pendingChanges = null;
  _pendingUnlockProfileId = null;
  try {
    await completeUnlockInit(profileId, apply);
    setIconLocked(false);
    startSync();
    return { type: "RESOLVE_SUCCESS" };
  } catch (err) {
    // An OperationError from WebCrypto means the encryption key is wrong (wrong
    // master password entered during unlock). Re-lock so the user can try again.
    const isWrongKey = err instanceof DOMException && err.name === "OperationError";
    if (isWrongKey) {
      lockSession();
      setIconLocked(true);
    }
    return {
      type: "RESOLVE_ERROR",
      error: isWrongKey ? "Incorrect password — please unlock again." : (err instanceof Error ? err.message : String(err)),
    };
  }
}

// ── Import resolution ─────────────────────────────────────────────────────────

async function handleResolveImport(
  choice: "overwrite" | "merge" | "new_profile",
  opts: { profileName?: string; excludeDuplicates?: boolean; targetProfileId?: string },
): Promise<ExtResponse> {
  if (!_pendingImport) return { type: "RESOLVE_IMPORT_ERROR", error: "No pending import to resolve." };
  const { profileId: originalProfileId } = _pendingImport;
  setPendingImport(null);

  try {
    if (choice === "overwrite") {
      const targetProfileId = opts.targetProfileId ?? originalProfileId;

      if (targetProfileId !== originalProfileId) {
        // User compared against a different profile and chose to overwrite Chrome
        // with that profile's server state. Persist the original profile's snapshot
        // first, then load and switch to the target profile.
        await persistSnapshot(originalProfileId);

        switchSessionProfile(targetProfileId);
        await loadMapping(targetProfileId);
        const targetSnapshot = await loadSnapshot(targetProfileId);
        if (targetSnapshot) {
          await initDoc(targetSnapshot);
          resetVersionCursor();
          const lastSeq: number = (await getMeta<number>(`lastSeqId-${targetProfileId}`)) ?? 0;
          await syncFrom(targetProfileId, lastSeq, /* skipReconcile */ true, /* exclusive */ false);
        } else {
          await initDoc();
          await syncFrom(targetProfileId, 0, /* skipReconcile */ true, /* exclusive */ false);
        }

        await persistSnapshot(targetProfileId);
      } else {
        // Server state is already in the Loro doc — just persist and reconcile.
        await persistSnapshot(originalProfileId);
      }

      await reconcileBookmarks();
      attachBookmarkListeners();

    } else if (choice === "merge") {
      const targetProfileId = opts.targetProfileId ?? originalProfileId;

      if (targetProfileId !== originalProfileId) {
        // User chose a different profile to merge into.
        // Persist the original profile's server-state snapshot without touching Chrome.
        await persistSnapshot(originalProfileId);

        // Load the target profile's Loro doc (with skipReconcile so Chrome stays
        // as-is until after the merge decision is applied).
        switchSessionProfile(targetProfileId);
        await loadMapping(targetProfileId);
        const targetSnapshot = await loadSnapshot(targetProfileId);
        if (targetSnapshot) {
          await initDoc(targetSnapshot);
          resetVersionCursor();
          const lastSeq: number = (await getMeta<number>(`lastSeqId-${targetProfileId}`)) ?? 0;
          await syncFrom(targetProfileId, lastSeq, /* skipReconcile */ true, /* exclusive */ false);
        } else {
          await initDoc();
          await syncFrom(targetProfileId, 0, /* skipReconcile */ true, /* exclusive */ false);
        }
      }

      // Add Chrome bookmarks into the target profile's Loro doc, then push.
      await mergeImportIntoDoc(opts.excludeDuplicates ?? true);
      await exportAndEnqueueLocalChanges();
      await persistSnapshot(targetProfileId);
      await reconcileBookmarks();
      attachBookmarkListeners();

    } else {
      // "new_profile": put Chrome's bookmarks into a brand-new profile.

      // Persist the active profile's server data before we replace the Loro doc.
      await persistSnapshot(originalProfileId);

      // Create the profile on the server.
      const name = opts.profileName?.trim() || "Local Bookmarks";
      const encryptedMetadata = await encrypt(getEncryptionKey(), new TextEncoder().encode("{}"));
      const created = await apiCreateProfile(name, encryptedMetadata, getJwt());
      const newProfile: ProfileInfo = { id: created.id, name: created.name };
      addProfile(newProfile);

      // Switch session to new profile so enqueueDelta tags the delta correctly.
      switchSessionProfile(created.id);

      // Bootstrap a fresh Loro doc from Chrome's current bookmarks.
      await loadMapping(created.id);   // loads empty mapping (profile is new)
      await initDoc();                  // fresh empty doc
      await bootstrapFromChrome(created.id);
      await enqueueDelta(exportSnapshot());
      await persistSnapshot(created.id);

      // Chrome already has the bookmarks — reconcile is a no-op.
      await reconcileBookmarks();
      attachBookmarkListeners();

      setIconLocked(false);
      startSync();
      return { type: "RESOLVE_IMPORT_SUCCESS", newProfile };
    }

    setIconLocked(false);
    startSync();
    // When the user resolved against a different profile the session has switched
    // to that profile; tell the popup so it can update its active-profile display.
    const switchedProfile = (opts.targetProfileId ?? originalProfileId) !== originalProfileId;
    const activeProfile = switchedProfile ? getActiveProfile() : undefined;
    return { type: "RESOLVE_IMPORT_SUCCESS", activeProfile };
  } catch (err) {
    return { type: "RESOLVE_IMPORT_ERROR", error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Import diff recomputation ──────────────────────────────────────────────────

/**
 * Re-compute the local-vs-server diff against a different profile, so the
 * user can compare their Chrome bookmarks against any profile before deciding
 * how to resolve the conflict.
 *
 * Critically, _pendingImport.profileId is kept as the *original* conflict
 * profile throughout — only the diff is updated.  Previously this function
 * called setPendingImport({ profileId: comparisonProfileId, diff }) which
 * caused handleResolveImport to operate on (and reconcile Chrome to) the
 * comparison profile instead of the original one.
 */
async function handleRecomputeImportDiff(profileId: string): Promise<ExtResponse> {
  if (!_pendingImport) return { type: "RECOMPUTE_IMPORT_DIFF_ERROR", error: "No pending import to resolve." };
  if (!getProfiles().find((p) => p.id === profileId)) {
    return { type: "RECOMPUTE_IMPORT_DIFF_ERROR", error: "Profile not found." };
  }

  const originalProfileId = _pendingImport.profileId;

  try {
    // Load the comparison profile's server state without reconciling Chrome.
    await initDoc();
    await loadMapping(profileId);
    await syncFrom(profileId, 0, /* skipReconcile */ true, /* exclusive */ false);

    const diff = await computeLocalImportDiff();

    // Restore the original conflict profile's Loro doc so that
    // handleResolveImport always operates on the correct profile, regardless of
    // how many times the user switches "Compare with".
    if (profileId !== originalProfileId) {
      const originalSnapshot = await loadSnapshot(originalProfileId);
      await loadMapping(originalProfileId);
      if (originalSnapshot) {
        await initDoc(originalSnapshot);
        resetVersionCursor();
      } else {
        await initDoc();
      }
    }

    // Update the diff for display but preserve the original conflict profile ID.
    setPendingImport({ profileId: originalProfileId, diff });

    return { type: "RECOMPUTE_IMPORT_DIFF_SUCCESS", diff };
  } catch (err) {
    return { type: "RECOMPUTE_IMPORT_DIFF_ERROR", error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Doc initialisation ────────────────────────────────────────────────────────

/**
 * @param mergeOffline - When true, diff Chrome against the Loro snapshot and
 *   apply any changes made while signed out before pulling from the server.
 *   Pass false on profile switch — the Chrome bookmarks belong to the
 *   previously active profile and must not be merged into the new one.
 * @param checkImport - When true, detect whether an existing user signing in on
 *   a new device has Chrome bookmarks that differ from the server state, and
 *   if so return early with a pendingImport diff for the popup to resolve.
 */
async function initializeDocs(
  profileId: string,
  mergeOffline = true,
  checkImport = false,
): Promise<{ pendingImport?: ImportDiff; bootstrapped?: boolean }> {
  // Load the local loroId ↔ chromeId mapping before any reconcile or listener.
  await loadMapping(profileId);

  const storedSnapshot = await loadSnapshot(profileId);

  if (storedSnapshot) {
    // Hydrate from local snapshot, then pull any server deltas we missed.
    await initDoc(storedSnapshot);
    resetVersionCursor();
    if (mergeOffline && hasEstablishedMapping()) {
      // Capture bookmark changes made while signed out so they aren't
      // overwritten by the server state during the subsequent syncFrom.
      await mergeLocalChangesIntoDoc();
      // Enqueue the delta so offline changes reach the server.
      await exportAndEnqueueLocalChanges();
    }
    const lastSeq: number = (await getMeta<number>(`lastSeqId-${profileId}`)) ?? 0;
    // When checkImport=true, use skipReconcile so Chrome's original bookmarks
    // are preserved for the computeLocalImportDiff comparison below.
    await syncFrom(profileId, lastSeq, checkImport, /* exclusive */ false);
    if (checkImport) {
      // Returning device with prior state — check if Chrome has local bookmarks
      // not yet in the account (e.g. added while signed out on another device).
      const diff = await computeLocalImportDiff();
      if (diff.localOnly > 0) {
        // Early return: don't reconcile or attach listeners until resolved.
        return { pendingImport: diff };
      }
    }
  } else {
    // No local snapshot — this device has never synced this profile.
    // Try the server snapshot first; it avoids replaying every delta ever written.
    const encKey = getEncryptionKey();
    const serverSnapshot = await apiGetServerSnapshot(profileId).catch((err) => {
      console.warn(`${LOG_TAG} failed to fetch server snapshot, falling back to full delta replay`, err);
      return null;
    });

    if (serverSnapshot) {
      // Decrypt and load the compacted snapshot, then only pull deltas since it.
      const decrypted = await decrypt(encKey, serverSnapshot.encryptedPayload);
      await initDoc(decrypted);
      resetVersionCursor();
      await setMeta(`lastSeqId-${profileId}`, serverSnapshot.snapshotSeq);
      // When checkImport=true, use skipReconcile so Chrome's original bookmarks
      // are preserved for the computeLocalImportDiff comparison below.
      await syncFrom(profileId, serverSnapshot.snapshotSeq, checkImport, /* exclusive */ false);
    } else {
      // No server snapshot yet — pull from the beginning.
      await initDoc();
      // When checkImport=true, use skipReconcile so Chrome's original bookmarks
      // are preserved for the computeLocalImportDiff comparison below.
      await syncFrom(profileId, 0, checkImport, /* exclusive */ false);
    }

    const lastSeqAfterSync: number = (await getMeta<number>(`lastSeqId-${profileId}`)) ?? 0;
    if (lastSeqAfterSync === 0) {
      // Server has no data for this profile either.
      if (getProfiles().length === 1) {
        // Brand-new single-profile account — seed from Chrome so existing
        // bookmarks are preserved, then immediately enqueue the full snapshot
        // so it gets pushed to the server (bootstrap doesn't enqueue anything).
        const bootstrapCount = await bootstrapFromChrome(profileId);
        await enqueueDelta(exportSnapshot());
        await persistSnapshot(profileId);
        await reconcileBookmarks();
        attachBookmarkListeners();
        return { bootstrapped: bootstrapCount > 0 };
      }
      // Additional profiles with no server data start empty. reconcileBookmarks()
      // below will clear Chrome's bookmarks to match the empty doc.
    } else if (checkImport) {
      // Existing account on a new device — check if Chrome has local bookmarks
      // not yet in the account. If so, pause init and let the user decide.
      const diff = await computeLocalImportDiff();
      if (diff.localOnly > 0) {
        // Early return: don't reconcile or attach listeners until resolved.
        // persistSnapshot is intentionally skipped — the Loro doc has server
        // data but Chrome still has the user's original bookmarks.
        return { pendingImport: diff };
      }
    }

    await persistSnapshot(profileId);

    // After completing a full initial sync (no prior local snapshot), upload the
    // resulting snapshot so future new devices can skip the delta replay.
    // Only upload when we actually received data (lastSeqAfterSync > 0) and when
    // we didn't start from a server snapshot (which is already up-to-date).
    if (!serverSnapshot && lastSeqAfterSync > 0) {
      const encryptedSnapshot = await encrypt(encKey, exportSnapshot());
      apiPutServerSnapshot(profileId, lastSeqAfterSync, encryptedSnapshot).catch((err) => {
        // Non-fatal: the next device will just do a full delta replay instead.
        console.warn(`${LOG_TAG} failed to upload initial snapshot to server`, err);
      });
    }
  }

  // Reconcile the Loro doc state against Chrome bookmarks now that the doc is
  // fully loaded. Critical on profile switches where the doc is up-to-date but
  // Chrome still shows the previous profile's bookmarks.
  await reconcileBookmarks();

  attachBookmarkListeners();
  return {};
}

// ── Sync helpers ──────────────────────────────────────────────────────────────

let _syncInProgress = false;

/**
 * Pull deltas from `sinceSeq`, apply them to the Loro doc, persist the
 * snapshot, and (unless skipReconcile) reconcile Chrome.
 *
 * `exclusive` (default true) makes concurrent reactive calls (WS handler,
 * alarm) return immediately if a sync is already running — preventing two
 * reconcileBookmarks() calls from interleaving and causing bookmark flickering.
 * Pass false only from init/unlock paths that must always run to completion.
 */
async function syncFrom(profileId: string, sinceSeq: number, skipReconcile = false, exclusive = true): Promise<void> {
  if (exclusive && _syncInProgress) {
    console.log(`${LOG_TAG} syncFrom: already in progress, skipping (profile=${profileId.slice(0,8)})`);
    return;
  }
  _syncInProgress = true;
  try {
    await _syncFromInner(profileId, sinceSeq, skipReconcile);
  } finally {
    _syncInProgress = false;
  }
}

async function _syncFromInner(profileId: string, sinceSeq: number, skipReconcile: boolean): Promise<void> {
  const deltas = await pullSince(sinceSeq, profileId);
  console.log(`${LOG_TAG} syncFrom profile=${profileId.slice(0,8)} sinceSeq=${sinceSeq} → ${deltas.length} delta(s)`);
  if (deltas.length === 0) {
    lastSynced = Date.now();
    return;
  }

  // Apply all deltas first, then reconcile once. Applying and reconciling for
  // each individual delta would call reconcile O(n) times, scaling as O(n²)
  // total WASM/Chrome API work — which causes a call-stack overflow when
  // hundreds of bookmarks arrive (e.g. after first sync with Vivaldi or Opera).
  for (const delta of deltas) {
    console.log(`${LOG_TAG}   importing delta seq=${delta.sequenceId} bytes=${delta.payload.byteLength}`);
    applyRemoteUpdateOnly(delta.payload);
  }

  // Persist the snapshot BEFORE advancing lastSeqId. If the SW is killed between
  // the loop above and the writes below, lastSeqId stays at its previous value so
  // the same batch is re-pulled on restart. Re-applying Loro updates is idempotent,
  // so the only cost is redundant work — not data loss or corruption.
  await persistSnapshot(profileId);
  const newSeq = deltas[deltas.length - 1].sequenceId;
  await setMeta(`lastSeqId-${profileId}`, newSeq);

  if (!skipReconcile) {
    await reconcileBookmarks();
  }
  lastSynced = Date.now();

  // Keep the server snapshot current so new devices don't have to replay a long
  // delta tail. Fire-and-forget — failure just means a slightly staler snapshot.
  maybeUploadServerSnapshot(profileId, newSeq).catch((err) => {
    console.warn(`${LOG_TAG} server snapshot refresh failed (non-fatal)`, err);
  });
}

// Upload a fresh server snapshot every N deltas so new devices can skip delta
// replay. The snapshot is a single overwritten row — no extra storage cost.
const SNAPSHOT_UPLOAD_INTERVAL = 50;

async function maybeUploadServerSnapshot(profileId: string, currentSeq: number): Promise<void> {
  const lastUpload: number = (await getMeta<number>(`lastSnapshotUpload-${profileId}`)) ?? 0;
  if (currentSeq - lastUpload < SNAPSHOT_UPLOAD_INTERVAL) return;

  const encryptedSnapshot = await encrypt(getEncryptionKey(), exportSnapshot());
  await apiPutServerSnapshot(profileId, currentSeq, encryptedSnapshot);
  await setMeta(`lastSnapshotUpload-${profileId}`, currentSeq);
  console.log(`${LOG_TAG} server snapshot refreshed at seq=${currentSeq} for profile=${profileId.slice(0, 8)}`);
}

async function persistSnapshot(profileId: string): Promise<void> {
  await saveSnapshot(profileId, exportSnapshot());
}

/** Open (or reopen) the SSE event stream for the active profile. */
function connectEventStream(): void {
  const profileId = getActiveProfileId();
  const jwt = getJwt();

  if (!profileId) return;

  if (sse) {
    sse.close();
    sse = null;
  }

  sse = openEventStream(profileId, jwt, async (newSeq) => {
    const lastSeq: number = (await getMeta<number>(`lastSeqId-${profileId}`)) ?? 0;
    if (newSeq > lastSeq) {
      await syncFrom(profileId, lastSeq).catch((err) => {
        if (err instanceof AuthExpiredError) { onAuthExpired(); return; }
        console.error(err);
      });
    }
  }, () => {
    // onReconnectNeeded: handled by the "ws-reconnect" alarm in openEventStream.
  });
}

/**
 * Full sync startup: open the SSE event stream, drain the push queue, and
 * (re)start the 60-second poll alarm. Only call this on login, unlock, profile
 * switch, and SW restart — NOT from the ws-reconnect alarm, which should call
 * connectEventStream() directly to avoid resetting the poll timer.
 */
function startSync(): void {
  if (!getActiveProfileId()) {
    console.warn(`${LOG_TAG} startSync: profileId is invalid, skipping`);
    return;
  }

  connectEventStream();

  // Immediately drain any locally queued deltas.
  pushPending().catch((err) => {
    if (err instanceof AuthExpiredError) { onAuthExpired(); return; }
    console.error(err);
  });

  // Poll every 60 s as a fallback (in case the event stream drops and isn't reconnected).
  // Only create if not already running — prevents the ws-reconnect loop from
  // resetting the timer every 5 s in browsers where WebSocket is unavailable.
  chrome.alarms.get("sync-poll", (existing) => {
    if (!existing) {
      chrome.alarms.create("sync-poll", { periodInMinutes: 1 });
    }
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Wait for the full startup sequence (session restore + initializeDocs +
  // startSync) before acting. Without this, the alarm handler would see
  // isLoggedIn() === false and skip the sync, leaving the event stream closed
  // and updates only arriving when the user manually opens the popup.
  await _startupComplete;

  if (!isLoggedIn() || isLocked()) return;

  if (alarm.name === "ws-reconnect") {
    if (!sse || sse.closed) {
      // Only reconnect the event stream — don't call startSync() which would
      // reset the sync-poll alarm and break the 60 s polling cadence.
      connectEventStream();
    }
    return;
  }

  if (alarm.name === "sync-poll") {
    const profileId = getActiveProfileId();
    // Re-open the event stream if it dropped since the last poll.
    if (!sse || sse.closed) {
      connectEventStream();
    }

    // Fallback for browsers (e.g. Orion) where chrome.bookmarks events don't
    // fire reliably. Periodically diff Chrome's actual bookmark tree against
    // the Loro doc and push any changes that the event listeners missed.
    if (hasEstablishedMapping()) {
      computeOfflineChanges()
        .then(async (changes) => {
          if (changes.added > 0 || changes.removed > 0 || changes.modified > 0) {
            console.log(`${LOG_TAG} poll detected local changes: +${changes.added} -${changes.removed} ~${changes.modified} — merging`);
            await mergeLocalChangesIntoDoc();
            await exportAndEnqueueLocalChanges();
            await persistSnapshot(profileId);
          }
        })
        .catch(console.error);
    }

    getMeta<number>(`lastSeqId-${profileId}`)
      .then((seq) => syncFrom(profileId, seq ?? 0))
      .catch((err) => {
        if (err instanceof AuthExpiredError) { onAuthExpired(); return; }
        console.error(err);
      });
    pushPending().catch((err) => {
      if (err instanceof AuthExpiredError) { onAuthExpired(); return; }
      console.error(err);
    });
  }
});

// ── Icon state ────────────────────────────────────────────────────────────────

type IconState = "default" | "locked" | "signedout";

function setIcon(state: IconState): void {
  const suffix = state === "default" ? "" : `-${state}`;
  chrome.action.setIcon({
    path: {
      "16":  `assets/icon${suffix}-16.png`,
      "48":  `assets/icon${suffix}-48.png`,
      "128": `assets/icon${suffix}-128.png`,
    },
  });
}

function setIconLocked(locked: boolean): void {
  setIcon(locked ? "locked" : "default");
}

// ── Lock ──────────────────────────────────────────────────────────────────────

async function handleLock(): Promise<ExtResponse> {
  if (sse) { sse.close(); sse = null; }
  chrome.alarms.clear("sync-poll");
  chrome.alarms.clear("ws-reconnect");
  detachBookmarkListeners();
  lockSession(); // clears key from memory + session storage; keeps JWT + email
  setIconLocked(true);
  return { type: "LOCK_SUCCESS" };
}

// ── Change password ────────────────────────────────────────────────────────────

async function handleChangePassword(
  oldAuthKey: string,
  newAuthKey: string,
  newProtectedSymmetricKey: string,
): Promise<ExtResponse> {
  try {
    await apiChangePassword(oldAuthKey, newAuthKey, newProtectedSymmetricKey, getJwt());
    // Update the locally stored PSK so subsequent unlocks use the new wrapping key.
    updateProtectedSymmetricKey(newProtectedSymmetricKey);
    return { type: "CHANGE_PASSWORD_SUCCESS" };
  } catch (err) {
    return { type: "CHANGE_PASSWORD_ERROR", error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Export profile ────────────────────────────────────────────────────────────

async function handleExportProfile(profileId: string): Promise<ExtResponse> {
  try {
    const snapshot = await loadSnapshot(profileId);
    if (!snapshot) {
      return { type: "EXPORT_PROFILE_ERROR", error: "No local data for this profile. Open it at least once to sync it." };
    }
    const bookmarks = getBookmarksFromSnapshot(snapshot);
    return { type: "EXPORT_PROFILE_SUCCESS", bookmarks };
  } catch (err) {
    return { type: "EXPORT_PROFILE_ERROR", error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function handleLogout(clearBookmarks = false): Promise<ExtResponse> {
  if (sse) { sse.close(); sse = null; }
  chrome.alarms.clear("sync-poll");
  chrome.alarms.clear("ws-reconnect");
  detachBookmarkListeners(); // must be detached before clearing so no deltas are enqueued
  clearSession();
  // Clear the delta queue so stale deltas from this account don't bleed into
  // a new session (different user or re-created account).
  await clearDeltaQueue();
  if (clearBookmarks) {
    await clearManagedBookmarks();
  }
  setIcon("signedout");
  return { type: "LOGOUT_SUCCESS" };
}

// ── Delete account ────────────────────────────────────────────────────────────

async function handleDeleteAccount(authKey: string): Promise<ExtResponse> {
  try {
    const jwt = getJwt();
    await apiDeleteAccount(jwt, authKey);
    // Tear down active session exactly like logout, then wipe all local data.
    if (sse) { sse.close(); sse = null; }
    chrome.alarms.clear("sync-poll");
    chrome.alarms.clear("ws-reconnect");
    detachBookmarkListeners();
    clearSession();
    await clearAllLocalData();
    setIcon("signedout");
    return { type: "DELETE_ACCOUNT_SUCCESS" };
  } catch (err) {
    return { type: "DELETE_ACCOUNT_ERROR", error: String(err) };
  }
}

// ── Profile switch ────────────────────────────────────────────────────────────

async function handleSwitchProfile(profileId: string): Promise<ExtResponse> {
  if (isLocked()) return { type: "SWITCH_ERROR", error: "Session is locked." };
  try {
    console.log(`${LOG_TAG} switchProfile → ${profileId.slice(0,8)}`);
    switchSessionProfile(profileId);
    await initializeDocs(profileId, false); // don't merge: Chrome still shows previous profile
    startSync();
    return { type: "SWITCH_SUCCESS" };
  } catch (err) {
    console.error(`${LOG_TAG} switchProfile error`, err);
    return { type: "SWITCH_ERROR", error: String(err) };
  }
}

// ── Manual sync ───────────────────────────────────────────────────────────────

async function handleSync(): Promise<ExtResponse> {
  try {
    // If the SW was restarted and the session is locked (no encryption key in memory),
    // we still want to detect account deletion on other devices.  Do a lightweight
    // auth check; a 401 means the JWT is invalid (e.g. account deleted elsewhere) and
    // we should log out immediately.
    if (isLocked()) {
      try {
        await apiGetProfiles(getJwt());
      } catch (authErr) {
        if (authErr instanceof AuthExpiredError) {
          await handleLogout();
          return { type: "LOGOUT_SUCCESS" };
        }
      }
      return { type: "SYNC_ERROR", error: "Session is locked — please unlock to sync." };
    }

    const profileId = getActiveProfileId();

    // Detect local changes that event listeners may have missed (e.g. Orion).
    if (hasEstablishedMapping()) {
      const changes = await computeOfflineChanges();
      if (changes.added > 0 || changes.removed > 0 || changes.modified > 0) {
        console.log(`${LOG_TAG} sync detected local changes: +${changes.added} -${changes.removed} ~${changes.modified} — merging`);
        await mergeLocalChangesIntoDoc();
        await exportAndEnqueueLocalChanges();
        await persistSnapshot(profileId);
      }
    }

    await pushPending();
    const lastSeq: number = (await getMeta<number>(`lastSeqId-${profileId}`)) ?? 0;
    await syncFrom(profileId, lastSeq, false, /* exclusive */ false);
    // Refresh the profile list so profiles created on other devices appear.
    const freshProfiles = await apiGetProfiles(getJwt());
    updateProfiles(freshProfiles);
    return { type: "SYNC_SUCCESS", lastSynced: lastSynced!, profiles: freshProfiles };
  } catch (err) {
    if (err instanceof AuthExpiredError) {
      await handleLogout();
      // Return LOGOUT_SUCCESS so the popup immediately transitions to the login
      // form rather than staying on the main view with a stale logged-in state.
      return { type: "LOGOUT_SUCCESS" };
    }
    return { type: "SYNC_ERROR", error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Create profile ────────────────────────────────────────────────────────────

async function handleCreateProfile(name: string): Promise<ExtResponse> {
  try {
    const encryptedMetadata = await encrypt(getEncryptionKey(), new TextEncoder().encode("{}"));
    const created = await apiCreateProfile(name, encryptedMetadata, getJwt());
    const profile = { id: created.id, name: created.name };
    addProfile(profile);
    // Pre-seed an empty snapshot and empty ID mapping so that when the user
    // switches to this profile, initializeDocs sees a known-empty state and
    // doesn't fall back to bootstrapping from Chrome.
    await saveSnapshot(created.id, exportEmptySnapshot());
    await setMeta(`chromeIdMap-${created.id}`, {});
    return { type: "CREATE_PROFILE_SUCCESS", profile };
  } catch (err) {
    return { type: "CREATE_PROFILE_ERROR", error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Rename profile ────────────────────────────────────────────────────────────

async function handleRenameProfile(profileId: string, name: string): Promise<ExtResponse> {
  const trimmed = name.trim();
  if (!trimmed) {
    return { type: "RENAME_PROFILE_ERROR", error: "Profile name cannot be empty." };
  }
  try {
    await apiRenameProfile(profileId, trimmed, getJwt());
    const updated = getProfiles().map((p) => p.id === profileId ? { ...p, name: trimmed } : p);
    updateProfiles(updated);
    return { type: "RENAME_PROFILE_SUCCESS", name: trimmed };
  } catch (err) {
    return { type: "RENAME_PROFILE_ERROR", error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Delete profile ────────────────────────────────────────────────────────────

async function handleDeleteProfile(profileId: string): Promise<ExtResponse> {
  if (profileId === getActiveProfileId()) {
    return { type: "DELETE_PROFILE_ERROR", error: "Cannot delete the active profile. Switch to another profile first." };
  }
  try {
    await apiDeleteProfile(profileId, getJwt());
    removeProfile(profileId);
    await deleteProfileData(profileId);
    return { type: "DELETE_PROFILE_SUCCESS" };
  } catch (err) {
    return { type: "DELETE_PROFILE_ERROR", error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Install ───────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log(`${LOG_TAG} installed`);
});
