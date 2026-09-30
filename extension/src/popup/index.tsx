import { createSignal, createEffect, Show, For, Switch, Match } from "solid-js";
import { render } from "solid-js/web";
import { deriveKeys } from "../crypto/kdf";
import { encrypt, decrypt } from "../crypto/aes";
import type { ExtMessage, ExtResponse, ExtPush, ProfileInfo, PendingChanges, ImportDiff, SessionTimeout } from "../types";
import { APP_NAME, STORAGE_KEYS } from "../config";

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendOnce(msg: ExtMessage): Promise<ExtResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response: ExtResponse) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve(response);
    });
  });
}

function send(msg: ExtMessage, maxAttempts = 20): Promise<ExtResponse> {
  const attempt = (remaining: number, delay: number): Promise<ExtResponse> =>
    sendOnce(msg).catch((err) => {
      if (remaining <= 1) throw err;
      return new Promise<ExtResponse>((resolve) =>
        setTimeout(() => resolve(attempt(remaining - 1, Math.min(delay * 1.5, 1000))), delay),
      );
    });
  return attempt(maxAttempts, 100);
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const icon = (d: string) => () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={d} /></svg>
);

const RefreshIcon = icon("M5.46257 4.43262C7.21556 2.91688 9.5007 2 12 2C17.5228 2 22 6.47715 22 12C22 14.1361 21.3302 16.1158 20.1892 17.7406L17 12H20C20 7.58172 16.4183 4 12 4C9.84982 4 7.89777 4.84827 6.46023 6.22842L5.46257 4.43262ZM18.5374 19.5674C16.7844 21.0831 14.4993 22 12 22C6.47715 22 2 17.5228 2 12C2 9.86386 2.66979 7.88416 3.8108 6.25944L7 12H4C4 16.4183 7.58172 20 12 20C14.1502 20 16.1022 19.1517 17.5398 17.7716L18.5374 19.5674Z");
const BackIcon = icon("M10.8284 12.0007L15.7782 16.9504L14.364 18.3646L8 12.0007L14.364 5.63672L15.7782 7.05093L10.8284 12.0007Z");
const SettingsIcon = icon("M3.33946 17.0002C2.90721 16.2515 2.58277 15.4702 2.36133 14.6741C3.3338 14.1779 3.99972 13.1668 3.99972 12.0002C3.99972 10.8345 3.3348 9.824 2.36353 9.32741C2.81025 7.71651 3.65857 6.21627 4.86474 4.99001C5.7807 5.58416 6.98935 5.65534 7.99972 5.072C9.01009 4.48866 9.55277 3.40635 9.4962 2.31604C11.1613 1.8846 12.8847 1.90004 14.5031 2.31862C14.4475 3.40806 14.9901 4.48912 15.9997 5.072C17.0101 5.65532 18.2187 5.58416 19.1346 4.99007C19.7133 5.57986 20.2277 6.25151 20.66 7.00021C21.0922 7.7489 21.4167 8.53025 21.6381 9.32628C20.6656 9.82247 19.9997 10.8336 19.9997 12.0002C19.9997 13.166 20.6646 14.1764 21.6359 14.673C21.1892 16.2839 20.3409 17.7841 19.1347 19.0104C18.2187 18.4163 17.0101 18.3451 15.9997 18.9284C14.9893 19.5117 14.4467 20.5941 14.5032 21.6844C12.8382 22.1158 11.1148 22.1004 9.49633 21.6818C9.55191 20.5923 9.00929 19.5113 7.99972 18.9284C6.98938 18.3451 5.78079 18.4162 4.86484 19.0103C4.28617 18.4205 3.77172 17.7489 3.33946 17.0002ZM8.99972 17.1964C10.0911 17.8265 10.8749 18.8227 11.2503 19.9659C11.7486 20.0133 12.2502 20.014 12.7486 19.9675C13.1238 18.8237 13.9078 17.8268 14.9997 17.1964C16.0916 16.5659 17.347 16.3855 18.5252 16.6324C18.8146 16.224 19.0648 15.7892 19.2729 15.334C18.4706 14.4373 17.9997 13.2604 17.9997 12.0002C17.9997 10.74 18.4706 9.5632 19.2729 8.6665C19.1688 8.4405 19.0538 8.21822 18.9279 8.00021C18.802 7.78219 18.667 7.57148 18.5233 7.36842C17.3457 7.61476 16.0911 7.43414 14.9997 6.80405C13.9083 6.17395 13.1246 5.17768 12.7491 4.03455C12.2509 3.98714 11.7492 3.98646 11.2509 4.03292C10.8756 5.17671 10.0916 6.17364 8.99972 6.80405C7.9078 7.43447 6.65245 7.61494 5.47428 7.36803C5.18485 7.77641 4.93463 8.21117 4.72656 8.66637C5.52881 9.56311 5.99972 10.74 5.99972 12.0002C5.99972 13.2604 5.52883 14.4372 4.72656 15.3339C4.83067 15.5599 4.94564 15.7822 5.07152 16.0002C5.19739 16.2182 5.3324 16.4289 5.47612 16.632C6.65377 16.3857 7.90838 16.5663 8.99972 17.1964ZM11.9997 15.0002C10.3429 15.0002 8.99972 13.6571 8.99972 12.0002C8.99972 10.3434 10.3429 9.00021 11.9997 9.00021C13.6566 9.00021 14.9997 10.3434 14.9997 12.0002C14.9997 13.6571 13.6566 15.0002 11.9997 15.0002ZM11.9997 13.0002C12.552 13.0002 12.9997 12.5525 12.9997 12.0002C12.9997 11.4479 12.552 11.0002 11.9997 11.0002C11.4474 11.0002 10.9997 11.4479 10.9997 12.0002C10.9997 12.5525 11.4474 13.0002 11.9997 13.0002Z");
const PencilIcon = icon("M6.41421 15.89L16.5563 5.74785L15.1421 4.33363L5 14.4758V15.89H6.41421ZM7.24264 17.89H3V13.6473L14.435 2.21231C14.8256 1.82179 15.4587 1.82179 15.8492 2.21231L18.6777 5.04074C19.0682 5.43126 19.0682 6.06443 18.6777 6.45495L7.24264 17.89ZM3 19.89H21V21.89H3V19.89Z");
const DownloadIcon = icon("M13 10H18L12 16L6 10H11V3H13V10ZM4 19H20V12H22V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V12H4V19Z");
const TrashIcon = icon("M17 6H22V8H20V21C20 21.5523 19.5523 22 19 22H5C4.44772 22 4 21.5523 4 21V8H2V6H7V3C7 2.44772 7.44772 2 8 2H16C16.5523 2 17 2.44772 17 3V6ZM18 8H6V20H18V8ZM13.4142 13.9997L15.182 15.7675L13.7678 17.1817L12 15.4139L10.2322 17.1817L8.81802 15.7675L10.5858 13.9997L8.81802 12.232L10.2322 10.8178L12 12.5855L13.7678 10.8178L15.182 12.232L13.4142 13.9997ZM9 4V6H15V4H9Z");
const GitHubIcon = icon("M12.001 2C6.47598 2 2.00098 6.475 2.00098 12C2.00098 16.425 4.86348 20.1625 8.83848 21.4875C9.33848 21.575 9.52598 21.275 9.52598 21.0125C9.52598 20.775 9.51348 19.9875 9.51348 19.15C7.00098 19.6125 6.35098 18.5375 6.15098 17.975C6.03848 17.6875 5.55098 16.8 5.12598 16.5625C4.77598 16.375 4.27598 15.9125 5.11348 15.9C5.90098 15.8875 6.46348 16.625 6.65098 16.925C7.55098 18.4375 8.98848 18.0125 9.56348 17.75C9.65098 17.1 9.91348 16.6625 10.201 16.4125C7.97598 16.1625 5.65098 15.3 5.65098 11.475C5.65098 10.3875 6.03848 9.4875 6.67598 8.7875C6.57598 8.5375 6.22598 7.5125 6.77598 6.1375C6.77598 6.1375 7.61348 5.875 9.52598 7.1625C10.326 6.9375 11.176 6.825 12.026 6.825C12.876 6.825 13.726 6.9375 14.526 7.1625C16.4385 5.8625 17.276 6.1375 17.276 6.1375C17.826 7.5125 17.476 8.5375 17.376 8.7875C18.0135 9.4875 18.401 10.375 18.401 11.475C18.401 15.3125 16.0635 16.1625 13.8385 16.4125C14.201 16.725 14.5135 17.325 14.5135 18.2625C14.5135 19.6 14.501 20.675 14.501 21.0125C14.501 21.275 14.6885 21.5875 15.1885 21.4875C19.259 20.1133 21.9999 16.2963 22.001 12C22.001 6.475 17.526 2 12.001 2Z");
const LoaderIcon = icon("M3.05469 13H5.07065C5.55588 16.3923 8.47329 19 11.9998 19C15.5262 19 18.4436 16.3923 18.9289 13H20.9448C20.4474 17.5 16.6323 21 11.9998 21C7.36721 21 3.55213 17.5 3.05469 13ZM3.05469 11C3.55213 6.50005 7.36721 3 11.9998 3C16.6323 3 20.4474 6.50005 20.9448 11H18.9289C18.4436 7.60771 15.5262 5 11.9998 5C8.47329 5 5.55588 7.60771 5.07065 11H3.05469Z");
const CheckIcon = icon("M10 15.172L19.192 5.979L20.607 7.393L10 18L3.636 11.636L5.05 10.222L10 15.172Z");

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  // ── Navigation ──
  type View = "main" | "settings" | "manage-profiles" | "account-security";
  const [view, setView] = createSignal<View>("main");

  // ── Auth state ──
  const [initializing, setInitializing] = createSignal(true);
  const [isLoggedIn, setIsLoggedIn] = createSignal(false);
  const [isLocked, setIsLocked] = createSignal(false);
  const [profile, setProfile] = createSignal<ProfileInfo | undefined>();
  const [profiles, setProfiles] = createSignal<ProfileInfo[]>([]);
  const [lastSynced, setLastSynced] = createSignal<number | undefined>();
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [loadingLabel, setLoadingLabel] = createSignal("Unlocking…");
  const [error, setError] = createSignal<string | undefined>();
  const [syncing, setSyncing] = createSignal(false);

  // ── Profile management ──
  const [addingProfile, setAddingProfile] = createSignal(false);
  const [newProfileName, setNewProfileName] = createSignal("");
  const [profileError, setProfileError] = createSignal<string | undefined>();
  const [deletingProfileId, setDeletingProfileId] = createSignal<string | undefined>();
  const [deleteError, setDeleteError] = createSignal<{ id: string; msg: string } | undefined>();
  const [editingProfileId, setEditingProfileId] = createSignal<string | undefined>();
  const [editingProfileName, setEditingProfileName] = createSignal("");
  const [editingError, setEditingError] = createSignal<string | undefined>();
  const [editingLoading, setEditingLoading] = createSignal(false);
  const [exportingProfileId, setExportingProfileId] = createSignal<string | undefined>();
  const [exportError, setExportError] = createSignal<{ id: string; msg: string } | undefined>();

  // ── Conflict resolution ──
  const [pendingChanges, setPendingChanges] = createSignal<PendingChanges | undefined>();
  const [resolving, setResolving] = createSignal(false);
  const [pendingImport, setPendingImport] = createSignal<ImportDiff | undefined>();
  const [importAction, setImportAction] = createSignal<"overwrite" | "merge" | "new_profile">("overwrite");
  const [importExcludeDupes, setImportExcludeDupes] = createSignal(true);
  const [importProfileName, setImportProfileName] = createSignal("Local Bookmarks");
  const [importComparedProfileId, setImportComparedProfileId] = createSignal<string>("");
  const [importRecomputingDiff, setImportRecomputingDiff] = createSignal(false);

  function uniqueProfileName(base: string, existingProfiles: { name: string }[]): string {
    const names = new Set(existingProfiles.map((p) => p.name));
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base} (${n})`)) n++;
    return `${base} (${n})`;
  }
  const importComparedProfileName = () =>
    profiles().find((p) => p.id === importComparedProfileId())?.name ?? "";
  const [importResolving, setImportResolving] = createSignal(false);

  // ── Misc ──
  const [bootstrapNotice, setBootstrapNotice] = createSignal(false);

  // ── Onboarding (first sign-in for new accounts) ──
  const [onboarding, setOnboarding] = createSignal(false);
  const [onboardingProfileName, setOnboardingProfileName] = createSignal("Default");
  const [onboardingTimeout, setOnboardingTimeout] = createSignal<SessionTimeout>("on_restart");
  const [onboardingLoading, setOnboardingLoading] = createSignal(false);
  // True when the new account was bootstrapped from existing Chrome bookmarks.
  const [hadExistingBookmarks, setHadExistingBookmarks] = createSignal(false);
  const [exportOnGetStarted, setExportOnGetStarted] = createSignal(true);

  // ── Settings ──
  const [sessionTimeout, setSessionTimeoutSignal] = createSignal<SessionTimeout>("on_restart");

  // ── Theme ──
  type Theme = "system" | "light" | "dark";
  const [theme, setTheme] = createSignal<Theme>("system");

  createEffect(() => {
    const t = theme();
    document.documentElement.classList.remove("light", "dark");
    if (t !== "system") document.documentElement.classList.add(t);
  });

  chrome.storage.local.get(["theme"], (result) => {
    const t = result["theme"] as string;
    if (t === "light" || t === "dark" || t === "system") setTheme(t);
  });

  function changeTheme(t: Theme) {
    setTheme(t);
    chrome.storage.local.set({ theme: t });
  }

  // ── Change password ──
  const [currentPassword, setCurrentPassword] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  const [changePwLoading, setChangePwLoading] = createSignal(false);
  const [changePwError, setChangePwError] = createSignal<string | undefined>();
  const [changePwSuccess, setChangePwSuccess] = createSignal(false);

  // ── Delete account ──
  const [deleteAccountConfirm, setDeleteAccountConfirm] = createSignal(false);
  const [deleteAccountLoading, setDeleteAccountLoading] = createSignal(false);
  const [deleteAccountError, setDeleteAccountError] = createSignal<string | undefined>();
  const [deleteAccountPassword, setDeleteAccountPassword] = createSignal("");

  // ── Startup ──
  createEffect(() => {
    send({ type: "GET_STATUS" }).then((res) => {
      if (res.type === "STATUS") {
        setIsLoggedIn(res.isLoggedIn);
        setIsLocked(res.isLocked);
        setProfile(res.profile);
        setProfiles(res.profiles);
        setLastSynced(res.lastSynced);
        if (res.email) setEmail(res.email);
        setPendingChanges(res.pendingChanges);
        setPendingImport(res.pendingImport);
        if (res.pendingImport) {
          const comparedId = res.profile?.id ?? res.profiles[0]?.id ?? "";
          setImportComparedProfileId(comparedId);
          setImportProfileName(uniqueProfileName("Local Bookmarks", res.profiles));
        }
        setSessionTimeoutSignal(res.sessionTimeout);

        if (res.isLoggedIn && !res.isLocked && !res.pendingChanges && !res.pendingImport) {
          send({ type: "SYNC" }).then((syncRes) => {
            if (syncRes.type === "SYNC_SUCCESS") {
              setLastSynced(syncRes.lastSynced);
              if (syncRes.profiles) setProfiles(syncRes.profiles);
            } else if (syncRes.type === "LOGOUT_SUCCESS") {
              // Account was deleted on another device — session is now cleared.
              setIsLoggedIn(false);
              setIsLocked(false);
              setProfile(undefined);
              setProfiles([]);
              setEmail("");
              setView("main");
            }
          }).catch(console.error);
        }
      }
    }).catch(console.error).finally(() => setInitializing(false));
  });

  // Listen for background-initiated state changes (e.g. keyboard shortcut profile switch).
  chrome.runtime.onMessage.addListener((msg: ExtPush) => {
    if (msg.type === "PROFILE_SWITCHED") {
      setProfile(profiles().find((p) => p.id === msg.profileId));
    } else if (msg.type === "SWITCH_SETTLED") {
      // The drain loop has fully settled — bookmarks are reconciled and SSE is open.
      // Update the active profile and do a final sync to flush any deltas that
      // arrived during the switch (common on slow connections where the SSE fires
      // a new-seq notification shortly after initializeDocs returns).
      setProfile(profiles().find((p) => p.id === msg.profileId));
      send({ type: "SYNC" })
        .then((syncRes) => {
          if (syncRes.type === "SYNC_SUCCESS") {
            setLastSynced(syncRes.lastSynced);
            if (syncRes.profiles) setProfiles(syncRes.profiles);
          }
        })
        .catch(console.error)
        .finally(() => setSwitchingProfileId(undefined));
    }
  });

  // ── Auth actions ──
  async function login(e: Event) {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    try {
      setLoadingLabel("Deriving keys…");
      await new Promise((r) => setTimeout(r, 0));
      const { authKey, wrappingKeyBytes } = await deriveKeys(password(), email());
      setLoadingLabel("Authenticating…");
      const res = await send({ type: "LOGIN", email: email(), authKey, wrappingKeyBytes: Array.from(wrappingKeyBytes) });
      setLoading(false);
      if (res.type === "LOGIN_SUCCESS") {
        setIsLoggedIn(true);
        setIsLocked(false);
        setProfiles(res.profiles);
        setProfile(res.profiles[0]);
        setPendingImport(res.pendingImport);
        if (res.pendingImport) {
          const comparedId = res.profiles[0]?.id ?? "";
          setImportComparedProfileId(comparedId);
          setImportProfileName(uniqueProfileName("Local Bookmarks", res.profiles));
        }
        if (res.isNewAccount) {
          setOnboarding(true);
          setOnboardingProfileName("Default");
          setOnboardingTimeout("on_restart");
          setHadExistingBookmarks(!!res.bootstrapped);
        } else if (res.bootstrapped) {
          setBootstrapNotice(true);
        }
      } else if (res.type === "LOGIN_ERROR") {
        setError(res.error);
      }
    } catch (err) {
      setLoading(false);
      setError(String(err));
    }
  }

  async function unlock(e: Event) {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    try {
      setLoadingLabel("Deriving keys…");
      await new Promise((r) => setTimeout(r, 0));
      const { wrappingKeyBytes } = await deriveKeys(password(), email());

      // Read the PSK from local storage and decrypt it with the wrapping key to
      // recover the symmetric encryption key — wrong password → AES-GCM auth failure.
      const stored = await chrome.storage.local.get(STORAGE_KEYS.protectedSymmetricKey) as Record<string, any>;
      if (!stored[STORAGE_KEYS.protectedSymmetricKey]) throw new Error("No protected key found — please sign in again.");
      const wrappingKey = await crypto.subtle.importKey("raw", new Uint8Array(wrappingKeyBytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      let symmetricKeyBytes: Uint8Array;
      try {
        symmetricKeyBytes = await decrypt(wrappingKey, stored[STORAGE_KEYS.protectedSymmetricKey]);
      } catch {
        throw new Error("Incorrect password.");
      }

      setLoadingLabel("Unlocking…");
      const res = await send({ type: "UNLOCK", encryptionKeyBytes: Array.from(symmetricKeyBytes) });
      setLoading(false);
      if (res.type === "UNLOCK_SUCCESS") {
        setIsLocked(false);
        if (res.profiles.length > 0) {
          setProfiles(res.profiles);
          setProfile(res.profile ?? res.profiles[0]);
        }
        setPendingChanges(res.pendingChanges);
      } else if (res.type === "UNLOCK_ERROR") {
        setError(res.error);
      }
    } catch (err) {
      setLoading(false);
      setError(String(err));
    }
  }

  async function lock() {
    await send({ type: "LOCK" });
    setIsLocked(true);
    setPassword("");
    setPendingChanges(undefined);
    setView("main");
  }

  async function logout() {
    await send({ type: "LOGOUT", clearBookmarks: false });
    setIsLoggedIn(false);
    setIsLocked(false);
    setProfile(undefined);
    setProfiles([]);
    setPassword("");
    setEmail("");
    setPendingChanges(undefined);
    setPendingImport(undefined);
    setView("main");
  }

  async function logoutAndClear() {
    await send({ type: "LOGOUT", clearBookmarks: true });
    setIsLoggedIn(false);
    setIsLocked(false);
    setProfile(undefined);
    setProfiles([]);
    setPassword("");
    setEmail("");
    setPendingChanges(undefined);
    setPendingImport(undefined);
    setView("main");
  }

  async function recomputeImportDiff(profileId: string) {
    setImportRecomputingDiff(true);
    const res = await send({ type: "RECOMPUTE_IMPORT_DIFF", profileId });
    setImportRecomputingDiff(false);
    if (res.type === "RECOMPUTE_IMPORT_DIFF_SUCCESS") {
      setPendingImport(res.diff);
      setImportComparedProfileId(profileId);
    } else if (res.type === "RECOMPUTE_IMPORT_DIFF_ERROR") {
      setError(res.error);
    }
  }

  async function resolveImport() {
    setImportResolving(true);
    const res = await send({
      type: "RESOLVE_IMPORT",
      choice: importAction(),
      excludeDuplicates: importExcludeDupes(),
      profileName: importProfileName(),
      targetProfileId: (importAction() === "merge" || importAction() === "overwrite") ? importComparedProfileId() : undefined,
    });
    setImportResolving(false);
    setPendingImport(undefined);
    if (res.type === "RESOLVE_IMPORT_SUCCESS") {
      if (res.newProfile) {
        setProfiles([...profiles(), res.newProfile]);
        setProfile(res.newProfile);
      } else if (res.activeProfile) {
        setProfile(res.activeProfile);
      }
    }
  }

  async function resolveChanges(apply: boolean) {
    setResolving(true);
    const res = await send({ type: "RESOLVE_LOCKED_CHANGES", apply });
    setResolving(false);
    setPendingChanges(undefined);
    if (res.type === "RESOLVE_ERROR") {
      // The background re-locked (wrong password). Show the lock screen.
      setIsLocked(true);
      setError(res.error);
    }
  }

  const [switchingProfileId, setSwitchingProfileId] = createSignal<string | undefined>();

  async function switchProfile(profileId: string) {
    setSwitchingProfileId(profileId);
    const res = await send({ type: "SWITCH_PROFILE", profileId });
    if (res.type === "SWITCH_ERROR") {
      // On error, clear the spinner immediately — no SWITCH_SETTLED will follow.
      setSwitchingProfileId(undefined);
    }
    // On SWITCH_SUCCESS: keep the spinner active.
    // The background will push SWITCH_SETTLED once the drain loop fully settles
    // (bookmarks reconciled, sync started). The message listener below handles it.
  }

  async function createProfile(e: Event) {
    e.preventDefault();
    setLoading(true);
    setProfileError(undefined);
    const res = await send({ type: "CREATE_PROFILE", name: newProfileName() });
    setLoading(false);
    if (res.type === "CREATE_PROFILE_SUCCESS") {
      setProfiles([...profiles(), res.profile]);
      setNewProfileName("");
      setAddingProfile(false);
    } else if (res.type === "CREATE_PROFILE_ERROR") {
      setProfileError(res.error);
    }
  }

  async function confirmDeleteProfile(profileId: string) {
    setDeleteError(undefined);
    const res = await send({ type: "DELETE_PROFILE", profileId });
    if (res.type === "DELETE_PROFILE_SUCCESS") {
      setProfiles(profiles().filter((p) => p.id !== profileId));
      setDeletingProfileId(undefined);
    } else if (res.type === "DELETE_PROFILE_ERROR") {
      setDeleteError({ id: profileId, msg: res.error });
    }
  }

  async function submitRename(e: Event) {
    e.preventDefault();
    const profileId = editingProfileId();
    if (!profileId) return;
    setEditingLoading(true);
    setEditingError(undefined);
    const res = await send({ type: "RENAME_PROFILE", profileId, name: editingProfileName() });
    setEditingLoading(false);
    if (res.type === "RENAME_PROFILE_SUCCESS") {
      const updated = profiles().map((p) => p.id === profileId ? { ...p, name: res.name } : p);
      setProfiles(updated);
      if (profile()?.id === profileId) setProfile(updated.find((p) => p.id === profileId));
      setEditingProfileId(undefined);
    } else if (res.type === "RENAME_PROFILE_ERROR") {
      setEditingError(res.error);
    }
  }

  async function exportProfile(profileId: string, profileName: string) {
    setExportError(undefined);
    setExportingProfileId(profileId);
    try {
      let body: string;
      if (profileId === profile()?.id) {
        // Active profile — read directly from Chrome (most up to date).
        const [root] = await chrome.bookmarks.getTree();
        body = buildBookmarkNode(root, true);
      } else {
        // Non-active profile — reconstruct from the Loro snapshot.
        const res = await send({ type: "EXPORT_PROFILE", profileId });
        if (res.type !== "EXPORT_PROFILE_SUCCESS") {
          setExportError({ id: profileId, msg: res.type === "EXPORT_PROFILE_ERROR" ? res.error : "Export failed." });
          return;
        }
        body = buildHtmlFromLoroBookmarks(res.bookmarks);
      }
      const html = [
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
        "<!-- This is an automatically generated file. -->",
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        `<TITLE>${escapeHtml(profileName)}</TITLE>`,
        `<H1>${escapeHtml(profileName)}</H1>`,
        "<DL><p>",
        body,
        "</DL><p>",
      ].join("\n");
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${profileName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setExportingProfileId(undefined);
    }
  }

  function buildHtmlFromLoroBookmarks(
    bookmarks: Record<string, { title: string; url?: string; parentId: string; index: number; type: "bookmark" | "folder" }>,
  ): string {
    const ids = new Set(Object.keys(bookmarks));
    // Group children by parentId, sorted by index.
    const childrenOf: Record<string, [string, typeof bookmarks[string]][]> = {};
    for (const [id, node] of Object.entries(bookmarks)) {
      if (!childrenOf[node.parentId]) childrenOf[node.parentId] = [];
      childrenOf[node.parentId].push([id, node]);
    }
    for (const children of Object.values(childrenOf)) {
      children.sort((a, b) => a[1].index - b[1].index);
    }
    function renderNode(id: string, node: typeof bookmarks[string], ancestors: Set<string>): string {
      if (ancestors.has(id)) {
        console.warn(`[Vaultmarks] export: cycle detected at bookmark ${id}`);
        return "";
      }
      if (node.type === "bookmark") {
        return `<DT><A HREF="${escapeHtml(node.url ?? "")}">${escapeHtml(node.title)}</A>\n`;
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(id);
      const children = (childrenOf[id] ?? []).map(([cid, cn]) => renderNode(cid, cn, nextAncestors)).join("");
      return `<DT><H3>${escapeHtml(node.title)}</H3>\n<DL><p>\n${children}</DL><p>\n`;
    }
    // Root nodes are those whose parentId is not itself a node in the map.
    const rootParentIds = [...new Set(
      Object.values(bookmarks).map((n) => n.parentId).filter((pid) => !ids.has(pid)),
    )];
    return rootParentIds.flatMap((pid) =>
      (childrenOf[pid] ?? []).map(([id, node]) => renderNode(id, node, new Set())),
    ).join("");
  }

  function confirmPersistentUnlock(): boolean {
    return window.confirm(
      "Selecting Never stores your encryption key on disk so Vaultmarks stays unlocked after browser restart. Continue?",
    );
  }

  function changeOnboardingTimeout(value: SessionTimeout): void {
    if (value === "never" && onboardingTimeout() !== "never" && !confirmPersistentUnlock()) {
      return;
    }
    setOnboardingTimeout(value);
  }

  async function changeSessionTimeout(value: SessionTimeout) {
    if (value === "never" && sessionTimeout() !== "never" && !confirmPersistentUnlock()) {
      return;
    }
    setSessionTimeoutSignal(value);
    await send({ type: "SET_SESSION_TIMEOUT", value });
  }

  // ── Change password ──────────────────────────────────────────────────────────

  async function changePassword(e: Event) {
    e.preventDefault();
    setChangePwError(undefined);
    setChangePwSuccess(false);
    if (newPassword() !== confirmPassword()) {
      setChangePwError("New passwords do not match.");
      return;
    }
    if (newPassword().length < 1) {
      setChangePwError("New password cannot be empty.");
      return;
    }
    setChangePwLoading(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      // Derive keys from both old and new passwords.
      const [oldKeys, newKeys] = await Promise.all([
        deriveKeys(currentPassword(), email()),
        deriveKeys(newPassword(), email()),
      ]);

      // Read the stored PSK and decrypt it with the old wrapping key.
      const stored = await chrome.storage.local.get(STORAGE_KEYS.protectedSymmetricKey) as Record<string, any>;
      if (!stored[STORAGE_KEYS.protectedSymmetricKey]) throw new Error("No protected key found — please sign in again.");
      const oldWrappingKey = await crypto.subtle.importKey("raw", new Uint8Array(oldKeys.wrappingKeyBytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      let symmetricKeyBytes: Uint8Array;
      try {
        symmetricKeyBytes = await decrypt(oldWrappingKey, stored[STORAGE_KEYS.protectedSymmetricKey]);
      } catch {
        throw new Error("Current password is incorrect.");
      }

      // Re-encrypt the symmetric key with the new wrapping key.
      const newWrappingKey = await crypto.subtle.importKey("raw", new Uint8Array(newKeys.wrappingKeyBytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      const newProtectedSymmetricKey = await encrypt(newWrappingKey, symmetricKeyBytes);

      const res = await send({
        type: "CHANGE_PASSWORD",
        oldAuthKey: oldKeys.authKey,
        newAuthKey: newKeys.authKey,
        newProtectedSymmetricKey,
      });

      if (res.type === "CHANGE_PASSWORD_SUCCESS") {
        setChangePwSuccess(true);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else if (res.type === "CHANGE_PASSWORD_ERROR") {
        setChangePwError(res.error);
      }
    } catch (err) {
      setChangePwError(err instanceof Error ? err.message : String(err));
    } finally {
      setChangePwLoading(false);
    }
  }

  // ── Delete account ────────────────────────────────────────────────────────────

  async function deleteAccount() {
    if (!deleteAccountPassword()) {
      setDeleteAccountError("Please enter your password to confirm.");
      return;
    }
    setDeleteAccountLoading(true);
    setDeleteAccountError(undefined);
    try {
      const keys = await deriveKeys(deleteAccountPassword(), email());
      const res = await send({ type: "DELETE_ACCOUNT", authKey: keys.authKey });
      if (res.type === "DELETE_ACCOUNT_SUCCESS") {
        setIsLoggedIn(false);
        setIsLocked(false);
        setProfile(undefined);
        setProfiles([]);
        setPassword("");
        setEmail("");
        setDeleteAccountPassword("");
        setView("main");
        setDeleteAccountConfirm(false);
      } else if (res.type === "DELETE_ACCOUNT_ERROR") {
        setDeleteAccountError(res.error);
      }
    } catch (err) {
      setDeleteAccountError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteAccountLoading(false);
    }
  }

  // ── Bookmark export (Netscape HTML format — importable in all browsers) ──

  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function buildBookmarkNode(node: chrome.bookmarks.BookmarkTreeNode, virtualRoot: boolean): string {
    if (virtualRoot) {
      return (node.children ?? []).map((c) => buildBookmarkNode(c, false)).join("");
    }
    const date = Math.floor((node.dateAdded ?? 0) / 1000);
    if (node.url) {
      return `<DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${date}">${escapeHtml(node.title)}</A>\n`;
    }
    const children = (node.children ?? []).map((c) => buildBookmarkNode(c, false)).join("");
    return `<DT><H3 ADD_DATE="${date}">${escapeHtml(node.title)}</H3>\n<DL><p>\n${children}</DL><p>\n`;
  }

  async function exportBookmarksBackup(): Promise<void> {
    const [root] = await chrome.bookmarks.getTree();
    const body = buildBookmarkNode(root, true);
    const html = [
      "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
      "<!-- This is an automatically generated file. -->",
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      "<TITLE>Bookmarks</TITLE>",
      "<H1>Bookmarks</H1>",
      "<DL><p>",
      body,
      "</DL><p>",
    ].join("\n");
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bookmarks-backup-${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function finishOnboarding(e: Event) {
    e.preventDefault();
    setOnboardingLoading(true);
    const activeProfile = profiles()[0];
    if (activeProfile) {
      const name = onboardingProfileName().trim() || "Default";
      if (name !== "Default") {
        const res = await send({ type: "RENAME_PROFILE", profileId: activeProfile.id, name });
        if (res.type === "RENAME_PROFILE_SUCCESS") {
          const updated = profiles().map((p) => p.id === activeProfile.id ? { ...p, name: res.name } : p);
          setProfiles(updated);
          setProfile(updated[0]);
        }
      }
      const timeout = onboardingTimeout();
      if (timeout !== "on_restart") {
        setSessionTimeoutSignal(timeout);
        await send({ type: "SET_SESSION_TIMEOUT", value: timeout });
      }
    }
    if (hadExistingBookmarks() && exportOnGetStarted()) {
      await exportBookmarksBackup().catch(console.error);
    }
    setOnboardingLoading(false);
    setOnboarding(false);
    if (hadExistingBookmarks()) setBootstrapNotice(true);
  }

  // ── View helpers ──
  const TAB_TITLES: Record<View, string> = {
    main: APP_NAME,
    settings: "Settings",
    "manage-profiles": "Manage Profiles",
    "account-security": "Account Security",
  };

  const isReady = () =>
    !initializing() && isLoggedIn() && !isLocked() && !onboarding() && !pendingChanges() && !pendingImport();

  function goBack() {
    if (view() === "settings") {
      setView("main");
      return;
    }
    setDeletingProfileId(undefined);
    setDeleteError(undefined);
    setEditingProfileId(undefined);
    setEditingError(undefined);
    setDeleteAccountConfirm(false);
    setDeleteAccountError(undefined);
    setView("settings");
  }

  async function syncNow() {
    setSyncing(true);
    const [res] = await Promise.all([
      send({ type: "SYNC" }),
      new Promise<void>((r) => setTimeout(r, 500)),
    ]);
    setSyncing(false);
    if (res.type === "SYNC_SUCCESS") {
      setLastSynced(res.lastSynced);
      if (res.profiles) setProfiles(res.profiles);
    } else if (res.type === "LOGOUT_SUCCESS") {
      // Auth expired on the server (e.g. account deleted by another device).
      setIsLoggedIn(false);
      setIsLocked(false);
      setProfile(undefined);
      setProfiles([]);
      setEmail("");
      setView("main");
    }
  }

  const status = (): { text: string; led: "ok" | "warn" | "off" } => {
    if (initializing()) return { text: "", led: "off" };
    if (!isLoggedIn()) return { text: "Not signed in", led: "off" };
    if (isLocked()) return { text: "Locked", led: "warn" };
    if (syncing()) return { text: "Syncing…", led: "warn" };
    const t = lastSynced();
    return t ? { text: `Synced at ${formatTime(t)}`, led: "ok" } : { text: "Not synced yet", led: "off" };
  };

  const plural = (n: number, word: string) => `${n} ${word}${n !== 1 ? "s" : ""}`;

  return (
    <div class="app">
      {/* ── Panel tab strip ── */}
      <div class="tabbar">
        <Show when={view() !== "main"}>
          <button class="btn-icon" title="Back" onClick={goBack}><BackIcon /></button>
        </Show>
        <div class="tab">
          <Show when={view() === "main"}>
            <img src="/assets/icon-16.png" width="14" height="14" alt="" />
          </Show>
          {TAB_TITLES[view()]}
        </div>
        <div class="tabbar-tools">
          <Show when={view() === "main" && isReady()}>
            <button onClick={syncNow} disabled={syncing()} title="Sync now" class="btn-icon">
              <span class={syncing() ? "btn-icon--spinning" : undefined}><RefreshIcon /></span>
            </button>
          </Show>
          <Show when={view() === "main" && !initializing() && isLoggedIn() && !isLocked() && !onboarding()}>
            <button onClick={() => setView("settings")} title="Settings" class="btn-icon"><SettingsIcon /></button>
          </Show>
          <Show when={view() === "settings"}>
            <a href="https://github.com/sambehrens/vaultmarks" target="_blank" rel="noopener noreferrer" class="btn-icon" title="View on GitHub"><GitHubIcon /></a>
          </Show>
        </div>
      </div>

      <div class="panel">
        <Switch>
          {/* ══ Main ══ */}
          <Match when={view() === "main"}>
            <Show when={initializing()}>
              <div class="empty">Loading…</div>
            </Show>

            {/* ── Fully logged out ── */}
            <Show when={!initializing() && !isLoggedIn() && !isLocked()}>
              <form onSubmit={login}>
                <div class="field">
                  <label class="field-label" for="login-email">Email</label>
                  <input id="login-email" type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} required />
                </div>
                <div class="field">
                  <label class="field-label" for="login-password">Master password</label>
                  <input id="login-password" type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} required />
                </div>
                <Show when={error()}>
                  <p class="form-error">{error()}</p>
                </Show>
                <div class="actions">
                  <button type="submit" disabled={loading()} class="btn btn-default">
                    {loading() ? loadingLabel() : "Unlock"}
                  </button>
                </div>
              </form>
            </Show>

            {/* ── Locked ── */}
            <Show when={!initializing() && isLocked()}>
              <form onSubmit={unlock}>
                <div class="field">
                  <label class="field-label" for="locked-email">Email</label>
                  <input id="locked-email" type="email" value={email()} disabled />
                </div>
                <div class="field">
                  <label class="field-label" for="locked-password">Master password</label>
                  <input id="locked-password" type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} required autofocus />
                </div>
                <p class="help">Session locked. Re-enter your master password to continue.</p>
                <Show when={error()}>
                  <p class="form-error">{error()}</p>
                </Show>
                <div class="actions">
                  <button type="button" onClick={logout} class="btn">Sign out</button>
                  <button type="submit" disabled={loading()} class="btn btn-default">
                    {loading() ? loadingLabel() : "Unlock"}
                  </button>
                </div>
              </form>
            </Show>

            {/* ── Pending locked changes ── */}
            <Show when={!initializing() && isLoggedIn() && !isLocked() && pendingChanges()}>
              {(_) => {
                const c = pendingChanges()!;
                const lines: string[] = [];
                if (c.added)    lines.push(`${plural(c.added, "bookmark")} added`);
                if (c.removed)  lines.push(`${plural(c.removed, "bookmark")} removed`);
                if (c.modified) lines.push(`${plural(c.modified, "bookmark")} modified`);
                return (
                  <div>
                    <p class="heading">Changes made while locked</p>
                    <ul class="bullets">
                      <For each={lines}>{(line) => <li>{line}</li>}</For>
                    </ul>
                    <p class="help">Keep your local changes, or discard them and restore the last synced state?</p>
                    <div class="actions">
                      <button onClick={() => resolveChanges(false)} disabled={resolving()} class="btn">
                        Discard changes
                      </button>
                      <button onClick={() => resolveChanges(true)} disabled={resolving()} class="btn btn-default">
                        {resolving() ? "Applying…" : "Keep my changes"}
                      </button>
                    </div>
                  </div>
                );
              }}
            </Show>

            {/* ── Import conflict ── */}
            <Show when={!initializing() && isLoggedIn() && !isLocked() && pendingImport()}>
              {(_) => {
                // Default to zero counts so inner Show conditions don't throw if
                // pendingImport() transitions to undefined during SolidJS teardown
                // before the outer Show has finished unmounting its children.
                const d = () => pendingImport() ?? { localOnly: 0, serverOnly: 0 };
                const localOnly = () => plural(d().localOnly, "browser-only bookmark");
                return (
                  <form onSubmit={(e) => { e.preventDefault(); resolveImport(); }}>
                    <p class="heading">Bookmark conflict</p>

                    <Show when={profiles().length > 1}>
                      <div class="prop">
                        <label class="prop-label" for="import-compare">Compare with</label>
                        <select
                          id="import-compare"
                          value={importComparedProfileId()}
                          disabled={importRecomputingDiff()}
                          onChange={(e) => recomputeImportDiff(e.currentTarget.value).catch(console.error)}
                        >
                          <For each={profiles()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
                        </select>
                      </div>
                    </Show>

                    <Show when={importRecomputingDiff()}>
                      <p class="help">Comparing…</p>
                    </Show>
                    <Show when={!importRecomputingDiff()}>
                      <ul class="bullets">
                        <Show when={d().localOnly > 0}><li>{plural(d().localOnly, "bookmark")} only in this browser</li></Show>
                        <Show when={d().serverOnly > 0}><li>{plural(d().serverOnly, "bookmark")} only in your account</li></Show>
                        <Show when={d().localOnly === 0 && d().serverOnly === 0}><li class="text-ok">Your bookmarks already match this profile</li></Show>
                      </ul>
                    </Show>

                    <Show when={d().localOnly > 0}>
                      <fieldset class="group">
                        <label class="option">
                          <input type="radio" name="import" checked={importAction() === "overwrite"} onChange={() => setImportAction("overwrite")} />
                          <div>
                            <div class="option-title">Use account's bookmarks</div>
                            <div class="option-desc">Discard the {localOnly()} and keep your synced account as-is.</div>
                          </div>
                        </label>
                        <label class="option">
                          <input type="radio" name="import" checked={importAction() === "merge"} onChange={() => setImportAction("merge")} />
                          <div>
                            <div class="option-title">Merge into {importComparedProfileName()}</div>
                            <div class="option-desc">Add the {localOnly()} into {importComparedProfileName()}.</div>
                          </div>
                        </label>
                        <Show when={importAction() === "merge"}>
                          <label class="option indent">
                            <input type="checkbox" checked={importExcludeDupes()} onChange={(e) => setImportExcludeDupes(e.currentTarget.checked)} />
                            <span>Skip bookmarks already in {importComparedProfileName()}</span>
                          </label>
                        </Show>
                        <label class="option">
                          <input type="radio" name="import" checked={importAction() === "new_profile"} onChange={() => setImportAction("new_profile")} />
                          <div>
                            <div class="option-title">Save as new profile</div>
                            <div class="option-desc">Keep the {localOnly()} in a separate profile alongside your account.</div>
                          </div>
                        </label>
                        <Show when={importAction() === "new_profile"}>
                          <div class="indent">
                            <input type="text" value={importProfileName()} onInput={(e) => setImportProfileName(e.currentTarget.value)} placeholder="Profile name" />
                          </div>
                        </Show>
                      </fieldset>
                    </Show>
                    <div class="actions">
                      <button type="submit" disabled={importResolving() || importRecomputingDiff()} class="btn btn-default">
                        {importResolving() ? "Applying…" : d().localOnly > 0 ? "Confirm" : "Continue"}
                      </button>
                    </div>
                  </form>
                );
              }}
            </Show>

            {/* ── Onboarding (new account) ── */}
            <Show when={!initializing() && isLoggedIn() && !isLocked() && onboarding()}>
              <form onSubmit={finishOnboarding}>
                <p class="heading">Welcome to {APP_NAME}</p>
                <p class="help">Set a few things up before you get started.</p>

                <div class="field">
                  <label class="field-label" for="onboarding-profile">Profile name</label>
                  <input
                    id="onboarding-profile"
                    type="text"
                    value={onboardingProfileName()}
                    onInput={(e) => setOnboardingProfileName(e.currentTarget.value)}
                    autofocus
                  />
                  <p class="help">
                    Your existing bookmarks will be added to this profile. Profiles let you keep separate bookmark sets, like Work and Personal.
                  </p>
                </div>

                <div class="section-head">Session lock</div>
                <fieldset class="group">
                  <label class="option">
                    <input
                      type="radio"
                      name="onboarding-timeout"
                      checked={onboardingTimeout() === "on_restart"}
                      onChange={() => changeOnboardingTimeout("on_restart")}
                    />
                    <div>
                      <div class="option-title">On browser restart</div>
                      <div class="option-desc">Requires your master password each time you open the browser.</div>
                    </div>
                  </label>
                  <label class="option">
                    <input
                      type="radio"
                      name="onboarding-timeout"
                      checked={onboardingTimeout() === "never"}
                      onChange={() => changeOnboardingTimeout("never")}
                    />
                    <div>
                      <div class="option-title">Never</div>
                      <div class="option-desc">Stay unlocked until you manually lock or sign out. This stores your encryption key on disk.</div>
                    </div>
                  </label>
                </fieldset>

                <Show when={hadExistingBookmarks()}>
                  <label class="option">
                    <input
                      type="checkbox"
                      checked={exportOnGetStarted()}
                      onChange={(e) => setExportOnGetStarted(e.currentTarget.checked)}
                    />
                    <span>Export bookmarks backup (.html) before getting started</span>
                  </label>
                </Show>

                <div class="actions">
                  <button type="submit" disabled={onboardingLoading()} class="btn btn-default">
                    {onboardingLoading() ? "Saving…" : "Get started"}
                  </button>
                </div>
              </form>
            </Show>

            {/* ── Logged in ── */}
            <Show when={isReady()}>
              <Show when={bootstrapNotice()}>
                <div class="notice">
                  <span>Your existing bookmarks were saved to your "{profile()?.name || "Default"}" profile.</span>
                  <button onClick={() => setBootstrapNotice(false)} class="btn-icon btn-icon--small" title="Dismiss">×</button>
                </div>
              </Show>

              <div class="section-head">Profiles</div>
              <div class="listbox">
                <For each={profiles()}>
                  {(p) => {
                    const isActive = () => p.id === profile()?.id;
                    const isSwitching = () => p.id === switchingProfileId();
                    return (
                      <button
                        class={`btn-profile${isActive() ? " btn-profile--active" : ""}`}
                        onClick={() => switchProfile(p.id)}
                        disabled={switchingProfileId() !== undefined}
                      >
                        <span class="col-mark">
                          <Show when={isSwitching()} fallback={<Show when={isActive()}><CheckIcon /></Show>}>
                            <span class="btn-icon--spinning"><LoaderIcon /></span>
                          </Show>
                        </span>
                        <span class="col-name">{p.name}</span>
                      </button>
                    );
                  }}
                </For>
                <div class="listbox-footer">
                  <Show when={profiles().length > 1}>
                    <span class="hint">Alt+Shift+J / K to switch profiles</span>
                  </Show>
                  <button
                    class="btn btn-small"
                    onClick={() => { setAddingProfile(!addingProfile()); setProfileError(undefined); }}
                  >
                    {addingProfile() ? "Cancel" : "+ Add"}
                  </button>
                </div>
              </div>

              <Show when={addingProfile()}>
                <form onSubmit={createProfile} class="inline-form">
                  <input type="text" placeholder="Profile name" value={newProfileName()} onInput={(e) => setNewProfileName(e.currentTarget.value)} required ref={(el) => setTimeout(() => el.focus(), 0)} />
                  <button type="submit" disabled={loading()} class="btn btn-default">
                    {loading() ? "…" : "Add"}
                  </button>
                </form>
                <Show when={profileError()}>
                  <p class="form-error">{profileError()}</p>
                </Show>
              </Show>
            </Show>
          </Match>

          {/* ══ Settings ══ */}
          <Match when={view() === "settings"}>
            <div class="section">
              <div class="section-head">Account</div>
              <div class="prop">
                <span class="prop-label">Email</span>
                <span class="prop-value" title={email()}>{email()}</span>
              </div>
              <div class="stack">
                <div class="row">
                  <button class="btn" onClick={lock}>Lock</button>
                  <button class="btn" onClick={logout}>Sign out</button>
                </div>
                <button class="btn btn-danger" onClick={logoutAndClear}>Sign out &amp; clear bookmarks</button>
              </div>
            </div>

            <div class="section">
              <div class="section-head">Appearance</div>
              <div class="prop">
                <label class="prop-label" for="theme">Theme</label>
                <select id="theme" value={theme()} onChange={(e) => changeTheme(e.currentTarget.value as Theme)}>
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </div>
            </div>

            <div class="section">
              <div class="section-head">More</div>
              <div class="stack">
                <button
                  class="btn btn-block"
                  onClick={() => { setDeletingProfileId(undefined); setDeleteError(undefined); setView("manage-profiles"); }}
                >
                  Manage profiles…
                </button>
                <button class="btn btn-block" onClick={() => setView("account-security")}>
                  Account security…
                </button>
              </div>
            </div>
          </Match>

          {/* ══ Manage profiles ══ */}
          <Match when={view() === "manage-profiles"}>
            <div class="listbox">
              <For each={profiles()}>
                {(p) => {
                  const isActive = () => p.id === profile()?.id;
                  const isConfirming = () => deletingProfileId() === p.id;
                  const isEditing = () => editingProfileId() === p.id;
                  return (
                    <div class="list-row">
                      <Show when={!isEditing()} fallback={
                        <form onSubmit={submitRename}>
                          <div class="inline-form">
                            <input
                              type="text"
                              value={editingProfileName()}
                              onInput={(e) => setEditingProfileName(e.currentTarget.value)}
                              required
                              autofocus
                            />
                            <button type="submit" disabled={editingLoading()} class="btn btn-small btn-default">
                              {editingLoading() ? "…" : "Save"}
                            </button>
                            <button type="button" title="Cancel rename" onClick={() => { setEditingProfileId(undefined); setEditingError(undefined); }} class="btn btn-small">
                              ✕
                            </button>
                          </div>
                          <Show when={editingError()}>
                            <p class="form-error">{editingError()}</p>
                          </Show>
                        </form>
                      }>
                        <div class="list-row-main">
                          <span class="col-name">{p.name}</span>
                          <Show when={isActive()}><span class="tag">active</span></Show>
                          <div class="row-tools">
                            <Show when={!isConfirming()}>
                              <button
                                title="Rename"
                                class="btn-icon btn-action-icon"
                                onClick={() => { setEditingProfileId(p.id); setEditingProfileName(p.name); setEditingError(undefined); setDeletingProfileId(undefined); setExportError(undefined); }}
                              >
                                <PencilIcon />
                              </button>
                              <button
                                title="Export bookmarks"
                                class="btn-icon btn-action-icon"
                                disabled={exportingProfileId() === p.id}
                                onClick={() => exportProfile(p.id, p.name)}
                              >
                                <DownloadIcon />
                              </button>
                            </Show>
                            <button
                              title={isActive() ? "Switch to another profile before deleting" : isConfirming() ? "Cancel delete" : "Delete profile"}
                              class={`btn-icon btn-action-icon btn-action-icon--danger${isConfirming() ? " btn-action-icon--confirming" : ""}`}
                              disabled={isActive()}
                              onClick={() => { setDeleteError(undefined); setEditingProfileId(undefined); setExportError(undefined); setDeletingProfileId(isConfirming() ? undefined : p.id); }}
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        </div>
                        <Show when={exportError()?.id === p.id}>
                          <p class="form-error">{exportError()?.msg}</p>
                        </Show>
                        <Show when={isConfirming()}>
                          <div class="confirm-box">
                            <p class="text-danger">All bookmarks in this profile will be permanently deleted.</p>
                            <div class="actions">
                              <button onClick={() => { setDeletingProfileId(undefined); setDeleteError(undefined); }} class="btn btn-small">
                                Cancel
                              </button>
                              <button onClick={() => confirmDeleteProfile(p.id)} class="btn btn-small btn-destructive">
                                Confirm Delete
                              </button>
                            </div>
                            <Show when={deleteError()?.id === p.id}>
                              <p class="form-error">{deleteError()?.msg}</p>
                            </Show>
                          </div>
                        </Show>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Match>

          {/* ══ Account security ══ */}
          <Match when={view() === "account-security"}>
            <div class="section">
              <div class="section-head">Session timeout</div>
              <fieldset class="group">
                <label class="option">
                  <input
                    type="radio"
                    name="timeout"
                    checked={sessionTimeout() === "on_restart"}
                    onChange={() => changeSessionTimeout("on_restart")}
                  />
                  <div>
                    <div class="option-title">On browser restart</div>
                    <div class="option-desc">Requires your master password each time you open the browser.</div>
                  </div>
                </label>
                <label class="option">
                  <input
                    type="radio"
                    name="timeout"
                    checked={sessionTimeout() === "never"}
                    onChange={() => changeSessionTimeout("never")}
                  />
                  <div>
                    <div class="option-title">Never</div>
                    <div class="option-desc">Stay unlocked until you manually lock or sign out. This stores your encryption key on disk.</div>
                  </div>
                </label>
              </fieldset>
            </div>

            <div class="section">
              <div class="section-head">Change master password</div>
              <form onSubmit={changePassword} class="stack">
                <input
                  type="password"
                  placeholder="Current password"
                  value={currentPassword()}
                  onInput={(e) => setCurrentPassword(e.currentTarget.value)}
                  autocomplete="current-password"
                />
                <input
                  type="password"
                  placeholder="New password"
                  value={newPassword()}
                  onInput={(e) => setNewPassword(e.currentTarget.value)}
                  autocomplete="new-password"
                />
                <input
                  type="password"
                  placeholder="Confirm new password"
                  value={confirmPassword()}
                  onInput={(e) => setConfirmPassword(e.currentTarget.value)}
                  autocomplete="new-password"
                />
                <Show when={changePwError()}>
                  <p class="form-error">{changePwError()}</p>
                </Show>
                <Show when={changePwSuccess()}>
                  <p class="text-ok">Password changed successfully.</p>
                </Show>
                <div class="actions">
                  <button type="submit" disabled={changePwLoading()} class="btn btn-default">
                    {changePwLoading() ? "Changing…" : "Change password"}
                  </button>
                </div>
              </form>
            </div>

            <div class="section">
              <div class="section-head">Danger zone</div>
              <Show when={!deleteAccountConfirm()}>
                <button
                  onClick={() => { setDeleteAccountConfirm(true); setDeleteAccountError(undefined); }}
                  class="btn btn-block btn-danger"
                >
                  Delete account and all data…
                </button>
              </Show>
              <Show when={deleteAccountConfirm()}>
                <div class="confirm-box">
                  <p class="heading text-danger">Delete account?</p>
                  <p class="help">
                    This permanently deletes your account, all profiles, and all synced bookmarks from the server. Your local browser bookmarks are not affected.
                  </p>
                  <input
                    type="password"
                    placeholder="Enter your password to confirm"
                    value={deleteAccountPassword()}
                    onInput={(e) => setDeleteAccountPassword(e.currentTarget.value)}
                    disabled={deleteAccountLoading()}
                  />
                  <Show when={deleteAccountError()}>
                    <p class="form-error">{deleteAccountError()}</p>
                  </Show>
                  <div class="actions">
                    <button
                      onClick={() => { setDeleteAccountConfirm(false); setDeleteAccountPassword(""); }}
                      disabled={deleteAccountLoading()}
                      class="btn"
                    >
                      Cancel
                    </button>
                    <button onClick={deleteAccount} disabled={deleteAccountLoading()} class="btn btn-destructive">
                      {deleteAccountLoading() ? "Deleting…" : "Permanently delete"}
                    </button>
                  </div>
                </div>
              </Show>
            </div>
          </Match>
        </Switch>
      </div>

      {/* ── Status bar ── */}
      <div class="statusbar">
        <Show when={status().text}>
          <span class={`led led--${status().led}`} />
          <span>{status().text}</span>
        </Show>
      </div>
    </div>
  );
}

render(() => <App />, document.getElementById("root")!);
