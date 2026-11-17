import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { LANGUAGES, translate, type LanguageCode } from "../src/lib/i18n";
import { fixture, signIn } from "./fixture";
import { MOBILE_SCREENS, screenReady } from "./mobileScreens";

/**
 * Flagship 5, step 6b — WCAG 2.2 AA on the patient app's six busiest screens
 * (docs/MOBILE_ACCESSIBILITY.md §3), at a low-end phone's width, in every app
 * language: axe finds no violation (contrast, names, labels, focus order,
 * touch targets of 24 px and more); the page's language and direction follow
 * the app language (Urdu right to left); the navigation, sign-out and
 * language picker are named in that language; nothing scrolls sideways.
 */
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });

test("accessibility: six patient screens pass WCAG 2.2 AA (axe) in all 11 languages, named in each, Urdu right to left", async ({ page }) => {
  test.setTimeout(600_000);
  const f = fixture();
  await signIn(page, "/patient/login", f.patient.email, f.password);
  await page.waitForURL((u) => u.pathname === "/patient");
  const failures: string[] = [];
  for (const { code } of LANGUAGES) {
    await page.evaluate((c) => localStorage.setItem("aarogya-language", JSON.stringify({ state: { language: c }, version: 0 })), code);
    for (const screen of MOBILE_SCREENS) {
      await page.goto(screen.path);
      await screenReady(page);
      await expect(page.locator("html")).toHaveAttribute("lang", code);
      await expect(page.locator("html")).toHaveAttribute("dir", code === "ur" ? "rtl" : "ltr");
      const t = (k: string) => translate(k, code as LanguageCode);
      const nav = page.getByRole("navigation", { name: t("patient.nav.label") });
      await expect(nav.getByRole("link", { name: t("patient.nav.insurance"), exact: true })).toBeVisible();
      await expect(nav.getByRole("link", { name: t("patient.nav.documents"), exact: true })).toBeAttached();
      await expect(page.getByRole("banner").getByRole("button", { name: t("patient.signOut"), exact: true })).toBeVisible();
      await expect(page.getByRole("banner").getByRole("combobox", { name: t("patient.language"), exact: true })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) failures.push(`${code} ${screen.name}: scrolls sideways by ${overflow}px`);
      const axe = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
      for (const v of axe.violations) failures.push(`${code} ${screen.name}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
    }
  }
  expect(failures, "WCAG 2.2 AA failures").toEqual([]);
});
