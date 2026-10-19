import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
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
