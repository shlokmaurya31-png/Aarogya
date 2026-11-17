import { defineConfig, devices } from "@playwright/test";

/**
 * Flagship 5, step 6a — the patient app on a low-end phone and a slow network
 * (`npm run perf:mobile`, through scripts/e2e-smoke.ts like the browser
 * journeys). Budgets and method: docs/MOBILE_ACCESSIBILITY.md §2.
 */
export default defineConfig({
  testDir: "e2e-mobile",
  timeout: 600_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: process.env.E2E_BASE_URL, trace: "off" },
  projects: [{ name: "moto-g", use: { ...devices["Moto G4"], browserName: "chromium" } }],
});
