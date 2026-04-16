/**
 * Import conflict and locked-changes resolution tests.
 *
 * Case 1 — Login conflict on a returning device (storedSnapshot exists but Chrome
 * has local-only bookmarks not yet in the server profile).  Exercises the fix in
 * the storedSnapshot branch of initializeDocs() that now runs checkImport before
 * falling through to reconcileBookmarks(), preventing silent deletion.
 *
 *   → overwrite:    Chrome reconciled to match the server profile (local bookmark removed)
 *   → merge:        local bookmark added to the server profile (both bookmarks kept)
 *   → new profile:  local bookmarks saved to a separate profile, original profile unchanged
 *
 * Case 2 — Locked conflict: Chrome bookmarks changed while the session was locked.
 * The "Changes made while locked" modal appears on unlock.
 *
 *   → keep changes:    local bookmarks merged into the profile and synced
 *   → discard changes: local bookmarks discarded, server state restored
 *
 * Setup for login conflict tests:
 *   1. Device A registers and creates a server bookmark.
 *   2. Device B logs in and syncs — establishes storedSnapshot + mapping in IndexedDB.
 *   3. Device B logs out (snapshot persists on disk; bookmark listeners detached).
 *   4. A local Chrome bookmark is added to B while signed out (no listener → unmapped).
 *   5. Device B logs back in → conflict modal appears instead of silent deletion.
 */

import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { uniqueEmail } from "../helpers/popup";
import { createBookmark, getAllBookmarks } from "../helpers/bookmarks";
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

// ── Shared setup helper ───────────────────────────────────────────────────────

/**
 * Put browser B into the "returning device with a local-only bookmark" state:
 *   • A has registered and pushed urlServer to the server.
 *   • B has previously synced (storedSnapshot + mapping exist in IndexedDB).
 *   • B is now logged out with urlLocal sitting in Chrome, unmapped.
 * Submits B's login credentials so the caller can then wait for the conflict modal.
 */
async function setupLoginConflict(
  A: Awaited<ReturnType<typeof launchChromeBrowser>>,
  B: Awaited<ReturnType<typeof launchChromeBrowser>>,
  email: string,
  password: string,
  urlServer: string,
  urlLocal: string,
): Promise<void> {
  // A creates a server-side bookmark.
  await A.helper.register(email, password);
  await createBookmark(A.page, { title: "Server Bookmark", url: urlServer });
  await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
  await A.helper.sync();

  // B logs in for the first time → Chrome is empty so no conflict; storedSnapshot
  // and mapping are written to IndexedDB after initializeDocs completes.
  await B.helper.login(email, password);
  await B.helper.sync();

  // B logs out.  The storedSnapshot and mapping remain in IndexedDB; the bookmark
  // listeners are detached so future Chrome changes won't be tracked.
  await B.helper.logout();

  // Add a local bookmark while B is signed out.  Because listeners are detached
  // it gets no loroId, making it "unmapped" from the extension's perspective.
  await createBookmark(B.page, { title: "Local Bookmark", url: urlLocal });

  // Submit credentials — the caller awaits the conflict modal or main view.
  await B.helper.submit(email, password);
}

// ── Reactive teardown regression ─────────────────────────────────────────────
//
// When the user resolves the import conflict, resolveImport() calls
// setPendingImport(undefined).  SolidJS can re-evaluate the inner Show
// conditions (d().serverOnly, d().localOnly) while pendingImport() is
// already undefined — crashing with "Cannot read properties of undefined
// (reading 'serverOnly')".  Observed in Opera and Edge.

test("no JS errors thrown when import conflict modal is dismissed", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urlServer = `https://example.com/cf-teardown-server-${Date.now()}`;
  const urlLocal  = `https://example.com/cf-teardown-local-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    // Collect any uncaught JS errors from the popup page.
    const pageErrors: Error[] = [];
    B.page.on("pageerror", (err) => pageErrors.push(err));

    await setupLoginConflict(A, B, email, password, urlServer, urlLocal);
    await B.helper.waitForImportConflict();

    // Overwrite was the action observed to crash in Opera and Edge.
    await B.helper.resolveImportOverwrite();

    // Allow time for any deferred reactive teardown errors to surface.
    await B.page.waitForTimeout(500);

    expect(pageErrors, pageErrors.map((e) => e.message).join("\n")).toHaveLength(0);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

// ── Login conflict: storedSnapshot branch ─────────────────────────────────────

test("login conflict → overwrite: local bookmark removed, server bookmark kept", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urlServer = `https://example.com/cf-ow-server-${Date.now()}`;
  const urlLocal  = `https://example.com/cf-ow-local-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await setupLoginConflict(A, B, email, password, urlServer, urlLocal);

    // Conflict modal must appear (not silently deleted).
    await B.helper.waitForImportConflict();

    // "Use account's bookmarks" → Chrome reconciles to server state.
    await B.helper.resolveImportOverwrite();
    await B.helper.sync();

    const urls = (await getAllBookmarks(B.page)).map((b) => b.url);
    expect(urls).toContain(urlServer);
    expect(urls).not.toContain(urlLocal);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("login conflict → merge: local and server bookmarks both present", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urlServer = `https://example.com/cf-merge-server-${Date.now()}`;
  const urlLocal  = `https://example.com/cf-merge-local-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await setupLoginConflict(A, B, email, password, urlServer, urlLocal);
    await B.helper.waitForImportConflict();

    // "Merge into profile" → local bookmark is added to the server profile.
    await B.helper.resolveImportMerge();
    await B.helper.sync();

    const urls = (await getAllBookmarks(B.page)).map((b) => b.url);
    expect(urls).toContain(urlServer);
    expect(urls).toContain(urlLocal);

    // A pulls the merged delta — the local bookmark should now be on the server too.
    await A.helper.sync();
    const urlsA = (await getAllBookmarks(A.page)).map((b) => b.url);
    expect(urlsA).toContain(urlLocal);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("login conflict → merge into different profile: active profile switches to target", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urlServer = `https://example.com/cf-mip-server-${Date.now()}`;
  const urlLocal  = `https://example.com/cf-mip-local-${Date.now()}`;
  const urlWork   = `https://example.com/cf-mip-work-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    // A registers and adds a Default bookmark, then creates a Work profile with its own bookmark.
    await A.helper.register(email, password);
    await createBookmark(A.page, { title: "Server Bookmark", url: urlServer });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    await A.helper.createProfile("Work");
    await A.helper.switchProfile("Work");
    await createBookmark(A.page, { title: "Work Bookmark", url: urlWork });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // B logs in on Default (Chrome gets urlServer), then logs out.
    await B.helper.login(email, password);
    await B.helper.sync();
    await B.helper.logout();

    // B adds a local bookmark while signed out — this triggers the conflict on re-login.
    await createBookmark(B.page, { title: "Local Bookmark", url: urlLocal });

    await B.helper.submit(email, password);
    await B.helper.waitForImportConflict();

    // Merge the local bookmark into the Work profile (not Default).
    await B.helper.resolveImportMergeInto("Work");

    // The popup must now show Work as the active profile — not Default.
    expect(await B.helper.getActiveProfileName()).toBe("Work");

    // Chrome on B should reflect the Work profile (urlWork + urlLocal merged in).
    await B.helper.sync();
    const urlsB = (await getAllBookmarks(B.page)).map((b) => b.url);
    expect(urlsB).toContain(urlWork);
    expect(urlsB).toContain(urlLocal);

    // A pulls Work's updated state — urlLocal should now appear there.
    await A.helper.switchProfile("Work");
    await A.helper.sync();
    const urlsAWork = (await getAllBookmarks(A.page)).map((b) => b.url);
    expect(urlsAWork).toContain(urlLocal);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("login conflict → new profile: local bookmarks saved to separate profile", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urlServer = `https://example.com/cf-np-server-${Date.now()}`;
  const urlLocal  = `https://example.com/cf-np-local-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await setupLoginConflict(A, B, email, password, urlServer, urlLocal);
    await B.helper.waitForImportConflict();

    // "Save as new profile" → local bookmarks go into a separate profile.
    await B.helper.resolveImportNewProfile("Imported");

    // New profile is active; Chrome has been bootstrapped from the original
    // Chrome state (urlServer + urlLocal) into the new profile.
    expect(await B.helper.getActiveProfileName()).toBe("Imported");
    const urlsNewProfile = (await getAllBookmarks(B.page)).map((b) => b.url);
    expect(urlsNewProfile).toContain(urlLocal);

    // Switch back to the original "Default" profile → only the server bookmark.
    await B.helper.switchProfile("Default");
    await B.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await B.helper.sync();

    const urlsDefault = (await getAllBookmarks(B.page)).map((b) => b.url);
    expect(urlsDefault).toContain(urlServer);
    expect(urlsDefault).not.toContain(urlLocal);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

// ── Compare-with switch does not corrupt original profile snapshot ────────────
//
// Regression: when an existing user logs in on a brand-new device (no local
// IndexedDB snapshot), initializeDocs pulls the server state, detects a conflict
// (Chrome has local-only bookmarks), and returns early WITHOUT persisting the
// snapshot.  If the user then switches "Compare with" to a different profile,
// handleRecomputeImportDiff calls loadSnapshot(originalProfileId) → null (never
// persisted) → falls back to initDoc() (empty).  handleResolveImport then calls
// persistSnapshot(originalProfileId) with the empty doc, wiping the profile when
// the user later switches to it.
//
// The fix is a single `await persistSnapshot(profileId)` added before the early
// return in initializeDocs so the original profile's server state is always in
// IndexedDB before the conflict UI is shown.

test("compare-with switch does not corrupt original profile snapshot (new device)", async () => {
  // This test requires a server snapshot to be present so that syncFrom() returns
  // early without calling persistSnapshot(). Without a server snapshot, syncFrom()
  // pulls deltas and calls persistSnapshot() itself — masking the bug.
  //
  // Three-browser setup:
  //   A  — registers and seeds Default + Work profiles.
  //   B  — logs in with no local bookmarks → no conflict → initializeDocs falls
  //         through and uploads the server snapshot for Default (the key precondition).
  //   C  — fresh device with urlWork in Chrome → logs in → conflict → compare with
  //         Work (0 conflicts) → Continue → switch to Default → assert Default intact.
  //
  // Without the fix, C's initializeDocs finds the server snapshot, loads it, then
  // calls syncFrom(snapshotSeq) which returns early (no new deltas) WITHOUT calling
  // persistSnapshot. The snapshot is never in IndexedDB. handleRecomputeImportDiff
  // then gets null from loadSnapshot and falls back to initDoc() (empty), causing
  // handleResolveImport to persist an empty snapshot for Default. Switching to
  // Default later loads the empty snapshot and wipes Chrome.

  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  // urlDefault: only in the Default server profile — must survive the whole flow.
  const urlDefault = `https://example.com/cf-snap-default-${Date.now()}`;
  // urlWork: in both the Work server profile and C's Chrome before login.
  // When C compares with Work, localOnly=0 and serverOnly=0 → "Continue" button.
  const urlWork = `https://example.com/cf-snap-work-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  const C = await launchChromeBrowser(extensionDist);
  try {
    // A registers and seeds the Default profile with urlDefault.
    await A.helper.register(email, password);
    await createBookmark(A.page, { title: "Default Bookmark", url: urlDefault });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // A creates a Work profile with urlWork, then syncs it to the server.
    await A.helper.createProfile("Work");
    await A.helper.switchProfile("Work");
    await createBookmark(A.page, { title: "Work Bookmark", url: urlWork });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // B logs in with an empty Chrome — no conflict. initializeDocs pulls the
    // Default delta (seq=1), applies it, and because it is the first full sync
    // on a new device with no prior server snapshot, uploads a server snapshot
    // for Default at seq=1. This is the precondition for the bug: without a
    // server snapshot, syncFrom always processes deltas and calls persistSnapshot
    // itself, masking the missing call in initializeDocs.
    await B.helper.login(email, password);
    await B.helper.sync(); // ensures the fire-and-forget server snapshot upload has completed

    // C is a fresh device (new tmpdir, empty IndexedDB). Place urlWork in
    // Chrome before logging in so a conflict is detected against Default.
    await createBookmark(C.page, { title: "Work Bookmark", url: urlWork });

    // C logs in. initializeDocs:
    //   • finds the server snapshot uploaded by B → initDoc(snapshot) → Default has urlDefault
    //   • setMeta(lastSeqId-defaultId, 1)
    //   • syncFrom(defaultId, 1, checkImport=true) → no new deltas → returns early WITHOUT persistSnapshot
    //   • computeLocalImportDiff() → localOnly=1 (urlWork in Chrome, not in Default)
    //   • WITHOUT FIX: returns { pendingImport } without calling persistSnapshot
    //     → Default snapshot never lands in IndexedDB
    await C.helper.submit(email, password);
    await C.helper.waitForImportConflict();

    // Switch "Compare with" to Work. localOnly drops to 0 (urlWork is in both
    // Chrome and Work). handleRecomputeImportDiff:
    //   • initDoc() → clears Loro doc
    //   • syncFrom(workId, 0) → loads Work delta
    //   • loadSnapshot(defaultId) → null WITHOUT FIX → falls back to initDoc() (empty)
    await C.helper.compareImportWith("Work");

    // Click "Continue" (button text when localOnly=0). resolveImport sends
    // choice="overwrite", targetProfileId=Work. handleResolveImport calls
    // persistSnapshot(defaultId) — persisting the empty doc WITHOUT FIX.
    await C.page.getByRole("button", { name: "Continue" }).click({ force: true });
    await C.helper.waitForMainView(15_000);

    // C is now on the Work profile. Switch to Default.
    await C.helper.switchProfile("Default");
    await C.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await C.helper.sync();

    // Default must still contain urlDefault. WITHOUT FIX: initializeDocs loads
    // the empty stored snapshot → reconcileBookmarks wipes Chrome → test fails.
    const urlsDefault = (await getAllBookmarks(C.page)).map((b) => b.url);
    expect(urlsDefault, "Default profile bookmark must survive the compare-with flow").toContain(urlDefault);
    expect(urlsDefault).not.toContain(urlWork);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
    await closeBrowser(C);
  }
});

// ── Compare-with diff: duplicate URL counting ─────────────────────────────────
//
// When the user changes the "Compare with" selector in the import conflict modal
// to a secondary profile, any URL that exists in BOTH Chrome and the secondary
// profile should be counted as a duplicate (excluded from both localOnly and
// serverOnly).  Previously only the browser-specific extra roots (Opera speed
// dial, etc.) caused this to miscount, but the URL-set comparison should work
// correctly for standard Chrome.

test("recompute import diff: shared bookmark counted as duplicate not as local-only", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  // urlShared: exists in Chrome (added while B was logged out) AND in the Work profile.
  const urlShared    = `https://example.com/cf-cwdiff-shared-${Date.now()}`;
  // urlServer: in Default profile (triggers the conflict on B's re-login).
  const urlServer    = `https://example.com/cf-cwdiff-server-${Date.now()}`;
  const urlWorkOnly1 = `https://example.com/cf-cwdiff-work1-${Date.now()}`;
  const urlWorkOnly2 = `https://example.com/cf-cwdiff-work2-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    // A registers and pushes a Default bookmark (triggers the conflict for B later).
    await A.helper.register(email, password);
    await createBookmark(A.page, { title: "Server Bookmark", url: urlServer });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // A creates a Work profile and switches into it so the following bookmarks
    // are attributed to Work, not Default.
    await A.helper.createProfile("Work");
    await A.helper.switchProfile("Work");
    await createBookmark(A.page, { title: "Shared",      url: urlShared });
    await createBookmark(A.page, { title: "Work Only 1", url: urlWorkOnly1 });
    await createBookmark(A.page, { title: "Work Only 2", url: urlWorkOnly2 });
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();

    // B logs in — Chrome is empty but Default has urlServer → reconcile adds urlServer
    // to B's Chrome; no conflict (B has no local-only bookmarks yet).
    await B.helper.login(email, password);
    await B.helper.sync();

    // B logs out.  Listeners are detached; Chrome still has urlServer.
    await B.helper.logout();

    // B adds urlShared while logged out — no listener, so it stays unmapped.
    // Chrome on B: {urlServer, urlShared}.
    await createBookmark(B.page, { title: "Shared Bookmark", url: urlShared });

    // B re-submits credentials → storedSnapshot branch detects conflict:
    //   Default comparison: localOnly=1 (urlShared not in Default), serverOnly=0.
    await B.helper.submit(email, password);
    await B.helper.waitForImportConflict();

    // Switch "Compare with" to the Work profile.
    await B.helper.compareImportWith("Work");

    // urlShared is in BOTH Chrome (B) and Work → must be treated as a duplicate.
    // urlServer is only in Chrome (not in Work) → localOnly=1.
    // urlWorkOnly1, urlWorkOnly2 are only in Work → serverOnly=2.
    const diff = await B.helper.getImportDiff();
    expect(diff.localOnly,  "urlShared must be a duplicate; only urlServer is local-only").toBe(1);
    expect(diff.serverOnly, "only the two Work-only URLs should be server-only").toBe(2);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

// ── Locked conflict: pendingChanges modal ──────────────────────────────────────

test("locked conflict → keep changes: local bookmarks preserved after unlock", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urlLocal = `https://example.com/locked-keep-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);
    await A.helper.sync();

    await B.helper.login(email, password);
    await B.helper.sync();

    // Lock B, then add a bookmark while locked (listeners are detached → unmapped).
    await B.helper.lock();
    await createBookmark(B.page, { title: "While Locked", url: urlLocal });

    // Unlock — "Changes made while locked" modal should appear because the
    // extension detects an unmapped Chrome bookmark added during the locked period.
    await B.page.fill("input[type=password]", password);
    await B.page.click("button[type=submit]");
    await B.helper.waitForLockedChanges();

    // Keep the local changes → bookmark merged into the profile.
    await B.helper.keepLockedChanges();
    await B.helper.sync();

    expect((await getAllBookmarks(B.page)).map((b) => b.url)).toContain(urlLocal);

    // Push to server and verify A receives it.
    await A.helper.sync();
    expect((await getAllBookmarks(A.page)).map((b) => b.url)).toContain(urlLocal);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("locked conflict → discard changes: local bookmarks removed after unlock", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const urlLocal = `https://example.com/locked-discard-${Date.now()}`;

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);
    await A.helper.sync();

    await B.helper.login(email, password);
    await B.helper.sync();

    await B.helper.lock();
    await createBookmark(B.page, { title: "While Locked", url: urlLocal });

    await B.page.fill("input[type=password]", password);
    await B.page.click("button[type=submit]");
    await B.helper.waitForLockedChanges();

    // Discard → Chrome is reconciled back to server state; local bookmark gone.
    await B.helper.discardLockedChanges();
    await B.helper.sync();

    expect((await getAllBookmarks(B.page)).map((b) => b.url)).not.toContain(urlLocal);
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});
