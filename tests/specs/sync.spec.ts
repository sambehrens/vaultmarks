import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { uniqueEmail } from "../helpers/popup";
import {
  createBookmark,
  createFolder,
  deleteBookmark,
  deleteBookmarkTree,
  moveBookmark,
  renameBookmark,
  getAllBookmarks,
  getAllNodes,
  getBookmarkByUrl,
  getNodeByTitle,
} from "../helpers/bookmarks";
import { launchChromeBrowser, closeBrowser, DELTA_ENQUEUE_WAIT } from "../helpers/browser";

const STATE_FILE = path.join(__dirname, "../.test-state.json");

interface TestState {
  serverPort: number;
  serverPid: number;
  extensionDist: string;
  extensionFirefoxDist: string;
  pgContainerId: string;
}

function readState(): TestState {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as TestState;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("bookmark created in browser A appears in browser B", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/create-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);
    await createBookmark(A.page, { title: "Sync Test", url });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    await B.helper.login(email, password);
    await B.helper.sync();

    const urls = (await getAllBookmarks(B.page)).map((b) => b.url);
    expect(urls).toContain(url);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("bookmark delete syncs across browsers", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/delete-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);
    const id = await createBookmark(A.page, { title: "To Delete", url });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    await B.helper.login(email, password);
    await B.helper.sync();
    expect((await getAllBookmarks(B.page)).map((b) => b.url)).toContain(url);

    // Delete on A and sync
    await deleteBookmark(A.page, id);
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // B should see it gone
    await B.helper.sync();
    expect((await getAllBookmarks(B.page)).map((b) => b.url)).not.toContain(url);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("bookmark rename syncs across browsers", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/rename-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);
    const id = await createBookmark(A.page, { title: "Original Title", url });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    await B.helper.login(email, password);
    await B.helper.sync();
    expect((await getAllBookmarks(B.page)).map((b) => b.title)).toContain("Original Title");

    // Rename on A and sync
    await renameBookmark(A.page, id, "New Title");
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // B should see the new title and not the old one
    await B.helper.sync();
    const titles = (await getAllBookmarks(B.page)).map((b) => b.title);
    expect(titles).toContain("New Title");
    expect(titles).not.toContain("Original Title");
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("bookmark move into folder syncs across browsers", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/move-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);
    const folderId = await createFolder(A.page, "My Folder");
    const bookmarkId = await createBookmark(A.page, { title: "Moving Bookmark", url });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    await B.helper.login(email, password);
    await B.helper.sync();

    // Move bookmark into folder on A
    await moveBookmark(A.page, bookmarkId, { parentId: folderId });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // B should see the bookmark inside the folder
    await B.helper.sync();
    const folder = await getNodeByTitle(B.page, "My Folder");
    const bookmark = await getBookmarkByUrl(B.page, url);
    expect(folder).not.toBeNull();
    expect(bookmark).not.toBeNull();
    expect(bookmark?.parentId).toBe(folder?.id);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("folder create and delete sync across browsers", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const childUrl = `https://example.com/folder-child-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);
    const folderId = await createFolder(A.page, "Temp Folder");
    await createBookmark(A.page, { title: "Child", url: childUrl, parentId: folderId });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    await B.helper.login(email, password);
    await B.helper.sync();

    // B should see the folder and child
    expect(await getNodeByTitle(B.page, "Temp Folder")).not.toBeNull();
    expect(await getBookmarkByUrl(B.page, childUrl)).not.toBeNull();

    // Delete folder (cascade) on A
    await deleteBookmarkTree(A.page, folderId);
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // B should see both folder and child gone
    await B.helper.sync();
    expect(await getNodeByTitle(B.page, "Temp Folder")).toBeNull();
    expect(await getBookmarkByUrl(B.page, childUrl)).toBeNull();
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("concurrent offline edits merge correctly (CRDT)", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urlA = `https://example.com/concurrent-a-${Date.now()}`;
  const urlB = `https://example.com/concurrent-b-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    // Both browsers start from the same synced state (empty profile)
    await A.helper.register(email, password);
    await A.helper.sync();
    await B.helper.login(email, password);
    await B.helper.sync();

    // Both make changes without syncing
    await createBookmark(A.page, { title: "A's Bookmark", url: urlA });
    await createBookmark(B.page, { title: "B's Bookmark", url: urlB });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await B.page.waitForTimeout(DELTA_ENQUEUE_WAIT);

    // A syncs first (pushes its delta)
    await A.helper.sync();

    // B syncs (pushes its delta, pulls A's delta)
    await B.helper.sync();

    // A syncs again to pull B's delta
    await A.helper.sync();

    // Both browsers should have both bookmarks — no data lost
    const urlsA = (await getAllBookmarks(A.page)).map((b) => b.url);
    const urlsB = (await getAllBookmarks(B.page)).map((b) => b.url);
    expect(urlsA).toContain(urlA);
    expect(urlsA).toContain(urlB);
    expect(urlsB).toContain(urlA);
    expect(urlsB).toContain(urlB);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("changes pushed while browser B is locked are applied on unlock", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/locked-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);
    await A.helper.sync();
    await B.helper.login(email, password);
    await B.helper.sync();

    // Lock browser B
    await B.helper.lock();

    // A creates a bookmark and syncs while B is locked
    await createBookmark(A.page, { title: "While Locked", url });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // B unlocks and syncs — should pick up the delta
    await B.helper.unlock(password);
    await B.helper.sync();

    expect((await getAllBookmarks(B.page)).map((b) => b.url)).toContain(url);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("new device login pulls multiple changes via delta replay", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urls = Array.from({ length: 5 }, (_, i) => `https://example.com/replay-${i}-${Date.now()}`);

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);

    // Create multiple bookmarks and sync each in a separate batch
    for (const url of urls) {
      await createBookmark(A.page, { title: url, url });
      await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
      await A.helper.sync();
    }

    // B is a fresh device with no local snapshot — should replay all deltas
    await B.helper.login(email, password);
    await B.helper.sync();

    const bUrls = (await getAllBookmarks(B.page)).map((b) => b.url);
    for (const url of urls) {
      expect(bUrls).toContain(url);
    }
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("new device loads from server snapshot instead of replaying all deltas", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urls = Array.from({ length: 3 }, (_, i) => `https://example.com/snapshot-${i}-${Date.now()}`);

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  const C = await launchChromeBrowser(extensionDist);
  try {
    // A creates bookmarks and syncs
    await A.helper.register(email, password);
    for (const url of urls) {
      await createBookmark(A.page, { title: url, url });
      await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
      await A.helper.sync();
    }

    // B is the first new device: no local/server snapshot yet, does full delta
    // replay, then uploads the resulting snapshot as a side effect of enrollment.
    await B.helper.login(email, password);
    await B.helper.sync();
    // Give the background a moment to finish the fire-and-forget snapshot upload
    await B.page.waitForTimeout(2_000);

    // C is the second new device: finds the server snapshot B uploaded,
    // loads compacted state, then only pulls deltas since snapshot_seq.
    await C.helper.login(email, password);
    await C.helper.sync();

    const cUrls = (await getAllBookmarks(C.page)).map((b) => b.url);
    for (const url of urls) {
      expect(cUrls).toContain(url);
    }
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
    await closeBrowser(C);
  }
});

test("profile isolation: changes in profile A do not appear in profile B", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const defaultUrl = `https://example.com/default-${Date.now()}`;
  const workUrl = `https://example.com/work-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    // A sets up two profiles with distinct bookmarks
    await A.helper.register(email, password);
    await createBookmark(A.page, { title: "Default Bookmark", url: defaultUrl });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    await A.helper.createProfile("Work");
    await A.helper.switchProfile("Work");
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await createBookmark(A.page, { title: "Work Bookmark", url: workUrl });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // B logs in — Default profile is active
    await B.helper.login(email, password);
    await B.helper.sync();

    // Default profile should have only the default bookmark
    let bUrls = (await getAllBookmarks(B.page)).map((b) => b.url);
    expect(bUrls).toContain(defaultUrl);
    expect(bUrls).not.toContain(workUrl);

    // Switch B to Work profile and sync
    await B.helper.switchProfile("Work");
    await B.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await B.helper.sync();

    // Work profile should have only the work bookmark
    bUrls = (await getAllBookmarks(B.page)).map((b) => b.url);
    expect(bUrls).toContain(workUrl);
    expect(bUrls).not.toContain(defaultUrl);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("WebSocket push triggers automatic sync without manual button click", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/ws-push-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);
    await A.helper.sync();

    await B.helper.login(email, password);
    await B.helper.sync();

    // A pushes a new bookmark — server sends a WebSocket notification to B
    await createBookmark(A.page, { title: "WS Push Test", url });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // B should auto-pull via WebSocket without any manual sync call.
    // Poll chrome.bookmarks directly until the URL appears or the timeout fires.
    await B.page.waitForFunction(
      async (expectedUrl: string) => {
        type TreeNode = chrome.bookmarks.BookmarkTreeNode;
        const collect = (nodes: TreeNode[]): string[] =>
          nodes.flatMap((n) => [
            ...(n.url ? [n.url] : []),
            ...collect(n.children ?? []),
          ]);
        const [root] = await chrome.bookmarks.getTree();
        return collect(root.children ?? []).includes(expectedUrl);
      },
      url,
      { timeout: 15_000 },
    );
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});
