import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { uniqueEmail } from "../helpers/popup";
import { getAllBookmarks } from "../helpers/bookmarks";
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

/** Run a SQL statement in the test Postgres container and return trimmed output. */
function psql(pgContainerId: string, sql: string): string {
  return execFileSync(
    "docker",
    ["exec", pgContainerId, "psql", "-U", "test", "-d", "test", "-tA", "-c", sql],
    { encoding: "utf-8" },
  ).trim();
}

// The server returns at most 500 deltas per /sync/pull page.
const PAGE_SIZE = 500;
const BATCH_SIZE = 60;
const MAX_BOOKMARKS = 1500; // safety cap on the batch loop

test("new device pulls every delta when history exceeds one page", async () => {
  test.setTimeout(480_000);
  const { extensionDist, pgContainerId } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";
  const profileFilter =
    `profile_id IN (SELECT p.id FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.email = '${email}')`;

  const A = await launchChromeBrowser(extensionDist);
  let aClosed = false;
  try {
    await A.helper.register(email, password);

    // Rapid creates can be coalesced into a single delta, so there is no fixed
    // bookmark→delta ratio. Create in batches, flushing each one to the server,
    // until the profile's history spans more than one pull page.
    const countDeltas = () =>
      Number(psql(pgContainerId, `SELECT count(*) FROM deltas WHERE ${profileFilter}`));
    const urls: string[] = [];
    while (countDeltas() <= PAGE_SIZE && urls.length < MAX_BOOKMARKS) {
      const batch = await A.page.evaluate(async ({ start, size }) => {
        const created: string[] = [];
        for (let i = start; i < start + size; i++) {
          const url = `https://example.com/page-${i}`;
          await chrome.bookmarks.create({ parentId: "1", title: `Page ${i}`, url });
          created.push(url);
        }
        return created;
      }, { start: urls.length, size: BATCH_SIZE });
      urls.push(...batch);
      await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
      await A.helper.sync();
    }
    // Final flush so every bookmark A created is on the server.
    await A.page.waitForTimeout(DELTA_ENQUEUE_WAIT);
    await A.helper.sync();
    expect(countDeltas()).toBeGreaterThan(PAGE_SIZE);

    // Stop A so it can't upload a fresh compacted snapshot, then remove any
    // snapshot it already uploaded. B must then rebuild purely from deltas,
    // exercising has_more pagination on /sync/pull.
    await closeBrowser(A);
    aClosed = true;
    psql(pgContainerId, `DELETE FROM profile_snapshots WHERE ${profileFilter}`);

    const B = await launchChromeBrowser(extensionDist);
    try {
      await B.helper.login(email, password);

      // Checked well inside the 60 s poll interval, so a client that stopped
      // after the first page can't be rescued by a later background pull.
      await expect
        .poll(async () => (await getAllBookmarks(B.page)).length, { timeout: 10_000 })
        .toBe(urls.length);
      const bUrls = new Set((await getAllBookmarks(B.page)).map((b) => b.url));
      for (const url of urls) expect(bUrls.has(url)).toBe(true);
    } finally {
      await closeBrowser(B);
    }
  } finally {
    if (!aClosed) await closeBrowser(A);
  }
});
