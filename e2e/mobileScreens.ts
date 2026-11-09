import { expect, type Page } from "@playwright/test";

/** Flagship 5, step 6 — the patient app's six busiest screens on a phone (docs/MOBILE_ACCESSIBILITY.md). */
export const MOBILE_SCREENS: { name: string; path: string }[] = [
  { name: "home", path: "/patient" },
  { name: "timeline", path: "/patient/records" },
  { name: "upload", path: "/patient/documents" },
  { name: "booking", path: "/patient/doctors" },
  { name: "family switcher", path: "/patient/household" },
  { name: "insurance status", path: "/patient/insurance" },
];

/** The screen has drawn its heading and finished loading its data. */
export async function screenReady(page: Page, timeout?: number) {
  const main = page.locator("main#main");
  await expect(main.getByRole("heading").first()).toBeVisible({ timeout });
  await expect(main.getByText(/^Loading/)).toHaveCount(0, { timeout });
}
