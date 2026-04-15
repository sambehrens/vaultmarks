import { test as base, chromium, expect } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const STATE_FILE = path.join(__dirname, "../.test-state.json");

interface TestState {
  serverPort: number;
  serverPid: number;
  extensionDist: string;
  pgContainerId: string;
}

function readState(): TestState {
  const raw = fs.readFileSync(STATE_FILE, "utf-8");
  return JSON.parse(raw) as TestState;
}

interface ExtensionFixtures {
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  extensionId: string;
  popupPage: import("@playwright/test").Page;
}

export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const { extensionDist } = readState();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-ext-"));

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionDist}`,
        `--load-extension=${extensionDist}`,
      ],
    });

    await use(context);

    await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  },

  extensionId: async ({ context }, use) => {
    // Wait for the service worker to appear
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent("serviceworker");
    }
    const extensionId = new URL(sw.url()).hostname;
    await use(extensionId);
  },

  popupPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    // Wait for the loading indicator to disappear
    await page.waitForSelector("text=Loading…", { state: "detached", timeout: 15_000 });
    await use(page);
    await page.close();
  },
});

export { expect };
