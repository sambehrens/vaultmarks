import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { PopupHelper, uniqueEmail } from "../helpers/popup";
import { createBookmark } from "../helpers/bookmarks";

const PASSWORD = "test-password-123";

/**
 * Submit the registration form and wait for the onboarding screen ("Get started"
 * button), but do NOT click it yet — leaves the caller in control of the
 * checkbox and the click timing.
 */
async function registerToOnboarding(page: Page, helper: PopupHelper, email: string): Promise<void> {
  await helper.submit(email, PASSWORD);
  await page.waitForSelector("text=Get started", { timeout: 30_000 });
}

test("no existing bookmarks: does not download a backup on Get started", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  const email = uniqueEmail();

  // Chrome profile has no user bookmarks — do not create any.
  await registerToOnboarding(popupPage, helper, email);

  // The export checkbox must not be shown when there are no bookmarks.
  await expect(popupPage.locator('input[type=checkbox]')).not.toBeVisible();

  // Listen for any download that fires within 5 s of clicking "Get started".
  const downloadPromise = popupPage.waitForEvent("download", { timeout: 5_000 });
  await popupPage.getByRole("button", { name: "Get started" }).click({ force: true });
  await helper.waitForMainView(30_000);

  // No download should have been triggered.
  await expect(downloadPromise).rejects.toThrow();
});

test("existing bookmarks, export checked: downloads a backup on Get started", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  const email = uniqueEmail();

  // Seed a bookmark so the account bootstraps with existing data.
  await createBookmark(popupPage, { title: "Test Bookmark", url: "https://example.com" });

  await registerToOnboarding(popupPage, helper, email);

  // The export checkbox should be visible and checked by default.
  const checkbox = popupPage.locator('input[type=checkbox]');
  await expect(checkbox).toBeVisible();
  await expect(checkbox).toBeChecked();

  // A download must fire when "Get started" is clicked.
  const [download] = await Promise.all([
    popupPage.waitForEvent("download", { timeout: 15_000 }),
    popupPage.getByRole("button", { name: "Get started" }).click({ force: true }),
  ]);

  expect(download.suggestedFilename()).toMatch(/^bookmarks-backup-\d{4}-\d{2}-\d{2}\.html$/);
  await helper.waitForMainView(30_000);
});

test("existing bookmarks, export unchecked: does not download a backup on Get started", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  const email = uniqueEmail();

  await createBookmark(popupPage, { title: "Test Bookmark", url: "https://example.com" });

  await registerToOnboarding(popupPage, helper, email);

  // Uncheck the export option.
  const checkbox = popupPage.locator('input[type=checkbox]');
  await expect(checkbox).toBeVisible();
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();

  const downloadPromise = popupPage.waitForEvent("download", { timeout: 5_000 });
  await popupPage.getByRole("button", { name: "Get started" }).click({ force: true });
  await helper.waitForMainView(30_000);

  await expect(downloadPromise).rejects.toThrow();
});
