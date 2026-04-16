export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:3000";

// ── App identity ──────────────────────────────────────────────────────────────
// To rename the extension, change APP_ID and APP_NAME here.

const APP_ID = "vaultmarks" as const;

/** Human-readable display name used in the UI. */
export const APP_NAME = "Vaultmarks";

/** IndexedDB database name. */
export const DB_NAME = APP_ID;

/** Console log tag. */
export const LOG_TAG = `[${APP_ID}]`;

/** Pending-import session storage key (background ↔ popup). */
export const PENDING_IMPORT_KEY = `${APP_ID}_pendingImport`;

/** chrome.storage.local key names. */
export const STORAGE_KEYS = {
  jwt:                   `${APP_ID}_jwt`,
  email:                 `${APP_ID}_email`,
  profiles:              `${APP_ID}_profiles`,
  activeProfileId:       `${APP_ID}_activeProfileId`,
  protectedSymmetricKey: `${APP_ID}_protectedSymmetricKey`,
  sessionTimeout:        `${APP_ID}_sessionTimeout`,
  encryptionKeyRaw:      `${APP_ID}_encryptionKeyRaw`,
} as const;
