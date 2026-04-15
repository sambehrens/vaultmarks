/**
 * Firefox extension tests — currently skipped.
 *
 * Playwright's Firefox BiDi implementation cannot navigate to moz-extension://
 * URLs: page.goto() to an extension page leaves Playwright in a permanent
 * "waiting for navigation to finish" state, blocking all subsequent locator /
 * evaluate / screenshot calls.  Alternative approaches (window.open, iframe,
 * CDP session) are all blocked by Firefox security restrictions.
 *
 * These tests can be re-enabled when Playwright's Firefox BiDi implementation
 * supports privileged-URL navigation, or when we add a Firefox RDP-based
 * page-interaction layer.
 */
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { uniqueEmail } from "../helpers/popup";
import {
  createBookmark,
  getAllBookmarks,
  getNodeByTitle,
  deleteBookmark,
  renameBookmark,
} from "../helpers/bookmarks";
import { launchFirefoxBrowser, closeBrowser, DELTA_ENQUEUE_WAIT } from "../helpers/browser";

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

// ── Firefox-specific tests ────────────────────────────────────────────────────

test.skip("Firefox: register, create bookmark, sync, login on second instance, verify", async () => {
  const { extensionFirefoxDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/ff-create-${Date.now()}`;

  const A = await launchFirefoxBrowser(extensionFirefoxDist);
  const B = await launchFirefoxBrowser(extensionFirefoxDist);
  try {
    await A.helper.register(email, password);
    await createBookmark(A.page, { title: "Firefox Bookmark", url });
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

test.skip("Firefox: bookmark delete syncs between two Firefox instances", async () => {
  const { extensionFirefoxDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const url = `https://example.com/ff-delete-${Date.now()}`;

  const A = await launchFirefoxBrowser(extensionFirefoxDist);
  const B = await launchFirefoxBrowser(extensionFirefoxDist);
  try {
    await A.helper.register(email, password);
    const id = await createBookmark(A.page, { title: "To Delete FF", url });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    await B.helper.login(email, password);
    await B.helper.sync();
    expect((await getAllBookmarks(B.page)).map((b) => b.url)).toContain(url);

    await deleteBookmark(A.page, id);
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    await B.helper.sync();
    expect((await getAllBookmarks(B.page)).map((b) => b.url)).not.toContain(url);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test.skip("Firefox: concurrent offline edits merge correctly (CRDT)", async () => {
  const { extensionFirefoxDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urlA = `https://example.com/ff-concurrent-a-${Date.now()}`;
  const urlB = `https://example.com/ff-concurrent-b-${Date.now()}`;

  const A = await launchFirefoxBrowser(extensionFirefoxDist);
  const B = await launchFirefoxBrowser(extensionFirefoxDist);
  try {
    await A.helper.register(email, password);
    await A.helper.sync();
    await B.helper.login(email, password);
    await B.helper.sync();

    // Both make changes without syncing
    await createBookmark(A.page, { title: "FF-A's Bookmark", url: urlA });
    await createBookmark(B.page, { title: "FF-B's Bookmark", url: urlB });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await B.page.waitForTimeout(DELTA_ENQUEUE_WAIT);

    await A.helper.sync();
    await B.helper.sync();
    await A.helper.sync();

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
