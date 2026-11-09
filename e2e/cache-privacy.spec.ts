import { expect, test, type Page } from "@playwright/test";
import { fixture, signIn } from "./fixture";
import { hospitalStep } from "./steps";

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

/** Every IndexedDB database's names, and every value in it as text (the ward store's values are sealed). */
async function indexedDbText(page: Page) {
  return page.evaluate(async () => {
    const out: { db: string; text: string }[] = [];
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      for (const store of Array.from(db.objectStoreNames)) {
        const all = await new Promise<unknown[]>((res) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
        out.push({ db: name, text: JSON.stringify(all) });
      }
      db.close();
    }
    return out;
  });
}

/**
 * Flagship 5b — the ward tablet: its cached shell holds no personal names (the
 * nurse's name loads after sign-in), the patient list is only in the sealed
 * store, and "Hand back the tablet" leaves no staff or patient name in Cache
 * Storage or IndexedDB.
 */
test("cache privacy: the ward shell holds no names, and handing back the tablet leaves none", async ({ page }) => {
  const f = fixture();
  const w = hospitalStep<{ name: string; deviceId: string }>("ward-device");
  await signIn(page, "/login", f.nurse.email, f.password);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.goto("/ward");
  await page.getByLabel("Device code").fill(w.deviceId);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Download my list" }).click();
  await expect(page.getByRole("region", { name: w.name })).toBeVisible();
  await expect(page.getByLabel("Signed in")).toContainText(f.nurse.name);
  // The ward worker now controls the page and has kept its shell; reload so it is the cached copy's turn.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect(page.getByLabel("Signed in")).toContainText(f.nurse.name);

  const names = [f.nurse.name, w.name];
  const nameLeaks = (entries: { where: string; text: string }[]) => entries.filter((e) => names.some((n) => e.text.includes(n))).map((e) => e.where);
  const shell = await cacheStorage(page);
  expect(shell.some((e) => e.cache.startsWith("aarogya-ward") && e.path === "/ward"), "the ward shell is cached").toBe(true);
  expect(nameLeaks(shell.map((e) => ({ where: `${e.cache} ${e.path}`, text: e.body }))), "the cached shell holds no names").toEqual([]);
  const sealed = await indexedDbText(page);
  expect(sealed.some((d) => d.db === "aarogya-ward"), "the list is in the ward store").toBe(true);
  expect(nameLeaks(sealed.map((d) => ({ where: d.db, text: d.text }))), "the ward store holds names only sealed").toEqual([]);

  await page.getByRole("button", { name: "Hand back the tablet" }).click();
  await page.waitForURL((u) => u.pathname === "/hospital-os/login");
  await page.waitForLoadState("networkidle");
  const after = [
    ...(await cacheStorage(page)).map((e) => ({ where: `${e.cache} ${e.path}`, text: `${e.path} ${e.body}` })),
    ...(await indexedDbText(page)).map((d) => ({ where: d.db, text: d.text })),
  ];
  expect(nameLeaks(after), "after handing back the tablet").toEqual([]);
  expect((await cacheStorage(page)).filter((e) => e.cache.startsWith("aarogya-ward")).map((e) => e.path), "the ward cache is gone").toEqual([]);
  expect((await indexedDbText(page)).filter((d) => d.db === "aarogya-ward"), "the ward store is gone").toEqual([]);
});

