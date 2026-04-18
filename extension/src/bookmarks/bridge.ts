// Bidirectional mapper between chrome.bookmarks API and the Loro document.
//
// KEY DESIGN: the Loro document uses stable UUIDs as bookmark keys — not Chrome
// bookmark IDs. Chrome IDs are device-local and meaningless on other devices.
// A local mapping (loroId ↔ chromeId) is persisted in IndexedDB per-profile
// so that reconcile can translate between the two ID spaces without creating
// duplicates on every sync.
//
// Outgoing (local changes → Loro → encrypted delta queue):
//   chrome.bookmarks events → translate chromeId → loroId → update Loro → enqueue delta
//
// Incoming (remote deltas → Loro → chrome.bookmarks):
//   importUpdate() → reconcile() → translate loroId → chromeId → mutate Chrome

import { isIgnoring, withEchoFilter } from "./echo-filter";
import { LOG_TAG } from "../config";
import {
  setBookmark,
  deleteBookmark,
  getAllBookmarks,
  exportFrom,
  importUpdate,
  currentVersion,
  type BookmarkNode,
} from "../crdt/loro-doc";
import { enqueueDelta } from "../sync/delta-queue";
import { isPushPaused, pushPending } from "../sync/client";
import { getMeta, setMeta } from "../storage/db";
import { getActiveProfileId } from "../auth/session";

// ── Root ID translation ───────────────────────────────────────────────────────
//
// The Loro doc always uses canonical root IDs ("0"–"3"). Chrome happens to use
// these same values as its literal bookmark IDs, so no translation is needed
// there. Firefox uses fixed string IDs ("root________", "toolbar_____", etc.)
// that must be mapped to/from canonical before touching the Loro doc or the
// Chrome bookmarks API.
//
// _nativeToCanonical  — browser-specific root ID → canonical ("1" / "2" / "3")
// _canonicalToNative  — canonical → primary browser-specific root ID to write to
// _allNativeRootIds   — union of canonical and all browser-specific root IDs;
//                       used in BFS walks to skip root containers

// Canonical root IDs used throughout the Loro doc (browser-independent).
const CANONICAL_ROOT_IDS = new Set(["0", "1", "2", "3"]);

// Firefox uses these fixed IDs for its built-in root bookmark folders.
// "menu________" (Bookmarks Menu) is intentionally excluded: it's Firefox-specific
// (Chrome has no equivalent) and contains Firefox's default bookmarks (e.g. the
// "Mozilla Firefox" folder). Treating it like a browser-specific folder — the same
// way we treat Vivaldi's Trash — prevents its contents from syncing to other
// browsers where they'd appear incorrectly and then return as duplicate folders on
// the next Firefox sync.
const FIREFOX_ROOT_CANONICAL: Record<string, string> = {
  "root________": "0",
  "toolbar_____": "1",
  "unfiled_____": "2", // Unfiled / Other Bookmarks
  "mobile______": "3",
};

// Defaults work for Chrome / Chromium-based browsers (identity mapping).
// Overwritten by initBrowserRoots() for Firefox.
let _nativeToCanonical = new Map<string, string>([
  ["0", "0"], ["1", "1"], ["2", "2"], ["3", "3"],
]);
let _canonicalToNative = new Map<string, string>([
  ["0", "0"], ["1", "1"], ["2", "2"], ["3", "3"],
]);
let _allNativeRootIds = new Set<string>(["0", "1", "2", "3"]);

/**
 * Detect the current browser's bookmark root IDs and populate the translation
 * tables. Must be called once before any bookmark operation.
 *
 * Chrome uses numeric string IDs ("0"–"3") that already match the canonical
 * IDs, so no translation is needed. Firefox uses fixed string IDs that must be
 * mapped to canonical when writing to Loro and back to native when calling the
 * Chrome bookmarks API.
 */
export async function initBrowserRoots(): Promise<void> {
  const [root] = await chrome.bookmarks.getTree();
  if (root.id === "0") return; // Chrome — defaults already correct.

  // Firefox (or unknown browser with non-numeric virtual-root ID).
  const virtualId = root.id;

  _nativeToCanonical = new Map([["0", "0"]]); // keep canonical self-mapping
  _canonicalToNative = new Map();
  // Always include the canonical IDs so Loro-side checks still work.
  _allNativeRootIds = new Set(["0", "1", "2", "3", virtualId]);

  _nativeToCanonical.set(virtualId, "0");
  _canonicalToNative.set("0", virtualId);

  for (const child of root.children ?? []) {
    const canonical = FIREFOX_ROOT_CANONICAL[child.id];
    if (canonical === undefined) continue; // unknown root — skip (browser-specific)
    _nativeToCanonical.set(child.id, canonical);
    _allNativeRootIds.add(child.id);
    // Prefer "unfiled_____" over "menu________" as the write-target for canonical "2".
    if (!_canonicalToNative.has(canonical) || child.id === "unfiled_____") {
      _canonicalToNative.set(canonical, child.id);
    }
  }

  // Ensure every canonical root has a native write-target.
  for (const canonical of ["1", "2", "3"]) {
    if (!_canonicalToNative.has(canonical)) {
      _canonicalToNative.set(canonical, canonical);
    }
  }
}

/** Returns true if `id` is any kind of root container (canonical or native). */
function isAnyRootId(id: string): boolean {
  return _allNativeRootIds.has(id);
}

/** Returns true if `id` is the virtual root — can never be a bookmark parent. */
function isVirtualRootId(id: string): boolean {
  const virtualNative = _canonicalToNative.get("0") ?? "0";
  return id === "0" || id === virtualNative;
}

/**
 * Returns true if `id` is a valid parent ID for chrome.bookmarks.create().
 * Valid parents are non-virtual root containers and positive-integer Chrome IDs.
 * The virtual root ("0" / "root________") and Loro UUID strings are invalid.
 */
function isValidChromeParentId(id: string): boolean {
  if (isVirtualRootId(id)) return false;          // virtual root — never a parent
  if (_allNativeRootIds.has(id)) return true;     // e.g. "toolbar_____", "1"
  return /^[1-9]\d*$/.test(id);                  // Chrome non-root numeric IDs
}

// ── Local ID mapping ──────────────────────────────────────────────────────────
//
// These maps are in-memory mirrors of the IndexedDB-persisted mapping.
// They are populated by loadMapping() on profile init and updated on every
// create/delete operation.

let _loroToChrome = new Map<string, string>(); // loroId (UUID) → chromeId
let _chromeToLoro = new Map<string, string>(); // chromeId → loroId (UUID)

/** True when the ID mapping has been loaded and is non-empty (established profile). */
export function hasEstablishedMapping(): boolean {
  return _loroToChrome.size > 0;
}

/** Load the chromeId mapping for a profile from IndexedDB into memory. */
export async function loadMapping(profileId: string): Promise<void> {
  const stored = await getMeta<Record<string, string>>(`chromeIdMap-${profileId}`);
  const entries = Object.entries(stored ?? {});
  _loroToChrome = new Map(entries);
  _chromeToLoro = new Map(entries.map(([loro, chrome]) => [chrome, loro]));
}

async function saveMapping(): Promise<void> {
  await setMeta(`chromeIdMap-${getActiveProfileId()}`, Object.fromEntries(_loroToChrome));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNode(
  item: chrome.bookmarks.BookmarkTreeNode,
  parentLoroId: string,
): BookmarkNode {
  return {
    title: item.title,
    url: item.url,
    parentId: parentLoroId,
    index: item.index ?? 0,
    type: item.url ? "bookmark" : "folder",
  };
}

/**
 * Translate a native browser parentId to a canonical Loro parentId.
 * Root IDs (e.g. Firefox "toolbar_____") are translated to canonical ("1").
 * Non-root IDs are looked up in the chromeId mapping.
 */
function chromeParentToLoro(chromeParentId: string): string {
  const canonical = _nativeToCanonical.get(chromeParentId);
  if (canonical !== undefined) return canonical;
  return _chromeToLoro.get(chromeParentId) ?? chromeParentId;
}

/**
 * Translate a canonical Loro parentId to the native browser parentId.
 * Canonical root IDs (e.g. "1") are translated to the browser's equivalent
 * (Chrome: "1", Firefox: "toolbar_____"). Non-root IDs are looked up in the
 * loroId mapping.
 */
function loroParentToChrome(loroParentId: string): string {
  const native = _canonicalToNative.get(loroParentId);
  if (native !== undefined) return native;
  return _loroToChrome.get(loroParentId) ?? loroParentId;
}

// ── Version cursor ────────────────────────────────────────────────────────────

let _lastVersion: Uint8Array | undefined;

async function onLocalChange(): Promise<void> {
  const delta = exportFrom(_lastVersion);
  _lastVersion = currentVersion();
  await enqueueDelta(delta);
  if (!isPushPaused()) {
    pushPending().catch(console.error);
  }
}

// ── Listener management ───────────────────────────────────────────────────────

let _cleanupListeners: Array<() => void> = [];

export function detachBookmarkListeners(): void {
  _cleanupListeners.forEach((fn) => fn());
  _cleanupListeners = [];
  _lastVersion = undefined;
}

/**
 * Walk up from `chromeParentId` to the nearest already-mapped ancestor,
 * mapping each intermediate folder into the Loro doc along the way.
 * Returns the canonical loroId to use as the parent for the calling node.
 *
 * This handles bookmarks created inside folders that weren't present during
 * bootstrap (e.g. a user-created Opera folder, or a browser-specific folder).
 * Folders directly under the virtual root ("0" / "root________") are skipped —
 * they can't be replicated on other browsers — and their children are re-homed
 * to "2" (Other Bookmarks, canonical).
 */
async function ensureAncestorsMapped(chromeParentId: string): Promise<string> {
  // Root containers return their canonical ID immediately.
  if (isAnyRootId(chromeParentId)) {
    return _nativeToCanonical.get(chromeParentId) ?? chromeParentId;
  }
  const existing = _chromeToLoro.get(chromeParentId);
  if (existing) return existing;

  // Fetch the folder from Chrome so we can inspect its own parent.
  let folder: chrome.bookmarks.BookmarkTreeNode;
  try {
    [folder] = await chrome.bookmarks.get(chromeParentId);
  } catch {
    return "2"; // can't retrieve folder — fall back to Other Bookmarks (canonical)
  }

  // Browser-specific root-level folder (e.g. Vivaldi's Trash, unknown Firefox
  // root) — its parentId is the virtual root. Re-home its children to Other
  // Bookmarks so they still sync to other devices.
  if (folder.parentId !== undefined && isVirtualRootId(folder.parentId)) return "2";

  // Recursively ensure the folder's own parent is mapped first.
  const parentLoroId = await ensureAncestorsMapped(folder.parentId ?? "1");

  // Now map this folder.
  const loroId = crypto.randomUUID();
  _loroToChrome.set(loroId, folder.id);
  _chromeToLoro.set(folder.id, loroId);
  setBookmark(loroId, toNode(folder, parentLoroId));
  return loroId;
}

export function attachBookmarkListeners(): void {
  detachBookmarkListeners();

  const onCreate = (_id: string, node: chrome.bookmarks.BookmarkTreeNode) => {
    if (isIgnoring()) return;
    if (_chromeToLoro.has(node.id)) return; // already mapped (shouldn't happen)
    (async () => {
      // Fetch the bookmark's live position before setting up the mapping.
      //
      // Some browsers (e.g. Opera) fire onCreated while the bookmark is in a
      // temporary location (Other Bookmarks / parentId="2") and immediately
      // follow it with onMoved to place it in the user's chosen folder. By
      // fetching the live node first, we delay establishing the mapping until
      // after onMove has already fired (which skips unmapped bookmarks). We
      // then record the final, correct parent directly — avoiding a spurious
      // delta with the wrong parent that would cause a reconcile to flash the
      // bookmark through Other Bookmarks before correcting it.
      let live: chrome.bookmarks.BookmarkTreeNode;
      try {
        [live] = await chrome.bookmarks.get(node.id);
      } catch {
        return; // bookmark deleted immediately after creation
      }

      // Bail out if another handler mapped this bookmark while we were fetching.
      if (_chromeToLoro.has(node.id)) return;

      const liveParentId = live.parentId ?? node.parentId ?? "1";
      const liveIndex = live.index ?? node.index ?? 0;

      // Ensure the parent folder (and all its unmapped ancestors) exist in the
      // Loro doc before adding the bookmark. Without this, bookmarks created
      // inside unmapped folders (Opera-specific folders, user folders created
      // since bootstrap) become orphans in the CRDT and get deleted on the
      // next reconcile.
      const parentLoroId = await ensureAncestorsMapped(liveParentId);
      const loroId = crypto.randomUUID();
      _loroToChrome.set(loroId, node.id);
      _chromeToLoro.set(node.id, loroId);
      setBookmark(loroId, toNode({ ...node, parentId: liveParentId, index: liveIndex }, parentLoroId));
      await saveMapping();
      await onLocalChange();
    })().catch(console.error);
  };

  const onRemove = (_id: string, removeInfo: chrome.bookmarks.BookmarkRemoveInfo) => {
    if (isIgnoring()) return;
    // Chrome fires onRemoved once for the top-level item only — descendants are
    // NOT reported individually. Walk the full subtree so every child is also
    // deleted from the Loro doc and the mapping. Without this, children become
    // orphaned entries in the doc and cause "Bookmark id is invalid" on peers.
    function purge(node: chrome.bookmarks.BookmarkTreeNode): void {
      const loroId = _chromeToLoro.get(node.id);
      if (loroId) {
        _chromeToLoro.delete(node.id);
        _loroToChrome.delete(loroId);
        deleteBookmark(loroId);
      }
      node.children?.forEach(purge);
    }
    purge(removeInfo.node);
    saveMapping().catch(console.error);
    onLocalChange().catch(console.error);
  };

  const onChange = (id: string, changes: chrome.bookmarks.BookmarkChangeInfo) => {
    if (isIgnoring()) return;
    const loroId = _chromeToLoro.get(id);
    if (!loroId) return;
    const existing = getAllBookmarks()[loroId];
    if (!existing) return;
    setBookmark(loroId, {
      ...existing,
      title: changes.title ?? existing.title,
      url: changes.url ?? existing.url,
    });
    onLocalChange().catch(console.error);
  };

  const onMove = (_id: string, moveInfo: chrome.bookmarks.BookmarkMoveInfo) => {
    if (isIgnoring()) return;
    // A single move shifts indices for all siblings in the affected folder(s).
    // Update every sibling's index so the Loro doc has a consistent picture of
    // the full ordering — not just the moved item's new position.
    const affectedFolders = new Set([moveInfo.parentId]);
    if (moveInfo.oldParentId !== moveInfo.parentId) affectedFolders.add(moveInfo.oldParentId);
    (async () => {
      for (const folderId of affectedFolders) {
        const children = await chrome.bookmarks.getChildren(folderId);
        const parentLoroId = chromeParentToLoro(folderId);
        for (const [idx, child] of children.entries()) {
          const childLoroId = _chromeToLoro.get(child.id);
          if (!childLoroId) continue;
          const existing = getAllBookmarks()[childLoroId];
          if (!existing) continue;
          setBookmark(childLoroId, { ...existing, parentId: parentLoroId, index: idx });
        }
      }
      onLocalChange().catch(console.error);
    })().catch(console.error);
  };

  chrome.bookmarks.onCreated.addListener(onCreate);
  chrome.bookmarks.onRemoved.addListener(onRemove);
  chrome.bookmarks.onChanged.addListener(onChange);
  chrome.bookmarks.onMoved.addListener(onMove);

  _cleanupListeners = [
    () => chrome.bookmarks.onCreated.removeListener(onCreate),
    () => chrome.bookmarks.onRemoved.removeListener(onRemove),
    () => chrome.bookmarks.onChanged.removeListener(onChange),
    () => chrome.bookmarks.onMoved.removeListener(onMove),
  ];
}

// ── Incoming: remote Loro ops → chrome.bookmarks ─────────────────────────────

/**
 * Merge Chrome's current bookmark state into the Loro doc.
 *
 * Called during initializeDocs when a local snapshot already exists — i.e.
 * this device has synced before. It captures any bookmark changes made while
 * the user was signed out or offline so they aren't overwritten by the server
 * state during the subsequent syncFrom call.
 *
 * Only call this when _loroToChrome is non-empty (has an established mapping).
 * An empty mapping means this is a new profile or new device, so there are no
 * offline changes to capture — Chrome's bookmarks belong to the previous profile.
 */
export async function mergeLocalChangesIntoDoc(): Promise<void> {
  const chromeTree = await chrome.bookmarks.getTree();
  const currentChrome: Record<string, chrome.bookmarks.BookmarkTreeNode> = {};
  const queue = [...chromeTree];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (isAnyRootId(node.id)) {
      // Root container — don't add to map but do recurse into children.
      if (node.children) queue.push(...node.children);
      continue;
    }
    // Skip browser-specific root-level folders (e.g. Vivaldi's "Trash",
    // unknown Firefox roots) and their entire subtree.
    if (node.parentId !== undefined && isVirtualRootId(node.parentId)) continue;
    currentChrome[node.id] = node;
    if (node.children) queue.push(...node.children);
  }

  // 1. New Chrome bookmarks (not in mapping) → added while offline.
  for (const [chromeId, node] of Object.entries(currentChrome)) {
    if (_chromeToLoro.has(chromeId)) continue;
    const loroId = crypto.randomUUID();
    const parentLoroId = chromeParentToLoro(node.parentId ?? "1");
    _loroToChrome.set(loroId, chromeId);
    _chromeToLoro.set(chromeId, loroId);
    setBookmark(loroId, toNode(node, parentLoroId));
  }

  // 2. Loro bookmarks whose Chrome entry is gone → deleted while offline.
  const loroBookmarks = getAllBookmarks();
  for (const loroId of Object.keys(loroBookmarks)) {
    const chromeId = _loroToChrome.get(loroId);
    if (!chromeId) continue;
    if (!currentChrome[chromeId]) {
      deleteBookmark(loroId);
      _loroToChrome.delete(loroId);
      _chromeToLoro.delete(chromeId);
    }
  }

  // 3. Existing bookmarks that changed (title, URL, parent, index) → modified while offline.
  const normalizeUrl = (u: string | null | undefined): string | undefined => u ?? undefined;
  for (const [loroId, node] of Object.entries(getAllBookmarks())) {
    const chromeId = _loroToChrome.get(loroId);
    if (!chromeId) continue;
    const chromeNode = currentChrome[chromeId];
    if (!chromeNode) continue;
    const parentLoroId = chromeParentToLoro(chromeNode.parentId ?? "1");
    if (
      chromeNode.title !== node.title ||
      normalizeUrl(chromeNode.url) !== normalizeUrl(node.url) ||
      parentLoroId !== node.parentId ||
      chromeNode.index !== node.index
    ) {
      setBookmark(loroId, toNode(chromeNode, parentLoroId));
    }
  }

  await saveMapping();
}

/**
 * Compute the number of bookmark changes made while locked/offline, without
 * mutating either the Loro doc or the Chrome bookmark tree.
 *
 * Requires the Loro doc and the ID mapping to already be loaded.
 */
export async function computeOfflineChanges(): Promise<{ added: number; removed: number; modified: number }> {
  const chromeTree = await chrome.bookmarks.getTree();
  const currentChrome: Record<string, chrome.bookmarks.BookmarkTreeNode> = {};
  const queue = [...chromeTree];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (isAnyRootId(node.id)) {
      if (node.children) queue.push(...node.children);
      continue;
    }
    // Skip browser-specific root-level folders and their entire subtree.
    if (node.parentId !== undefined && isVirtualRootId(node.parentId)) continue;
    currentChrome[node.id] = node;
    if (node.children) queue.push(...node.children);
  }

  const loroBookmarks = getAllBookmarks();
  let added = 0, removed = 0, modified = 0;

  // Added: Chrome bookmarks not present in the mapping.
  for (const chromeId of Object.keys(currentChrome)) {
    if (!_chromeToLoro.has(chromeId)) added++;
  }

  // Removed: Loro bookmarks whose Chrome counterpart is gone.
  for (const [loroId] of _loroToChrome) {
    const chromeId = _loroToChrome.get(loroId)!;
    if (!currentChrome[chromeId]) removed++;
  }

  // Modified: bookmarks in both that differ in title, URL, or parent.
  // For ordering: compare the relative ORDER of siblings within each parent
  // rather than exact index numbers. Loro indices are non-sequential (e.g.
  // 0, 2, 5) while Chrome always reports sequential indices (0, 1, 2).
  // A number mismatch without an order mismatch is not a user-visible change.
  //
  // URL normalization: the WASM layer converts JS `undefined` → Rust `null`
  // when a folder's url field crosses the boundary. Treat null/undefined as
  // equivalent so folders don't show as "modified" on every unlock.
  const normalizeUrl = (u: string | null | undefined): string | undefined => u ?? undefined;

  const loroByParent = new Map<string, Array<[string, number]>>();  // parentId → [loroId, loroIndex]
  const chromeByParent = new Map<string, Array<[string, number]>>(); // parentId → [loroId, chromeIndex]

  for (const [loroId, node] of Object.entries(loroBookmarks)) {
    const chromeId = _loroToChrome.get(loroId);
    if (!chromeId) continue;
    const chromeNode = currentChrome[chromeId];
    if (!chromeNode) continue;
    const parentLoroId = chromeParentToLoro(chromeNode.parentId ?? "1");

    if (
      chromeNode.title !== node.title ||
      normalizeUrl(chromeNode.url) !== normalizeUrl(node.url) ||
      parentLoroId !== node.parentId
    ) {
      modified++;
      continue;
    }

    if (!loroByParent.has(node.parentId)) loroByParent.set(node.parentId, []);
    loroByParent.get(node.parentId)!.push([loroId, node.index]);
    if (!chromeByParent.has(parentLoroId)) chromeByParent.set(parentLoroId, []);
    chromeByParent.get(parentLoroId)!.push([loroId, chromeNode.index ?? 0]);
  }

  // One "modified" per folder where the sibling order changed.
  for (const [parentId, loroEntries] of loroByParent) {
    const chromeEntries = chromeByParent.get(parentId) ?? [];
    const loroOrder  = [...loroEntries].sort((a, b) => a[1] - b[1]).map(e => e[0]);
    const chromeOrder = [...chromeEntries].sort((a, b) => a[1] - b[1]).map(e => e[0]);
    if (loroOrder.some((id, i) => id !== chromeOrder[i])) modified++;
  }

  return { added, removed, modified };
}

/**
 * Export any Loro ops produced since the last version cursor (e.g. by
 * mergeLocalChangesIntoDoc), enqueue them as an encrypted delta, and push.
 * Called after offline-change merges so those changes reach the server.
 */
export async function exportAndEnqueueLocalChanges(): Promise<void> {
  const delta = exportFrom(_lastVersion);
  _lastVersion = currentVersion();
  await enqueueDelta(delta);
}

/**
 * Compare Chrome bookmark URLs against the loaded Loro doc (server state) to
 * determine how many bookmarks exist only locally vs only on the server.
 * Called after a fresh syncFrom on a new device, before any reconcile.
 */
export async function computeLocalImportDiff(): Promise<{ localOnly: number; serverOnly: number }> {
  const chromeTree = await chrome.bookmarks.getTree();
  const chromeUrls = new Set<string>();
  const queue = [...chromeTree];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (isAnyRootId(node.id)) {
      if (node.children) queue.push(...node.children);
      continue;
    }
    // Skip browser-specific root-level folders (e.g. Opera Speed Dial, Vivaldi Trash)
    // and their entire subtree — they are not managed by the extension and would
    // inflate localOnly with URLs that can never appear in any server profile.
    if (node.parentId !== undefined && isVirtualRootId(node.parentId)) continue;
    if (node.url) chromeUrls.add(node.url);
    if (node.children) queue.push(...node.children);
  }

  const serverBookmarks = getAllBookmarks();
  const serverUrls = new Set(
    Object.values(serverBookmarks)
      .map((b) => b.url)
      .filter((u): u is string => !!u),
  );

  let localOnly = 0;
  for (const url of chromeUrls) if (!serverUrls.has(url)) localOnly++;
  let serverOnly = 0;
  for (const url of serverUrls) if (!chromeUrls.has(url)) serverOnly++;

  return { localOnly, serverOnly };
}

/**
 * Add Chrome bookmarks into the Loro doc on a new device where there is no
 * mapping yet. Walks top-down so parent folders are mapped before children.
 *
 * @param excludeDuplicates - When true, skip Chrome bookmarks whose URL already
 *   exists in the server's Loro doc, and reuse matching server folders instead
 *   of creating duplicates.
 */
export async function mergeImportIntoDoc(excludeDuplicates: boolean): Promise<void> {
  const serverBookmarks = getAllBookmarks();
  const serverUrls = new Set(
    Object.values(serverBookmarks)
      .map((b) => b.url)
      .filter((u): u is string => !!u),
  );

  // Precompute the max Loro index per parent folder so new items can be
  // appended after all server items rather than interleaved with them.
  const maxServerIndex = new Map<string, number>();
  for (const node of Object.values(serverBookmarks)) {
    const cur = maxServerIndex.get(node.parentId) ?? -1;
    if (node.index > cur) maxServerIndex.set(node.parentId, node.index);
  }
  // Next available append index per parent (incremented as items are added).
  const nextIndex = new Map<string, number>();

  const chromeTree = await chrome.bookmarks.getTree();

  const queue = [...chromeTree];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (isAnyRootId(node.id)) {
      if (node.children) queue.push(...node.children);
      continue;
    }
    // Skip browser-specific root-level folders (e.g. Vivaldi's "Trash").
    if (node.parentId !== undefined && isVirtualRootId(node.parentId)) continue;

    if (!_chromeToLoro.has(node.id)) {
      const isFolder = !node.url;
      const skip = !isFolder && excludeDuplicates && serverUrls.has(node.url!);

      if (!skip) {
        const parentLoroId = chromeParentToLoro(node.parentId ?? "1");
        let loroId: string | undefined;

        if (isFolder && excludeDuplicates) {
          // Try to find a matching server folder (same title, same parent) to
          // reuse its Loro ID instead of creating a duplicate folder. The
          // `!_loroToChrome.has(id)` guard ensures each server folder is matched
          // at most once, handling multiple same-named siblings correctly.
          loroId = Object.entries(serverBookmarks).find(
            ([id, b]) =>
              !_loroToChrome.has(id) &&
              b.type === "folder" &&
              b.title === node.title &&
              b.parentId === parentLoroId,
          )?.[0];
        }

        if (loroId) {
          // Matched an existing server folder — just update the chrome↔loro mapping.
          // No new Loro entry is created; its children will resolve parentLoroId
          // correctly via chromeParentToLoro() since the chrome ID is now mapped.
          _loroToChrome.set(loroId, node.id);
          _chromeToLoro.set(node.id, loroId);
        } else {
          // New item — append it after all existing server items in this parent
          // so imported bookmarks don't interleave with the server's ordering.
          const serverMax = maxServerIndex.get(parentLoroId) ?? -1;
          const idx = nextIndex.get(parentLoroId) ?? (serverMax + 1);
          nextIndex.set(parentLoroId, idx + 1);

          loroId = crypto.randomUUID();
          _loroToChrome.set(loroId, node.id);
          _chromeToLoro.set(node.id, loroId);
          setBookmark(loroId, { ...toNode(node, parentLoroId), index: idx });
        }
      }
    }

    if (node.children) queue.push(...node.children);
  }
  await saveMapping();
}

export async function applyRemoteDelta(data: Uint8Array): Promise<void> {
  importUpdate(data);
  await reconcile();
}

/**
 * Apply a remote update to the CRDT only — does NOT touch Chrome bookmarks.
 * Used during the initial pull on a new device when we need to preserve
 * Chrome's original bookmark state for the import-conflict check.
 */
export function applyRemoteUpdateOnly(data: Uint8Array): void {
  importUpdate(data);
}

export async function reconcileBookmarks(): Promise<void> {
  await reconcile();
}

/**
 * Topologically sort entries so parent folders are created before their
 * children. `initialAvailable` should contain all IDs that are already
 * reachable (canonical root IDs + Loro IDs with existing Chrome mappings).
 */
function topoSort(
  entries: Array<[string, BookmarkNode]>,
  initialAvailable: Set<string>,
): Array<[string, BookmarkNode]> {
  const available = new Set<string>(initialAvailable);
  const remaining = new Map(entries);
  const result: Array<[string, BookmarkNode]> = [];

  while (remaining.size > 0) {
    let progress = false;
    const candidates = [...remaining.entries()].sort((a, b) => a[1].index - b[1].index);
    for (const [id, node] of candidates) {
      if (available.has(node.parentId)) {
        result.push([id, node]);
        available.add(id);
        remaining.delete(id);
        progress = true;
      }
    }
    if (!progress) {
      // Orphaned nodes — append to avoid an infinite loop.
      for (const entry of remaining) result.push(entry);
      break;
    }
  }
  return result;
}

async function reconcile(): Promise<void> {
  const desired = getAllBookmarks(); // keyed by Loro UUID

  const chromeTree = await chrome.bookmarks.getTree();
  const current: Record<string, chrome.bookmarks.BookmarkTreeNode> = {};
  const treeQueue = [...chromeTree];
  while (treeQueue.length > 0) {
    const node = treeQueue.shift()!;
    if (isAnyRootId(node.id)) {
      if (node.children) treeQueue.push(...node.children);
      continue;
    }
    // Skip browser-specific root-level folders (e.g. Vivaldi's "Trash",
    // unknown Firefox roots) and their entire subtree — reconcile must not
    // delete or move them.
    if (node.parentId !== undefined && isVirtualRootId(node.parentId)) continue;
    current[node.id] = node;
    if (node.children) treeQueue.push(...node.children);
  }

  console.log(`${LOG_TAG} reconcile: desired=${Object.keys(desired).length} loro bookmarks, current=${Object.keys(current).length} chrome bookmarks, mapping=${_loroToChrome.size} entries`);

  await withEchoFilter(async () => {
    // 0. Purge stale mapping entries — loroId → chromeId pairs where the Chrome
    //    ID no longer exists in the managed bookmark tree. This happens after a
    //    profile switch: the previous profile's Chrome IDs are removed during
    //    reconcile, making the returning profile's stored IDs invalid.
    //
    //    Strategy: getTree() snapshot is the fast path. For entries missing from
    //    the snapshot we call chrome.bookmarks.get() to distinguish two cases:
    //
    //      A. Opera getTree() lag — a bookmark that was just created may not
    //         appear in getTree() immediately. get() succeeds AND the bookmark's
    //         parent is a standard root or a tracked user folder → keep.
    //
    //      B. Vivaldi Trash (and similar) — Vivaldi moves deleted bookmarks to
    //         a Trash folder (parentId="0") rather than permanently removing
    //         them. get() succeeds but the bookmark's parent is Trash, whose
    //         Chrome ID is not a standard root and not in our mapping → purge.
    //
    //      C. Truly deleted — get() throws → purge.
    for (const [loroId, chromeId] of [..._loroToChrome]) {
      if (current[chromeId]) continue; // in snapshot → valid, keep
      const inManagedTree = await chrome.bookmarks.get(chromeId)
        .then(([bm]) => {
          const parentId = bm?.parentId ?? "";
          // Reachable only if the immediate parent is a standard root container
          // or a user folder tracked in the current profile's mapping.
          // Bookmarks in Vivaldi's Trash (or any other excluded folder) have a
          // parent that is neither, so they evaluate to false here.
          return _allNativeRootIds.has(parentId) || _chromeToLoro.has(parentId);
        })
        .catch(() => false);
      if (!inManagedTree) {
        _loroToChrome.delete(loroId);
        _chromeToLoro.delete(chromeId);
      }
    }

    // 0b. Resolve orphaned nodes in desired.
    //     An orphan is a node whose parent is neither a canonical root ID, nor
    //     present in desired, nor mapped to an existing Chrome bookmark. Orphans
    //     arise when a folder was deleted on another device using old code that
    //     didn't cascade-delete children in the Loro doc. Iterating to a fixed
    //     point handles grandchildren that become orphans after their parent is
    //     removed.
    const effectiveDesired = { ...desired };
    let foundOrphan = true;
    while (foundOrphan) {
      foundOrphan = false;
      for (const [loroId, node] of Object.entries(effectiveDesired)) {
        const pid = node.parentId;
        if (CANONICAL_ROOT_IDS.has(pid)) continue;
        if (effectiveDesired[pid]) continue;
        if (_loroToChrome.has(pid)) continue;
        delete effectiveDesired[loroId];
        foundOrphan = true;
      }
    }

    // Build a parent→children map so we can identify all descendants of a
    // deleted node without re-querying Chrome (the tree was captured above).
    const childrenOf = new Map<string, string[]>();
    for (const node of Object.values(current)) {
      const p = node.parentId ?? "";
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p)!.push(node.id);
    }
    function allDescendants(chromeId: string): string[] {
      const result: string[] = [];
      const queue = [...(childrenOf.get(chromeId) ?? [])];
      while (queue.length) {
        const id = queue.shift()!;
        result.push(id);
        (childrenOf.get(id) ?? []).forEach((c) => queue.push(c));
      }
      return result;
    }

    // 1. Delete Chrome bookmarks whose entry is not in effectiveDesired.
    //    Use removeTree (works for bookmarks and non-empty folders alike).
    //    Track which IDs were physically removed so steps 3/4 don't attempt
    //    to operate on them — Chrome returns "Bookmark id is invalid" otherwise.
    const deletedChromeIds = new Set<string>();
    for (const chromeId of Object.keys(current)) {
      if (deletedChromeIds.has(chromeId)) continue; // already removed by a parent's removeTree
      const loroId = _chromeToLoro.get(chromeId);
      if (loroId && effectiveDesired[loroId]) continue; // should keep this one
      console.log(`${LOG_TAG} reconcile step1: deleting chrome=${chromeId} title="${current[chromeId]?.title}" (loroId=${loroId ?? "unmapped"})`);
      try {
        await chrome.bookmarks.removeTree(chromeId);
      } catch (err) {
        console.error(`${LOG_TAG} reconcile step1: removeTree failed for chrome=${chromeId}`, err);
        continue;
      }
      deletedChromeIds.add(chromeId);
      // Clean up mapping for all descendants (they were implicitly removed).
      for (const descId of allDescendants(chromeId)) {
        deletedChromeIds.add(descId);
        const descLoro = _chromeToLoro.get(descId);
        if (descLoro) { _chromeToLoro.delete(descId); _loroToChrome.delete(descLoro); }
      }
      if (loroId) { _chromeToLoro.delete(chromeId); _loroToChrome.delete(loroId); }
    }

    // 2. Create Chrome bookmarks for Loro entries with no known Chrome ID.
    const alreadyMapped = new Set<string>([
      ...CANONICAL_ROOT_IDS,
      ..._loroToChrome.keys(),
    ]);
    const toCreate = topoSort(
      Object.entries(effectiveDesired).filter(([loroId]) => !_loroToChrome.has(loroId)),
      alreadyMapped,
    );

    console.log(`${LOG_TAG} reconcile step2: ${toCreate.length} bookmark(s) to create`);
    for (const [loroId, node] of toCreate) {
      const parentChromeId = loroParentToChrome(node.parentId);
      // Skip bookmarks whose parent cannot be created in Chrome:
      //   • virtual root — chrome.bookmarks.create rejects it
      //   • UUID string — parent failed to create earlier (no mapping exists)
      // Both cases arise from browser-specific folders (e.g. Vivaldi's "Trash")
      // that got bootstrapped from another device but don't exist in Chrome.
      if (!isValidChromeParentId(parentChromeId)) {
        console.warn(`${LOG_TAG} reconcile step2: skipping "${node.title}" — parentChrome "${parentChromeId}" is not a valid Chrome parent ID`);
        continue;
      }
      console.log(`${LOG_TAG} reconcile step2: creating loroId=${loroId.slice(0,8)} title="${node.title}" parentLoro=${node.parentId} → parentChrome=${parentChromeId}`);
      const created = await chrome.bookmarks
        .create({ parentId: parentChromeId, title: node.title, url: node.url })
        .catch((err) => { console.error(`${LOG_TAG} reconcile step2: create failed for "${node.title}":`, err); return null; });
      if (created) {
        _loroToChrome.set(loroId, created.id);
        _chromeToLoro.set(created.id, loroId);
        console.log(`${LOG_TAG} reconcile step2: created chrome=${created.id} for "${node.title}"`);
        // Save the mapping immediately after each create so that if the SW is
        // killed mid-loop, the next reconcile finds these bookmarks already mapped
        // and skips them rather than creating duplicates.
        await saveMapping();
      }
    }

    // 3. Update title/URL for existing bookmarks, and collect entries for position fixes.
    type FolderEntry = { chromeId: string; node: BookmarkNode; existing: chrome.bookmarks.BookmarkTreeNode };
    const byFolder = new Map<string, FolderEntry[]>();

    for (const [loroId, node] of Object.entries(effectiveDesired)) {
      const chromeId = _loroToChrome.get(loroId);
      if (!chromeId || deletedChromeIds.has(chromeId)) continue;
      const existing = current[chromeId];
      if (!existing) continue;

      const normalizeUrl = (u: string | null | undefined): string | undefined => u ?? undefined;
      if (existing.title !== node.title || normalizeUrl(existing.url) !== normalizeUrl(node.url)) {
        await chrome.bookmarks
          .update(chromeId, { title: node.title, url: normalizeUrl(node.url) })
          .catch(console.error);
      }

      // Skip if the parent couldn't be resolved to a valid Chrome ID (orphan
      // whose parent was just deleted in step 1 and removed from _loroToChrome).
      if (!CANONICAL_ROOT_IDS.has(node.parentId) && !_loroToChrome.has(node.parentId)) continue;
      const parentChromeId = loroParentToChrome(node.parentId);
      let entries = byFolder.get(parentChromeId);
      if (!entries) { entries = []; byFolder.set(parentChromeId, entries); }
      entries.push({ chromeId, node, existing });
    }

    // 4. Apply position changes folder by folder.
    //    Sort by desired index, then move from position 0 upward so each move
    //    lands correctly regardless of cascading index shifts from prior moves.
    for (const [parentChromeId, entries] of byFolder) {
      entries.sort((a, b) => a.node.index - b.node.index);

      // Check whether any item is out-of-place (wrong parent or wrong order).
      const needsMove = entries.some((e) => e.existing.parentId !== parentChromeId);
      if (!needsMove) {
        const byCurrentIndex = entries.slice().sort((a, b) => (a.existing.index ?? 0) - (b.existing.index ?? 0));
        if (byCurrentIndex.every((e, i) => e.chromeId === entries[i].chromeId)) continue;
      }

      for (let i = 0; i < entries.length; i++) {
        await chrome.bookmarks
          .move(entries[i].chromeId, { parentId: parentChromeId, index: i })
          .catch(console.error);
      }
    }
  });

  await saveMapping();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

/**
 * Seed the Loro doc from the current Chrome bookmark tree (first install or
 * new profile). Generates a stable UUID for each bookmark and stores the
 * chromeId mapping so future reconciles can find them.
 */
/** Bootstrap the Loro doc from Chrome's bookmarks. Returns the number of items added. */
export async function bootstrapFromChrome(profileId: string): Promise<number> {
  const [tree] = await chrome.bookmarks.getTree();

  // Iterative BFS — processes parents before children so _chromeToLoro entries
  // exist when a child needs to look up its parent's loroId.
  const queue: chrome.bookmarks.BookmarkTreeNode[] = tree.children ?? [];
  let count = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (isAnyRootId(node.id)) {
      if (node.children) queue.push(...node.children);
      continue;
    }
    // Skip browser-specific root-level folders (e.g. Vivaldi's "Trash",
    // "Shopping") that sit directly under the virtual root. These folders
    // cannot be created in Chrome on other devices, so including them in the
    // Loro doc would cause reconcile failures for the folder and all its children.
    if (node.parentId !== undefined && isVirtualRootId(node.parentId)) continue;
    const loroId = crypto.randomUUID();
    const parentLoroId = chromeParentToLoro(node.parentId ?? "1");
    _loroToChrome.set(loroId, node.id);
    _chromeToLoro.set(node.id, loroId);
    setBookmark(loroId, toNode(node, parentLoroId));
    if (node.children) queue.push(...node.children);
    count++;
  }
  await setMeta(`chromeIdMap-${profileId}`, Object.fromEntries(_loroToChrome));
  _lastVersion = currentVersion();
  return count;
}

export function resetVersionCursor(): void {
  _lastVersion = currentVersion();
}

/**
 * Remove all bookmarks from the standard root containers (Bookmarks Bar,
 * Other Bookmarks, Mobile Bookmarks). Browser-specific containers such as
 * Vivaldi's Trash or Firefox's Bookmarks Menu are left untouched.
 *
 * Called during "sign out & clear" to erase the active profile's bookmarks
 * from the local browser for security. Listeners must already be detached
 * before calling this (logout does so before calling clear).
 */
export async function clearManagedBookmarks(): Promise<void> {
  const [root] = await chrome.bookmarks.getTree();
  for (const container of root.children ?? []) {
    if (!isAnyRootId(container.id)) continue; // skip browser-specific containers
    for (const child of container.children ?? []) {
      try {
        await chrome.bookmarks.removeTree(child.id);
      } catch (err) {
        console.error(`${LOG_TAG} clearManagedBookmarks: removeTree failed for chrome=${child.id}`, err);
      }
    }
  }
}
