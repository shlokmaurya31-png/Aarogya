import { expect, test, type Page } from "@playwright/test";
import { fixture, signIn } from "./fixture";

/**
 * Flagship 4 (3) — the main app's service worker keeps nothing private: sign
 * in, browse a patient's shared record and their chart with the worker in
 * control, sign out, and Cache Storage holds nothing patient-specific at any
 * point (only public pages and static files), and nothing of the app's after
 * sign-out.
 */
const PUBLIC_OR_STATIC = /^\/(_next\/static\/|icons\/|fonts\/|offline\.html$|$|company(\/|$)|platform(\/|$)|standards(\/|$))/;

async function cacheStorage(page: Page) {
  return page.evaluate(async () => {
    const out: { cache: string; path: string; body: string }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        out.push({ cache: name, path: new URL(req.url).pathname, body: res ? await res.text() : "" });
      }
    }
    return out;
  });
}

test("cache privacy: nothing patient-specific in Cache Storage after browsing a chart and signing out", async ({ page }) => {
  const f = fixture();
  await signIn(page, "/login", f.doctor.email, f.password);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  // The worker installs on the first page; wait until it controls the tab.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await page.goto(`/consult/${f.shareId}`);
  await expect(page.getByText(f.patient.name)).toBeVisible();
  await page.goto(`/hospital-os/doctor/patients/${f.patient.patientId}`);
  await page.waitForLoadState("networkidle");
  await page.goto("/hospital-os/doctor/bookings");
  await page.waitForLoadState("networkidle");

  const secrets = [f.patient.name, f.patient.patientId, f.shareId, f.patient.email, f.patient.verifiedPhone];
  const leaks = (entries: Awaited<ReturnType<typeof cacheStorage>>) =>
    entries.filter((e) => !PUBLIC_OR_STATIC.test(e.path) || secrets.some((s) => e.path.includes(s) || e.body.includes(s))).map((e) => `${e.cache} ${e.path}`);

  const signedIn = await cacheStorage(page);
  expect(signedIn.some((e) => e.path.startsWith("/_next/static/")), "the worker is caching static files").toBe(true);
  expect(leaks(signedIn), "while signed in").toEqual([]);

  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForURL((u) => u.pathname === "/hospital-os/login");
  await page.waitForLoadState("networkidle");
  const after = await cacheStorage(page);
  expect(leaks(after), "after sign-out").toEqual([]);
  // Sign-out cleared the app's caches; only static files fetched by the sign-in page since may be back.
  expect(after.filter((e) => !/^\/(_next\/static\/|icons\/|fonts\/|offline\.html$)/.test(e.path)).map((e) => e.path)).toEqual([]);
});
