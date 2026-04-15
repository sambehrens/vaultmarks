/**
 * Cross-browser integration tests: Chrome ↔ Firefox sync.
 *
 * Each test registers on one browser type and verifies the sync appears on
 * the other, exercising the full round-trip through the server with different
 * extension runtimes on each side.
 *
 * NOTE: All tests below are currently skipped because Playwright's Firefox
 * BiDi implementation cannot navigate to moz-extension:// URLs.  The
 * launchFirefoxBrowser() call succeeds, but the returned page is permanently
 * stuck in "waiting for navigation to finish" after the goto(), making all
 * locator/evaluate/screenshot operations block forever.  See the block comment
 * in firefox.spec.ts for the full diagnosis.
 */

import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { uniqueEmail } from "../helpers/popup";
import {
  createBookmark,
  getAllBookmarks,
  deleteBookmark,
  renameBookmark,
  getBookmarkByUrl,
} from "../helpers/bookmarks";
import {
  launchChromeBrowser,
  launchFirefoxBrowser,
  closeBrowser,
  DELTA_ENQUEUE_WAIT,
} from "../helpers/browser";

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

// ── Chrome → Firefox ──────────────────────────────────────────────────────────

test.skip("Chrome→Firefox: bookmark created in Chrome appears in Firefox", async () => {
  const { extensionDist, extensionFirefoxDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/xb-chrome-to-ff-${Date.now()}`;

  const chrome = await launchChromeBrowser(extensionDist);
  const firefox = await launchFirefoxBrowser(extensionFirefoxDist);
  try {
    await chrome.helper.register(email, password);
    await createBookmark(chrome.page, { title: "Chrome Bookmark", url });
    await chrome.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await chrome.helper.sync();

    await firefox.helper.login(email, password);
    await firefox.helper.sync();

    const urls = (await getAllBookmarks(firefox.page)).map((b) => b.url);
    expect(urls).toContain(url);
  } finally {
    await closeBrowser(chrome);
    await closeBrowser(firefox);
  }
});

test.skip("Chrome→Firefox: bookmark delete in Chrome propagates to Firefox", async () => {
  const { extensionDist, extensionFirefoxDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/xb-chrome-del-ff-${Date.now()}`;

  const chrome = await launchChromeBrowser(extensionDist);
  const firefox = await launchFirefoxBrowser(extensionFirefoxDist);
  try {
    await chrome.helper.register(email, password);
    const id = await createBookmark(chrome.page, { title: "Will Delete", url });
    await chrome.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await chrome.helper.sync();

    await firefox.helper.login(email, password);
    await firefox.helper.sync();
    expect((await getAllBookmarks(firefox.page)).map((b) => b.url)).toContain(url);

    await deleteBookmark(chrome.page, id);
    await chrome.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await chrome.helper.sync();

    await firefox.helper.sync();
    expect((await getAllBookmarks(firefox.page)).map((b) => b.url)).not.toContain(url);
  } finally {
    await closeBrowser(chrome);
    await closeBrowser(firefox);
  }
});

test.skip("Chrome→Firefox: bookmark rename in Chrome propagates to Firefox", async () => {
  const { extensionDist, extensionFirefoxDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/xb-chrome-rename-ff-${Date.now()}`;

  const chrome = await launchChromeBrowser(extensionDist);
  const firefox = await launchFirefoxBrowser(extensionFirefoxDist);
  try {
    await chrome.helper.register(email, password);
    const id = await createBookmark(chrome.page, { title: "Original Name", url });
    await chrome.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await chrome.helper.sync();

    await firefox.helper.login(email, password);
    await firefox.helper.sync();
    expect((await getAllBookmarks(firefox.page)).map((b) => b.title)).toContain("Original Name");

    await renameBookmark(chrome.page, id, "Renamed By Chrome");
    await chrome.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await chrome.helper.sync();

    await firefox.helper.sync();
    const titles = (await getAllBookmarks(firefox.page)).map((b) => b.title);
    expect(titles).toContain("Renamed By Chrome");
    expect(titles).not.toContain("Original Name");
  } finally {
    await closeBrowser(chrome);
    await closeBrowser(firefox);
  }
});

// ── Firefox → Chrome ──────────────────────────────────────────────────────────

test.skip("Firefox→Chrome: bookmark created in Firefox appears in Chrome", async () => {
  const { extensionDist, extensionFirefoxDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/xb-ff-to-chrome-${Date.now()}`;

  const firefox = await launchFirefoxBrowser(extensionFirefoxDist);
  const chrome = await launchChromeBrowser(extensionDist);
  try {
    await firefox.helper.register(email, password);
    await createBookmark(firefox.page, { title: "Firefox Bookmark", url });
    await firefox.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await firefox.helper.sync();

    await chrome.helper.login(email, password);
    await chrome.helper.sync();

    const urls = (await getAllBookmarks(chrome.page)).map((b) => b.url);
    expect(urls).toContain(url);
  } finally {
    await closeBrowser(firefox);
    await closeBrowser(chrome);
  }
});

test.skip("Firefox→Chrome: bookmark delete in Firefox propagates to Chrome", async () => {
  const { extensionDist, extensionFirefoxDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/xb-ff-del-chrome-${Date.now()}`;

  const firefox = await launchFirefoxBrowser(extensionFirefoxDist);
  const chrome = await launchChromeBrowser(extensionDist);
  try {
    await firefox.helper.register(email, password);
    const id = await createBookmark(firefox.page, { title: "FF Will Delete", url });
    await firefox.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await firefox.helper.sync();

    await chrome.helper.login(email, password);
    await chrome.helper.sync();
    expect((await getAllBookmarks(chrome.page)).map((b) => b.url)).toContain(url);

    await deleteBookmark(firefox.page, id);
    await firefox.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await firefox.helper.sync();

    await chrome.helper.sync();
    expect((await getAllBookmarks(chrome.page)).map((b) => b.url)).not.toContain(url);
  } finally {
    await closeBrowser(firefox);
    await closeBrowser(chrome);
  }
});

// ── Concurrent cross-browser CRDT merge ───────────────────────────────────────

test.skip("Chrome+Firefox: concurrent offline edits merge correctly (CRDT)", async () => {
  const { extensionDist, extensionFirefoxDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urlChrome = `https://example.com/xb-crdt-chrome-${Date.now()}`;
  const urlFirefox = `https://example.com/xb-crdt-ff-${Date.now()}`;

  const chrome = await launchChromeBrowser(extensionDist);
  const firefox = await launchFirefoxBrowser(extensionFirefoxDist);
  try {
    // Both start from the same empty synced state
    await chrome.helper.register(email, password);
    await chrome.helper.sync();
    await firefox.helper.login(email, password);
    await firefox.helper.sync();

    // Both make changes without syncing
    await createBookmark(chrome.page, { title: "Chrome's Bookmark", url: urlChrome });
    await createBookmark(firefox.page, { title: "Firefox's Bookmark", url: urlFirefox });
    await chrome.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await firefox.page.waitForTimeout(DELTA_ENQUEUE_WAIT);

    // Chrome pushes first, Firefox pushes and pulls, Chrome pulls Firefox's delta
    await chrome.helper.sync();
    await firefox.helper.sync();
    await chrome.helper.sync();

    const urlsChrome = (await getAllBookmarks(chrome.page)).map((b) => b.url);
    const urlsFirefox = (await getAllBookmarks(firefox.page)).map((b) => b.url);

    expect(urlsChrome).toContain(urlChrome);
    expect(urlsChrome).toContain(urlFirefox);
    expect(urlsFirefox).toContain(urlChrome);
    expect(urlsFirefox).toContain(urlFirefox);
  } finally {
    await closeBrowser(chrome);
    await closeBrowser(firefox);
  }
});
