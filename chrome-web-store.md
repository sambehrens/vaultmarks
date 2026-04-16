# Chrome Web Store Listing

## Short description (132 char max)

Zero-knowledge, end-to-end encrypted bookmark sync. Multiple profiles, offline-ready, and conflict-free across all your browsers.

## Full description

Vaultmarks keeps your bookmarks in sync across every browser and device — privately, with no one able to read them but you.

**How it works**
Your bookmarks are encrypted on your device before they ever leave it. Vaultmarks uses end-to-end AES-GCM encryption with a key derived from your master password. The server stores only ciphertext — not your password, not your encryption key, not your bookmarks.

**Features**
- **Zero-knowledge encryption** — your data is unreadable to anyone without your password, including us
- **Conflict-free sync** — built on a CRDT (conflict-free replicated data type), so edits from multiple devices always merge correctly without data loss
- **Multiple profiles** — organize bookmarks into separate profiles and switch between them instantly
- **Offline ready** — changes made while offline are queued and synced automatically when you reconnect
- **Keyboard shortcuts** — switch profiles without opening the popup (Alt+Shift+J / Alt+Shift+K, remappable in chrome://extensions/shortcuts)
- **Real-time updates** — changes on one device appear on others within seconds

**Privacy**
Vaultmarks cannot read, sell, or share your bookmarks. There are no analytics, no tracking, and no ads.

**Free and open source**
Vaultmarks is completely free to use. The source code is publicly available on GitHub.

---

## Permission justifications

**bookmarks**
Required to read, create, update, and delete the user's bookmarks. The extension syncs the bookmark tree across devices by reconciling the local Chrome bookmark state against an encrypted CRDT document stored on the server.

**storage**
Used to persist session state (authentication token, active profile ID, session timeout preference) in chrome.storage.local, and to temporarily store pending import conflict state in chrome.storage.session during the login conflict-resolution flow.

**alarms**
Used to schedule a 60-second fallback sync poll in case the real-time server-sent event stream drops, and to schedule reconnection attempts when the stream needs to be re-established.

**Host permission (https://api.vaultmarks.com/*)**
Required to communicate with the Vaultmarks sync server. All requests to this host carry end-to-end encrypted payloads — the server never receives plaintext bookmark data. The extension uses this host to authenticate users, push encrypted bookmark deltas, pull remote changes, and manage profiles.

**Remote code**
Select **No** — all JavaScript and WebAssembly is bundled into the extension package at build time. No code is fetched or evaluated from external sources at runtime.

---

## Test instructions

**Credentials**
- Username: chrome-web-store-team@test.test
- Password: (as entered in the credentials fields)

**Additional instructions**
The extension requires a master password to derive the encryption key — this is separate from the account password and is the same value. Use the password provided above for both the login and the master password prompt.

After signing in, the extension will sync bookmarks automatically. To test profile switching, click the active profile name in the popup to see the profile list. A second profile ("Work") has been pre-created on this test account.

Keyboard shortcuts: Alt+Shift+J / Alt+Shift+K switch between profiles without opening the popup (remappable at chrome://extensions/shortcuts).
