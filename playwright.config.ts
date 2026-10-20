import { defineConfig, devices } from "@playwright/test";

/**
 * Week 4c — browser smoke tests. Run through `npm run e2e:smoke`
 * (scripts/e2e-smoke.ts), which prepares the database and fixture, starts
 * the app and the worker, and sets E2E_BASE_URL and E2E_FIXTURE.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
