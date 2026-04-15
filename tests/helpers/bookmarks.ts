import type { Page } from "@playwright/test";

export interface Bookmark {
  id?: string;
  title: string;
  url?: string;
  parentId?: string;
  index?: number;
}

// Chrome's bookmark tree has three fixed top-level children of the root:
//   "1" = Bookmarks bar   "2" = Other Bookmarks   "3" = Mobile Bookmarks
// Tests default to "1" so bookmarks appear on the bar rather than in the
// hidden "Other Bookmarks" folder, matching typical user behaviour.
const BOOKMARKS_BAR_ID = "1";

export async function createBookmark(page: Page, bookmark: Omit<Bookmark, "id" | "index">): Promise<string> {
  const node = await page.evaluate(
    ({ title, url, parentId }) =>
      chrome.bookmarks.create({ title, url, parentId }),
    { ...bookmark, parentId: bookmark.parentId ?? BOOKMARKS_BAR_ID },
  );
  return node.id;
}

export async function createFolder(page: Page, title: string, parentId?: string): Promise<string> {
  const node = await page.evaluate(
    ({ title, parentId }) => chrome.bookmarks.create({ title, parentId }),
    { title, parentId: parentId ?? BOOKMARKS_BAR_ID },
  );
  return node.id;
}

export async function deleteBookmark(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => chrome.bookmarks.remove(id), id);
}

export async function deleteBookmarkTree(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => chrome.bookmarks.removeTree(id), id);
}

export async function moveBookmark(
  page: Page,
  id: string,
  destination: { parentId?: string; index?: number },
): Promise<void> {
  await page.evaluate(
    ({ id, destination }) => chrome.bookmarks.move(id, destination),
    { id, destination },
  );
}

export async function renameBookmark(page: Page, id: string, title: string): Promise<void> {
  await page.evaluate(
    ({ id, title }) => chrome.bookmarks.update(id, { title }),
    { id, title },
  );
}

export async function getAllBookmarks(page: Page): Promise<Bookmark[]> {
  return page.evaluate(async () => {
    type TreeNode = chrome.bookmarks.BookmarkTreeNode;
    const collect = (nodes: TreeNode[]): Bookmark[] =>
      nodes.flatMap((n) => [
        ...(n.url ? [{ id: n.id, title: n.title, url: n.url, parentId: n.parentId, index: n.index }] : []),
        ...collect(n.children ?? []),
      ]);
    return collect(await chrome.bookmarks.getTree());
  });
}

export async function getAllNodes(page: Page): Promise<Bookmark[]> {
  return page.evaluate(async () => {
    type TreeNode = chrome.bookmarks.BookmarkTreeNode;
    const collect = (nodes: TreeNode[]): Bookmark[] =>
      nodes.flatMap((n) => [
        { id: n.id, title: n.title, url: n.url, parentId: n.parentId, index: n.index },
        ...collect(n.children ?? []),
      ]);
    // Skip the root node itself
    const [root] = await chrome.bookmarks.getTree();
    return collect(root.children ?? []);
  });
}

export async function getBookmarkByUrl(page: Page, url: string): Promise<Bookmark | null> {
  const all = await getAllBookmarks(page);
  return all.find((b) => b.url === url) ?? null;
}

export async function getNodeByTitle(page: Page, title: string): Promise<Bookmark | null> {
  const all = await getAllNodes(page);
  return all.find((b) => b.title === title) ?? null;
}
