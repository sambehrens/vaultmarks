import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  workers: 1, // serial — tests share a server and DB
  retries: 0,
  use: { screenshot: "only-on-failure", video: "off" },
  reporter: [["list"], ["html", { open: "never" }]],
});
