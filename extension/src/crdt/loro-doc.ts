// Loro WASM wrapper.
// Uses a static import so Vite does not wrap it with __vitePreload(), which
// accesses `document` and throws inside the background service worker.

import { LoroDoc, VersionVector } from "loro-wasm";

export interface BookmarkNode {
  title: string;
  url?: string;
  parentId: string;
  index: number;
  type: "bookmark" | "folder";
}

let _doc: LoroDoc | null = null;

/** Initialise (or re-hydrate) the Loro document. Call once on startup. */
export async function initDoc(snapshot?: Uint8Array): Promise<void> {
  _doc = new LoroDoc();
  if (snapshot) {
    _doc.import(snapshot);
  }
}

function doc(): LoroDoc {
  if (!_doc) throw new Error("Loro doc not initialized — call initDoc() first");
  return _doc;
}

/** Export the full document state as a compact snapshot. */
export function exportSnapshot(): Uint8Array {
  return doc().exportSnapshot();
}

/** Export a snapshot of a fresh empty document (no ops). */
export function exportEmptySnapshot(): Uint8Array {
  return new LoroDoc().exportSnapshot();
}

/**
 * Export all ops produced after `sinceVersion`.
 * Pass `undefined` to export everything (for initial enrollment of a new device).
 */
export function exportFrom(sinceVersion?: Uint8Array): Uint8Array {
  if (!sinceVersion) return doc().exportSnapshot();
  return doc().exportFrom(VersionVector.decode(sinceVersion));
}

/** Apply a remote update (snapshot or delta ops). */
export function importUpdate(data: Uint8Array): void {
  doc().import(data);
}

/**
 * Read all bookmarks from an arbitrary snapshot without touching the live doc.
 * Used to export non-active profiles.
 */
export function getBookmarksFromSnapshot(snapshot: Uint8Array): Record<string, BookmarkNode> {
  const tempDoc = new LoroDoc();
  tempDoc.import(snapshot);
  return tempDoc.getMap("bookmarks").toJSON() as Record<string, BookmarkNode>;
}

/** Opaque version vector — used as a cursor for delta exports. */
export function currentVersion(): Uint8Array {
  return doc().version().encode();
}

/** Register a callback invoked whenever the doc changes. */
export function subscribe(callback: () => void): () => void {
  const id = doc().subscribe(callback);
  return () => doc().unsubscribe(id);
}

// ── Bookmark accessors ────────────────────────────────────────────────────────

export function setBookmark(id: string, node: BookmarkNode): void {
  const map = doc().getMap("bookmarks");
  map.set(id, node);
  doc().commit();
}

export function deleteBookmark(id: string): void {
  const map = doc().getMap("bookmarks");
  map.delete(id);
  doc().commit();
}

export function getAllBookmarks(): Record<string, BookmarkNode> {
  const map = doc().getMap("bookmarks");
  return map.toJSON() as Record<string, BookmarkNode>;
}
