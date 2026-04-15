// Message protocol between the popup and the background service worker.
// All messages are sent via chrome.runtime.sendMessage.

export interface ProfileInfo {
  id: string;
  name: string;
}

export interface PendingChanges {
  added: number;
  removed: number;
  modified: number;
}

export interface ImportDiff {
  /** Chrome bookmarks with URLs not present on the server. */
  localOnly: number;
  /** Server bookmarks with URLs not present in Chrome. */
  serverOnly: number;
}

export type SessionTimeout = "on_restart" | "never";

export type ExtMessage =
  | {
      type: "LOGIN";
      email: string;
      authKey: string;
      /** Raw bytes of the HKDF-derived wrapping key. Background uses this to
       *  decrypt the Protected Symmetric Key returned by the login/register API. */
      wrappingKeyBytes: number[];
    }
  | {
      type: "UNLOCK";
      /** Raw bytes of the symmetric encryption key, already decrypted from the
       *  PSK by the popup using the wrapping key. Same semantics as before. */
      encryptionKeyBytes: number[];
    }
  | {
      type: "CHANGE_PASSWORD";
      oldAuthKey: string;
      newAuthKey: string;
      /** New PSK: same symmetric key re-encrypted with the new wrapping key. */
      newProtectedSymmetricKey: string;
    }
  | { type: "RESOLVE_LOCKED_CHANGES"; apply: boolean }
  | {
      type: "RESOLVE_IMPORT";
      choice: "overwrite" | "merge" | "new_profile";
      excludeDuplicates?: boolean;
      profileName?: string;
      /** For "merge": which existing profile to merge the local bookmarks into. */
      targetProfileId?: string;
    }
  | { type: "LOCK" }
  | { type: "LOGOUT"; clearBookmarks?: boolean }
  | { type: "GET_STATUS" }
  | { type: "SWITCH_PROFILE"; profileId: string }
  | { type: "CREATE_PROFILE"; name: string }
  | { type: "DELETE_PROFILE"; profileId: string }
  | { type: "RENAME_PROFILE"; profileId: string; name: string }
  | { type: "SET_SESSION_TIMEOUT"; value: SessionTimeout }
  | { type: "SYNC" }
  | { type: "RECOMPUTE_IMPORT_DIFF"; profileId: string }
  | { type: "EXPORT_PROFILE"; profileId: string }
  | { type: "DELETE_ACCOUNT" };

export type ExtResponse =
  | {
      type: "LOGIN_SUCCESS";
      profiles: ProfileInfo[];
      pendingImport?: ImportDiff;
      bootstrapped?: boolean;
      isNewAccount?: boolean;
    }
  | { type: "LOGIN_ERROR"; error: string }
  | {
      type: "UNLOCK_SUCCESS";
      profile?: ProfileInfo;
      profiles: ProfileInfo[];
      pendingChanges?: PendingChanges;
    }
  | { type: "UNLOCK_ERROR"; error: string }
  | { type: "LOCK_SUCCESS" }
  | { type: "RESOLVE_SUCCESS" }
  | { type: "RESOLVE_ERROR"; error: string }
  | { type: "RESOLVE_IMPORT_SUCCESS"; newProfile?: ProfileInfo; activeProfile?: ProfileInfo }
  | { type: "RESOLVE_IMPORT_ERROR"; error: string }
  | { type: "LOGOUT_SUCCESS" }
  | {
      type: "STATUS";
      isLoggedIn: boolean;
      isLocked: boolean;
      email?: string;
      profile?: ProfileInfo;
      profiles: ProfileInfo[];
      lastSynced?: number;
      pendingChanges?: PendingChanges;
      pendingImport?: ImportDiff;
      sessionTimeout: SessionTimeout;
    }
  | { type: "SYNC_SUCCESS"; lastSynced: number; profiles?: ProfileInfo[] }
  | { type: "SYNC_ERROR"; error: string }
  | { type: "SWITCH_SUCCESS" }
  | { type: "SWITCH_ERROR"; error: string }
  | { type: "CREATE_PROFILE_SUCCESS"; profile: ProfileInfo }
  | { type: "CREATE_PROFILE_ERROR"; error: string }
  | { type: "DELETE_PROFILE_SUCCESS" }
  | { type: "DELETE_PROFILE_ERROR"; error: string }
  | { type: "RENAME_PROFILE_SUCCESS"; name: string }
  | { type: "RENAME_PROFILE_ERROR"; error: string }
  | { type: "SET_SESSION_TIMEOUT_SUCCESS" }
  | { type: "RECOMPUTE_IMPORT_DIFF_SUCCESS"; diff: ImportDiff }
  | { type: "RECOMPUTE_IMPORT_DIFF_ERROR"; error: string }
  | { type: "CHANGE_PASSWORD_SUCCESS" }
  | { type: "CHANGE_PASSWORD_ERROR"; error: string }
  | { type: "EXPORT_PROFILE_SUCCESS"; bookmarks: Record<string, { title: string; url?: string; parentId: string; index: number; type: "bookmark" | "folder" }> }
  | { type: "EXPORT_PROFILE_ERROR"; error: string }
  | { type: "DELETE_ACCOUNT_SUCCESS" }
  | { type: "DELETE_ACCOUNT_ERROR"; error: string };
