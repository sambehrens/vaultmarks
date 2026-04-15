// IndexedDB abstraction — three object stores:
//   "meta"       — key/value pairs (lastSeqId-{profileId}, …)
//   "deltaQueue" — encrypted deltas awaiting upload
//   "loro"       — Loro document snapshots, keyed as "snapshot-{profileId}"

const DB_NAME = "aegis-sync";
const DB_VERSION = 1;

export interface QueuedDelta {
  id: string;          // random UUID, used as IDB key
  profileId: string;
  encryptedDelta: string; // base64
  timestamp: number;
}

let _db: IDBDatabase | null = null;

function open(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta"); // keyPath implicitly via key param
      }
      if (!db.objectStoreNames.contains("deltaQueue")) {
        const store = db.createObjectStore("deltaQueue", { keyPath: "id" });
        store.createIndex("by_timestamp", "timestamp");
      }
      if (!db.objectStoreNames.contains("loro")) {
        db.createObjectStore("loro");
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db!); };
    req.onerror = () => reject(req.error);
  });
}

function tx(
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<unknown>,
): Promise<void> {
  return open().then((db) => {
    return new Promise<void>((resolve, reject) => {
      const t = db.transaction(stores, mode);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      fn(t).catch(reject);
    });
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// ── Meta ──────────────────────────────────────────────────────────────────────

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await open();
  const t = db.transaction("meta", "readonly");
  return req<T>(t.objectStore("meta").get(key));
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await tx("meta", "readwrite", (t) =>
    req(t.objectStore("meta").put(value, key)),
  );
}

// ── Loro snapshot (per-profile) ───────────────────────────────────────────────

/** Load the Loro snapshot for a specific profile. */
export async function loadSnapshot(profileId: string): Promise<Uint8Array | undefined> {
  const db = await open();
  const t = db.transaction("loro", "readonly");
  return req<Uint8Array | undefined>(t.objectStore("loro").get(`snapshot-${profileId}`));
}

/** Persist the Loro snapshot for a specific profile. */
export async function saveSnapshot(profileId: string, data: Uint8Array): Promise<void> {
  await tx("loro", "readwrite", (t) =>
    req(t.objectStore("loro").put(data, `snapshot-${profileId}`)),
  );
}

// ── Delta queue ───────────────────────────────────────────────────────────────

export async function enqueue(delta: QueuedDelta): Promise<void> {
  await tx("deltaQueue", "readwrite", (t) =>
    req(t.objectStore("deltaQueue").put(delta)),
  );
}

export async function peekQueue(limit = 50): Promise<QueuedDelta[]> {
  const db = await open();
  const t = db.transaction("deltaQueue", "readonly");
  const index = t.objectStore("deltaQueue").index("by_timestamp");
  return req<QueuedDelta[]>(index.getAll(undefined, limit));
}

export async function dequeue(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx("deltaQueue", "readwrite", (t) => {
    const store = t.objectStore("deltaQueue");
    return Promise.all(ids.map((id) => req(store.delete(id))));
  });
}

export async function queueSize(): Promise<number> {
  const db = await open();
  const t = db.transaction("deltaQueue", "readonly");
  return req<number>(t.objectStore("deltaQueue").count());
}

/** Remove all queued deltas (called on logout to prevent stale deltas from a
 *  previous account leaking into a new session). */
export async function clearDeltaQueue(): Promise<void> {
  await tx("deltaQueue", "readwrite", (t) =>
    req(t.objectStore("deltaQueue").clear()),
  );
}

/** Wipe all IndexedDB data (called on account deletion). */
export async function clearAllLocalData(): Promise<void> {
  await tx(["meta", "deltaQueue", "loro"], "readwrite", async (t) => {
    await req(t.objectStore("meta").clear());
    await req(t.objectStore("deltaQueue").clear());
    await req(t.objectStore("loro").clear());
  });
}

/** Remove local data for a deleted profile (snapshot, ID mapping, lastSeqId). */
export async function deleteProfileData(profileId: string): Promise<void> {
  await tx("loro", "readwrite", (t) =>
    req(t.objectStore("loro").delete(`snapshot-${profileId}`)),
  );
  await tx("meta", "readwrite", async (t) => {
    const store = t.objectStore("meta");
    await req(store.delete(`chromeIdMap-${profileId}`));
    await req(store.delete(`lastSeqId-${profileId}`));
    await req(store.delete(`lastSnapshotUpload-${profileId}`));
  });
}
