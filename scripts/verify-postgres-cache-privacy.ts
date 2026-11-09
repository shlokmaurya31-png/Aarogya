/**
 * Flagship 4 (3) — the main app's cache keeps nothing private.
 *
 *   1. public/sw.js, run in a sandbox with a fake Cache Storage and network:
 *      a signed-in page's HTML, an API response, a React Server Component
 *      payload, a public page sent no-store (a signed-in visitor), a
 *      redirected or query-string page: never cached. A public page sent
 *      cacheable and the static files: cached. Offline, a signed-in page
 *      gets the offline page, never a stored copy. A 401 from the API and the
 *      "clear" message empty the app's caches; activating drops older
 *      versions of its own cache and leaves the ward tablet's alone.
 *   2. Over HTTP (next start): every signed-in response — a page, its RSC
 *      payload, the public home page, an API call — and every API response
 *      (even a 401) is Cache-Control no-store; logout also sends
 *      Clear-Site-Data "cache"; /sw.js is always fetched fresh; Next's
 *      immutable static files are left cacheable.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { prisma } from "../src/lib/db";
import { startServer, loginAs } from "./lib/appServer";

const STAFF_PASSWORD = "Hospital@123";
const ORIGIN = "https://app.aarogya.test";
const SECRET = "Asha Cachecheck UHID-PUN-77";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

// ---------------------------------------------------------------- the sandbox

type Store = Map<string, Map<string, Response>>;
type Route = { status?: number; headers?: Record<string, string>; body?: string; redirected?: boolean };

function makeSandbox() {
  const store: Store = new Map();
  const routes = new Map<string, Route>();
  let online = true;
  const listeners = new Map<string, (e: unknown) => void>();
  const keyOf = (r: Request | string) => (typeof r === "string" ? new URL(r, ORIGIN).href : r.url);
  const wrap = (r: Route) => {
    const res = new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers ?? {} });
    Object.defineProperty(res, "type", { value: "basic" });
    Object.defineProperty(res, "redirected", { value: Boolean(r.redirected) });
    return res;
  };
  const cacheOf = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name)!;
    return {
      put: async (req: Request | string, res: Response) => void m.set(keyOf(req), res),
      match: async (req: Request | string) => m.get(keyOf(req))?.clone(),
      addAll: async (urls: string[]) => { for (const u of urls) m.set(keyOf(u), wrap(routes.get(new URL(u, ORIGIN).pathname) ?? { body: "static" })); },
    };
  };
  const caches = {
    open: async (name: string) => cacheOf(name),
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
    match: async (req: Request | string) => {
      for (const m of store.values()) { const hit = m.get(keyOf(req)); if (hit) return hit.clone(); }
      return undefined;
    },
  };
  const fetchStub = async (req: Request | string) => {
    if (!online) throw new TypeError("Failed to fetch");
    const url = new URL(keyOf(req));
    const r = routes.get(url.pathname + url.search) ?? routes.get(url.pathname);
    return wrap(r ?? { status: 404 });
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const context = vm.createContext({ self, caches, fetch: fetchStub, URL, Request, Response, Promise, console });
  vm.runInContext(readFileSync(path.resolve(__dirname, "..", "public", "sw.js"), "utf8"), context);

  async function lifecycle(type: "install" | "activate") {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  async function message(data: unknown) {
    const waits: Promise<unknown>[] = [];
    listeners.get("message")!({ data, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  /** Dispatches a fetch; returns the response the worker gave, or null when it let the browser handle it. */
  async function request(pathname: string, init: { mode?: RequestMode; headers?: Record<string, string> } = {}) {
    const req = new Request(new URL(pathname, ORIGIN), { headers: init.headers });
    if (init.mode) Object.defineProperty(req, "mode", { value: init.mode });
    const responded: { p: Promise<Response> | null } = { p: null };
    const waits: Promise<unknown>[] = [];
    listeners.get("fetch")!({ request: req, respondWith: (p: Promise<Response>) => (responded.p = p), waitUntil: (p: Promise<unknown>) => waits.push(p) });
    const res = responded.p ? await responded.p : null;
    // Writes are waitUntil'd after the response settles; let them land.
    await new Promise((r) => setTimeout(r, 0));
    await Promise.all(waits);
    return res;
  }
  /** Every stored entry, as cache → url → body. */
  async function dump() {
    const out: { cache: string; url: string; body: string }[] = [];
    for (const [cache, m] of store) for (const [url, res] of m) out.push({ cache, url, body: await res.clone().text() });
    return out;
  }
  return { store, routes, lifecycle, message, request, dump, setOnline: (v: boolean) => (online = v) };
}

async function serviceWorker() {
  const sw = makeSandbox();
  const PRIVATE = { "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate" };
  sw.routes.set("/offline.html", { body: "<h1>You're offline</h1>", headers: { "cache-control": "public, max-age=0" } });
  // Left from the old worker: a cached chart page, and the ward tablet's cache.
  sw.store.set("aarogya-shell-v2", new Map([[`${ORIGIN}/hospital-os/doctor/patients/p1`, new Response(SECRET)]]));
  sw.store.set("aarogya-ward-v1", new Map([[`${ORIGIN}/ward`, new Response("ward app shell")]]));
  await sw.lifecycle("install");
  await sw.lifecycle("activate");
  report("Activating drops the old worker's cache (it held a signed-in page) and keeps the ward tablet's", !sw.store.has("aarogya-shell-v2") && sw.store.has("aarogya-ward-v1") && sw.store.has("aarogya-shell-v3"));

  sw.routes.set("/hospital-os/doctor/patients/p1", { body: `<html>${SECRET}</html>`, headers: PRIVATE });
  const chart = await sw.request("/hospital-os/doctor/patients/p1", { mode: "navigate" });
  sw.routes.set("/hospital-os/doctor/patients/p1?_rsc=1a2b", { body: `0:${SECRET}`, headers: PRIVATE });
  const rsc = await sw.request("/hospital-os/doctor/patients/p1?_rsc=1a2b", { mode: "cors", headers: { RSC: "1" } });
  sw.routes.set("/api/hospital/patients", { body: JSON.stringify({ patients: [{ name: SECRET }] }), headers: { "cache-control": "no-store" } });
  const api = await sw.request("/api/hospital/patients", { mode: "cors" });
  // A route serving a cacheable file still isn't kept unless it's under a static prefix.
  sw.routes.set("/api/storage/download", { body: SECRET, headers: { "cache-control": "public, max-age=600" } });
  await sw.request("/api/storage/download", { mode: "cors" });
  sw.routes.set("/patient/records/r1.pdf", { body: SECRET, headers: { "cache-control": "public, max-age=600" } });
  await sw.request("/patient/records/r1.pdf", { mode: "no-cors" });
  report("A signed-in page, its RSC payload, API responses and route-served files: passed through, never cached", Boolean(chart && (await chart.text()).includes(SECRET)) && rsc === null && Boolean(api) && !(await sw.dump()).some((e) => e.body.includes(SECRET)));

  sw.routes.set("/", { body: `<html>Welcome back, ${SECRET}</html>`, headers: PRIVATE });
  await sw.request("/", { mode: "navigate" });
  sw.routes.set("/platform/doctors", { body: "<html>For doctors</html>", headers: { "cache-control": "s-maxage=31536000" } });
  sw.routes.set("/platform/doctors?ref=mail", { body: "<html>For doctors</html>", headers: { "cache-control": "s-maxage=31536000" } });
  await sw.request("/platform/doctors?ref=mail", { mode: "navigate" });
  sw.routes.set("/standards/abdm", { body: "x", redirected: true, headers: { "cache-control": "s-maxage=31536000" } });
  await sw.request("/standards/abdm", { mode: "navigate" });
  let urls = (await sw.dump()).map((e) => e.url.replace(ORIGIN, ""));
  report("A public page sent no-store (a signed-in visitor's home page), with a query string, or redirected: not cached", !urls.includes("/") && !urls.some((u) => u.startsWith("/platform") || u.startsWith("/standards")), urls.join(","));

  await sw.request("/platform/doctors", { mode: "navigate" });
  sw.routes.set("/_next/static/chunks/app-1.js", { body: "js", headers: { "cache-control": "public, max-age=31536000, immutable" } });
  await sw.request("/_next/static/chunks/app-1.js", { mode: "no-cors" });
  urls = (await sw.dump()).filter((e) => e.cache === "aarogya-shell-v3").map((e) => e.url.replace(ORIGIN, ""));
  report("A public page sent cacheable and a static file: cached", urls.includes("/platform/doctors") && urls.includes("/_next/static/chunks/app-1.js"), urls.join(","));

  sw.setOnline(false);
  const offlineChart = await sw.request("/hospital-os/doctor/patients/p1", { mode: "navigate" });
  const offlinePublic = await sw.request("/platform/doctors", { mode: "navigate" });
  report("Offline: a signed-in page gets the offline page; a public page its stored copy", Boolean(offlineChart && (await offlineChart.text()).includes("offline")) && Boolean(offlinePublic && (await offlinePublic.text()).includes("For doctors")));
  sw.setOnline(true);

  sw.routes.set("/api/patient/me", { status: 401, body: JSON.stringify({ error: "Not signed in" }), headers: { "cache-control": "no-store" } });
  await sw.request("/api/patient/me", { mode: "cors" });
  report("A 401 from the API (the session ended) clears the app's caches, not the ward tablet's", [...sw.store.keys()].join(",") === "aarogya-ward-v1", [...sw.store.keys()].join(","));

  await sw.request("/platform/doctors", { mode: "navigate" });
  await sw.message({ type: "aarogya:clear-caches" });
  report("The clear message (logout, a sign-in page) clears them too", [...sw.store.keys()].join(",") === "aarogya-ward-v1");
}

// ------------------------------------------------------------------- over HTTP

async function overHttp() {
  const { base, child, serverLog } = await startServer();
  try {
    const noStore = (res: Response) => /no-store/.test(res.headers.get("cache-control") ?? "");
    const doctor = await loginAs(base, "doctor1@amc-demo.aarogya", STAFF_PASSWORD);
    const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: "fac-amc-pune" }, select: { id: true } });
    const get = (url: string, headers: Record<string, string> = {}) => fetch(base + url, { headers, redirect: "manual" });

    const signedIn = {
      chart: await get(`/hospital-os/doctor/patients/${patient.id}`, { cookie: doctor }),
      rsc: await get(`/hospital-os/doctor/patients/${patient.id}?_rsc=gate`, { cookie: doctor, RSC: "1" }),
      home: await get("/", { cookie: doctor }),
      publicPage: await get("/platform/doctors", { cookie: doctor }),
      api: await get(`/api/hospital/patients`, { cookie: doctor }),
    };
    const failing = Object.entries(signedIn).filter(([, r]) => !noStore(r)).map(([k, r]) => `${k}: ${r.status} ${r.headers.get("cache-control")}`);
    report("Signed in: the chart page, its RSC payload, the home page, a public page and the API are all no-store", failing.length === 0, failing.join("; ") || undefined);

    const anonApi = await get("/api/hospital/patients");
    report("An API response with no session (401) is no-store too", anonApi.status === 401 && noStore(anonApi), `${anonApi.status} ${anonApi.headers.get("cache-control")}`);

    const anonPublic = await get("/platform/doctors");
    report("A public page with no session is not marked private", anonPublic.status === 200 && !/private|no-store/.test(anonPublic.headers.get("cache-control") ?? ""), anonPublic.headers.get("cache-control") ?? "none");

    const html = await (await get("/platform/doctors")).text();
    const asset = html.match(/\/_next\/static\/[^"']+\.js/)?.[0];
    const assetRes = asset ? await get(asset, { cookie: doctor }) : null;
    report("Next's static files stay immutable, signed in or not", Boolean(assetRes && /immutable/.test(assetRes.headers.get("cache-control") ?? "")), assetRes?.headers.get("cache-control") ?? "no asset found");

    const sw = await get("/sw.js");
    report("/sw.js is always fetched fresh and is the new worker", /no-cache/.test(sw.headers.get("cache-control") ?? "") && (await sw.text()).includes("aarogya-shell-v3"));

    const logout = await fetch(base + "/api/scholar-auth/logout", { method: "POST", headers: { cookie: doctor } });
    report("Logout sends Clear-Site-Data \"cache\" (not \"storage\": the ward tablet's store stays) and no-store", logout.status === 200 && logout.headers.get("clear-site-data") === '"cache"' && noStore(logout), `${logout.status} ${logout.headers.get("clear-site-data")}`);
  } catch (e) {
    console.error(serverLog().slice(-3000));
    throw e;
  } finally {
    child.kill("SIGTERM");
  }
}

async function main() {
  await serviceWorker();
  await overHttp();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
