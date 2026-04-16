import { test, expect } from "../fixtures";
import { PopupHelper, uniqueEmail } from "../helpers/popup";

test.beforeEach(async ({ popupPage }) => {
  const email = uniqueEmail();
  const password = "test-password-123";
  const helper = new PopupHelper(popupPage);
  await helper.register(email, password);
});

test("initial profile exists after registration", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  const names = await helper.getProfileNames();
  expect(names).toHaveLength(1);
});

test("can create a new profile", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  await helper.createProfile("Work");
  const names = await helper.getProfileNames();
  expect(names).toContain("Work");
});

test("can switch profiles", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  await helper.createProfile("Work");
  await helper.switchProfile("Work");
  const active = await helper.getActiveProfileName();
  expect(active?.trim()).toBe("Work");
});

test("can rename a profile", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  await helper.renameProfile("Default", "Personal");
  const names = await helper.getProfileNames();
  expect(names.some((n) => n.trim() === "Personal")).toBe(true);
  expect(names.some((n) => n.trim() === "Default")).toBe(false);
});

test("can delete a non-active profile", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  await helper.createProfile("Temp");
  await helper.openManageProfiles();

  // Find the row for "Temp" and click Delete
  const row = popupPage
    .locator("div")
    .filter({ hasText: "Temp" })
    .filter({ has: popupPage.locator('[title="Delete profile"]') })
    .first();
  await row.locator('[title="Delete profile"]').click();

  // Confirm the deletion
  await popupPage.click("text=Confirm Delete");

  // "Temp" profile button should disappear (polls until gone, avoids strict mode issues)
  await expect(popupPage.locator(".btn-profile").filter({ hasText: "Temp" })).toHaveCount(0, { timeout: 15_000 });
});

test("delete button is disabled for the active profile", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  await helper.openManageProfiles();

  // The trash button for the active profile has a distinct title and is disabled
  const firstDeleteBtn = popupPage.locator(".btn-action-icon--danger").first();
  await expect(firstDeleteBtn).toBeDisabled();
});

// ── Keyboard shortcut profile switching ───────────────────────────────────────

test("popup updates active profile when background sends PROFILE_SWITCHED push", async ({ popupPage, context }) => {
  const helper = new PopupHelper(popupPage);
  await helper.createProfile("Work");

  const workId = await helper.getProfileId("Work");
  expect(workId).not.toBe("");

  // Simulate the push the background command handler sends after a keyboard shortcut
  // switch. The popup must update its active-profile indicator without any click.
  const sw = context.serviceWorkers()[0];
  await sw.evaluate((profileId: string) => {
    chrome.runtime.sendMessage({ type: "PROFILE_SWITCHED", profileId });
  }, workId);

  await expect(popupPage.locator(".btn-profile--active")).toContainText("Work", { timeout: 5_000 });
});

test("keyboard shortcut hint is visible when multiple profiles exist", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  await helper.createProfile("Work");
  await expect(popupPage.getByText("Alt+Shift+J / K to switch profiles")).toBeVisible();
});

test("keyboard shortcut hint is hidden when only one profile exists", async ({ popupPage }) => {
  await expect(popupPage.getByText("Alt+Shift+J / K to switch profiles")).not.toBeVisible();
});
