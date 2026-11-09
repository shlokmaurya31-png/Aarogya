import { readFileSync } from "node:fs";
import type { Page, Response } from "@playwright/test";
import type { E2eFixture } from "../scripts/lib/e2eFixture";

export function fixture(): E2eFixture {
  const file = process.env.E2E_FIXTURE;
  if (!file) throw new Error("E2E_FIXTURE is not set; run the smoke tests through `npm run e2e:smoke`.");
  return JSON.parse(readFileSync(file, "utf8")) as E2eFixture;
}

/** Signs in on a login form (the patient portal's or the main one): email and password fields, then submit. */
export async function signIn(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('form button[type="submit"]').first().click();
}

/**
 * A response's body for an assertion's failure message, read only when it
 * failed. Signed-in responses are Cache-Control: no-store (Flagship 4, step 3),
 * and Chromium keeps no copy of such a body for the test once the page has
 * read it, so reading it unconditionally would hang a passing test.
 */
export async function bodyIfFailed(r: Response, passed: boolean): Promise<string> {
  return passed ? "" : r.text().catch(() => "(the response body is no longer available)");
}
