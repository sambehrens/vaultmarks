import type { Page } from "@playwright/test";

export function uniqueEmail(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
}

export class PopupHelper {
  constructor(private page: Page) {}

  async submit(email: string, password: string): Promise<void> {
    await this.page.fill("input[type=email]:not([disabled])", email);
    await this.page.fill("input[type=password]", password);
    await this.page.click("button[type=submit]");
  }

  async register(email: string, password: string): Promise<void> {
    await this.submit(email, password);
    // Argon2id is slow — wait up to 30s for "Get started" button
    await this.page.waitForSelector("text=Get started", { timeout: 30_000 });
    // Use force:true to bypass actionability checks that can fail in the
    // overflow:hidden/translateZ(0) extension popup container.
    await this.page.getByRole("button", { name: "Get started" }).click({ force: true });
    // Onboarding may do async work (export, etc.) — wait up to 30s for main view
    await this.waitForMainView(30_000);
  }

  async login(email: string, password: string): Promise<void> {
    await this.submit(email, password);
    await this.waitForMainView(30_000);
  }

  async unlock(password: string): Promise<void> {
    await this.page.fill("input[type=password]", password);
    await this.page.click("button[type=submit]");
    await this.waitForMainView(30_000);
  }

  async waitForMainView(timeout = 15_000): Promise<void> {
    // .btn-profile buttons only exist in the main panel when logged in and profiles are loaded
    await this.page.waitForSelector(".btn-profile", { timeout });
  }

  async openSettings(): Promise<void> {
    await this.page.click('button[title="Settings"]');
    await this.page.waitForSelector("text=Account");
  }

  async openManageProfiles(): Promise<void> {
    await this.openSettings();
    await this.page.getByRole("button", { name: /manage profiles/i }).click();
    await this.page.waitForSelector("text=Manage Profiles");
  }

  async reload(): Promise<void> {
    await this.page.reload();
    await this.page.waitForSelector("text=Loading…", { state: "detached", timeout: 15_000 });
  }

  async sync(): Promise<void> {
    await this.page.click('button[title="Sync now"]');
    await this.page.waitForFunction(
      () => !document.querySelector(".btn-icon--spinning"),
      { timeout: 15_000 },
    );
  }

  async lock(): Promise<void> {
    await this.openSettings();
    await this.page.click("text=Lock");
    await this.page.waitForSelector("input[type=email][disabled]");
  }

  async logout(): Promise<void> {
    await this.openSettings();
    await this.page.getByRole("button", { name: /^sign out$/i }).click({ force: true });
    await this.page.waitForSelector("input[type=email]:not([disabled])");
  }

  async deleteAccount(password = "test-password-123"): Promise<void> {
    await this.openSettings();
    await this.page.getByRole("button", { name: /account security/i }).click();
    await this.page.waitForSelector("text=Account Security");
    await this.page.click("text=Delete account and all data");
    await this.page.fill('input[type=password][placeholder*="confirm"]', password);
    await this.page.getByRole("button", { name: "Permanently delete" }).click({ force: true });
    await this.page.waitForSelector("input[type=email]:not([disabled])", { timeout: 30_000 });
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.openSettings();
    await this.page.getByRole("button", { name: /account security/i }).click();
    await this.page.waitForSelector("text=Account Security");
    await this.page.fill('input[placeholder="Current password"]', currentPassword);
    await this.page.fill('input[placeholder="New password"]', newPassword);
    await this.page.fill('input[placeholder="Confirm new password"]', newPassword);
    await this.page.getByRole("button", { name: "Change password" }).click({ force: true });
    await this.page.waitForSelector("text=Password changed successfully.", { timeout: 30_000 });
  }

  async createProfile(name: string): Promise<void> {
    await this.waitForMainView();
    await this.page.click("text=+ Add");
    await this.page.fill('input[placeholder="Profile name"]', name);
    await this.page.click("text=Add");
    await this.page.waitForSelector(`text=${name}`);
  }

  async switchProfile(name: string): Promise<void> {
    await this.page.click(`button:has-text("${name}")`);
    // Wait for the profile button to become active, which happens after the
    // background's SWITCH_SUCCESS response is received and the popup re-renders.
    await this.page.waitForSelector(`.btn-profile--active:has-text("${name}")`, { timeout: 15_000 });
  }

  async renameProfile(currentName: string, newName: string): Promise<void> {
    await this.openManageProfiles();
    // Click the Rename button for the matching row
    const row = this.page
      .locator("div")
      .filter({ hasText: currentName })
      .filter({ has: this.page.getByRole("button", { name: "Rename" }) })
      .first();
    await row.getByRole("button", { name: "Rename" }).click();
    // After clicking, the Rename button is replaced by an inline edit form.
    // The row filter no longer matches (Rename button gone), so find the input directly.
    const input = this.page.locator("input[type=text][autofocus]");
    await input.clear();
    await input.fill(newName);
    await this.page.getByRole("button", { name: "Save" }).click();
    await this.page.waitForSelector(`text=${newName}`);
    await this.reload();
  }

  async getProfileNames(): Promise<string[]> {
    await this.waitForMainView();
    return this.page.locator(".btn-profile").allTextContents();
  }

  async getActiveProfileName(): Promise<string | null> {
    return this.page.locator(".btn-profile--active").textContent();
  }

  /** Retrieve a profile's ID by name via GET_STATUS (runs in the popup context). */
  async getProfileId(name: string): Promise<string> {
    return this.page.evaluate(
      (n) =>
        new Promise<string>((resolve) =>
          chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res: any) =>
            resolve(res.profiles.find((p: any) => p.name === n)?.id ?? ""),
          ),
        ),
      name,
    );
  }

  // ── Import conflict: compare-with and diff reading ────────────────────────

  /**
   * Change the "Compare with" profile selector to `profileName` and wait for
   * the recompute to finish (the diff list disappears then reappears).
   */
  async compareImportWith(profileName: string): Promise<void> {
    await this.page.locator("form select").first().selectOption({ label: profileName });
    // The list is hidden while importRecomputingDiff is true, then reappears.
    try {
      await this.page.locator("form ul").waitFor({ state: "detached", timeout: 1_000 });
    } catch {
      // Recompute was too fast — ul never detached; proceed directly.
    }
    await this.page.locator("form ul").waitFor({ state: "attached", timeout: 10_000 });
  }

  /** Read the localOnly/serverOnly counts currently shown in the diff summary. */
  async getImportDiff(): Promise<{ localOnly: number; serverOnly: number }> {
    const text = await this.page.locator("form ul").textContent() ?? "";
    const localMatch = text.match(/(\d+) bookmarks? only in this browser/);
    const serverMatch = text.match(/(\d+) bookmarks? only in your account/);
    return {
      localOnly: localMatch ? parseInt(localMatch[1]) : 0,
      serverOnly: serverMatch ? parseInt(serverMatch[1]) : 0,
    };
  }

  // ── Import conflict modal ("Bookmark conflict") ────────────────────────────

  /** Wait for the import-conflict modal to appear. */
  async waitForImportConflict(timeout = 30_000): Promise<void> {
    await this.page.waitForSelector("text=Bookmark conflict", { timeout });
  }

  /** Resolve: overwrite Chrome with the server profile (default selection). */
  async resolveImportOverwrite(): Promise<void> {
    await this.page.click("text=Use account's bookmarks");
    await this.page.getByRole("button", { name: "Confirm" }).click({ force: true });
    await this.waitForMainView(15_000);
  }

  /** Resolve: merge local Chrome bookmarks into the currently compared profile. */
  async resolveImportMerge(): Promise<void> {
    await this.page.locator('label:has-text("Merge into")').click();
    await this.page.getByRole("button", { name: "Confirm" }).click({ force: true });
    await this.waitForMainView(15_000);
  }

  /**
   * Resolve: switch "Compare with" to profileName, then merge local Chrome
   * bookmarks into that profile. The merge target is always the compared profile.
   */
  async resolveImportMergeInto(profileName: string): Promise<void> {
    await this.compareImportWith(profileName);
    await this.page.locator('label:has-text("Merge into")').click();
    await this.page.getByRole("button", { name: "Confirm" }).click({ force: true });
    await this.waitForMainView(15_000);
  }

  /** Resolve: save local Chrome bookmarks as a new named profile. */
  async resolveImportNewProfile(name: string): Promise<void> {
    await this.page.click("text=Save as new profile");
    const nameInput = this.page.locator('input[placeholder="Profile name"]');
    await nameInput.clear();
    await nameInput.fill(name);
    await this.page.getByRole("button", { name: "Confirm" }).click({ force: true });
    await this.waitForMainView(15_000);
  }

  // ── Locked-changes modal ("Changes made while locked") ─────────────────────

  /** Wait for the locked-changes modal to appear. */
  async waitForLockedChanges(timeout = 15_000): Promise<void> {
    await this.page.waitForSelector("text=Changes made while locked", { timeout });
  }

  /** Resolve: keep local Chrome bookmarks (merge into profile and sync). */
  async keepLockedChanges(): Promise<void> {
    await this.page.click("text=Keep my changes");
    await this.waitForMainView(15_000);
  }

  /** Resolve: discard local Chrome bookmarks and restore server state. */
  async discardLockedChanges(): Promise<void> {
    await this.page.click("text=Discard changes");
    await this.waitForMainView(15_000);
  }
}
