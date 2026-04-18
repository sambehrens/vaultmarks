import * as fs from "fs";
import * as path from "path";
import { test, expect } from "../fixtures";
import { PopupHelper, uniqueEmail } from "../helpers/popup";
import { launchChromeBrowser, closeBrowser } from "../helpers/browser";

const STATE_FILE = path.join(__dirname, "../.test-state.json");
function readState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as { extensionDist: string };
}

test("new user is registered automatically", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  const email = uniqueEmail();

  await helper.register(email, "test-password-123");

  await expect(popupPage.locator(".btn-profile").first()).toBeVisible();
});

test("existing user can log in", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  const email = uniqueEmail();
  const password = "test-password-123";

  await helper.register(email, password);
  await helper.logout();
  await helper.login(email, password);

  await expect(popupPage.locator(".btn-profile").first()).toBeVisible();
});

test("wrong password shows an error", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  const email = uniqueEmail();

  await helper.register(email, "correct-password-123");
  await helper.logout();
  await helper.submit(email, "wrong-password-456");

  // Some error text should appear
  const errorLocator = popupPage.locator("[class*=error], [role=alert], .error").first();
  await expect(errorLocator).toBeVisible({ timeout: 30_000 });
});

test("user can lock and unlock", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  const email = uniqueEmail();
  const password = "test-password-123";

  await helper.register(email, password);
  await helper.lock();

  await expect(popupPage.locator("input[type=email][disabled]")).toBeVisible();

  await helper.unlock(password);

  await expect(popupPage.locator(".btn-profile").first()).toBeVisible();
});

test("user can sign out", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  const email = uniqueEmail();

  await helper.register(email, "test-password-123");
  await helper.logout();

  await expect(popupPage.locator("input[type=email]:not([disabled])")).toBeVisible();
});

test("user can change password without being signed out", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  const email = uniqueEmail();
  const oldPassword = "test-password-123";
  const newPassword = "new-password-456";

  await helper.register(email, oldPassword);
  await helper.changePassword(oldPassword, newPassword);

  await helper.reload();
  await helper.waitForMainView(30_000);

  await helper.logout();
  await helper.login(email, newPassword);

  await expect(popupPage.locator(".btn-profile").first()).toBeVisible();
});

test("delete account: other browsers are signed out on next sync", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);
    await B.helper.login(email, password);

    // A deletes the account — the JWT held by B is now invalid on the server.
    await A.helper.deleteAccount();

    // B clicks sync — the server returns 403 (account deleted), the background
    // logs out and returns LOGOUT_SUCCESS, the popup transitions to login.
    await B.helper.sync();

    await expect(B.page.locator("input[type=email]:not([disabled])")).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("delete account: other browser shows login form immediately on popup open", async () => {
  const { extensionDist } = readState();
  const email = uniqueEmail();
  const password = "test-password-123";

  const A = await launchChromeBrowser(extensionDist);
  const B = await launchChromeBrowser(extensionDist);
  try {
    await A.helper.register(email, password);
    await B.helper.login(email, password);

    // A deletes the account while B's popup is closed.
    await A.helper.deleteAccount();

    // Simulate B closing and reopening the popup — no manual sync click.
    // The startup SYNC fired on popup open should detect the 403, return
    // LOGOUT_SUCCESS, and transition to the login form automatically.
    await B.helper.reload();

    await expect(B.page.locator("input[type=email]:not([disabled])")).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeBrowser(A);
    await closeBrowser(B);
  }
});

test("delete account: returns to login and wipes server data", async ({ popupPage }) => {
  const helper = new PopupHelper(popupPage);
  const email = uniqueEmail();
  const password = "test-password-123";

  await helper.register(email, password);
  await helper.deleteAccount();

  // Should be back at the login form.
  await expect(popupPage.locator("input[type=email]:not([disabled])")).toBeVisible();

  // Submitting the same credentials re-registers (the old account is gone), so
  // the onboarding flow appears instead of the main view with existing profiles.
  await helper.submit(email, password);
  await expect(popupPage.getByRole("button", { name: "Get started" })).toBeVisible({ timeout: 30_000 });
});
