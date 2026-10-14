/**
 * Tenancy sweep: no hospital list, search or lookup endpoint returns another
 * facility's rows.
 *
 * Runs against the REAL HTTP surface: it builds the app (unless --no-build),
 * starts `next start` on a free port against DATABASE_URL, and logs in as a
 * dedicated user for EVERY hospital role in each of two facilities (Pune /
 * Noida, same organization; each user is a member of exactly one facility
 * and is not an organization admin). Permissions differ by role, so every
 * request below is made as every role; a role that gets 403 simply doesn't
 * cover that endpoint. Then, for each facility's users:
 *
 *   1. every static GET route under src/app/api/hospital is called
 *      - plainly,
 *      - with every search-like query parameter the route reads set to a
 *        term that matches marker rows seeded in BOTH facilities,
 *      - with ?facilityId=<the other facility> (must not be honoured);
 *   2. every dynamic GET route (/[id]/...) is called with IDs that belong to
 *      the OTHER facility (IDOR probe);
 *   3. idempotency keys: a payment / refund key already used by the other
 *      facility must be refused (409), never replay the other facility's row;
 *   4. medication-link scopes, per role: GLOBAL = platform admin, ORGANIZATION
 *      = org admin, FACILITY = that facility's inventory manager; changes to
 *      GLOBAL / ORGANIZATION links are audited.
 *
 * The assertion is data-driven, not per-endpoint: every row id in every table
 * with a facilityId column is loaded per facility, and a response passes only
 * if it contains no id owned by the other facility. A dropped or overridden
 * facility filter anywhere (spread, OR, optional filter, missing filter)
 * surfaces as a foreign id in some response.
 *
 * Seeds only its own marker rows and users (idempotent). Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-tenancy-sweep.ts [--no-build]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { ItemCategory, Role, UnitOfMeasure } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";

const ROOT = path.resolve(__dirname, "..");
const NEXT = path.join(ROOT, "node_modules", ".bin", "next");
const API_ROOT = path.join(ROOT, "src", "app", "api", "hospital");
const FACILITIES = { pune: "fac-amc-pune", noida: "fac-amc-noida" } as const;
type Site = keyof typeof FACILITIES;
const PASSWORD = "TenancySweep@123";
const MARKER = "Tenancysweep";
const HOSPITAL_ROLES: Role[] = [
  Role.HOSPITAL_ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECHNICIAN, Role.RADIOLOGY_TECH,
  Role.PHARMACIST, Role.BILLING_STAFF, Role.PROCUREMENT_OFFICER, Role.FRONT_DESK,
];
const SEARCH_PARAMS = /^(q|query|search|term|name|uhid|phone|mobile|mrn|invoiceNumber|sku|code|keyword)$/;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok() { pass++; }
function bad(label: string) { fail++; failures.push(label); console.log(`  ✗ ${label}`); }

// ── data ────────────────────────────────────────────────────────────────

const sweepEmail = (site: Site, role: Role) => `tenancy-sweep-${site}-${role.toLowerCase().replace(/_/g, "-")}@sweep.aarogya`;

const ORG_ADMIN_EMAIL = "tenancy-sweep-org-admin@sweep.aarogya";
const OTHER_ORG_ADMIN_EMAIL = "tenancy-sweep-other-org-admin@sweep.aarogya";
const PLATFORM_ADMIN_EMAIL = "tenancy-sweep-platform-admin@sweep.aarogya";
const OTHER_ORG_ID = "org-tenancy-sweep-other";
const GLOBAL_MED_SKU = "SWEEP-GLOBAL-MED";

/** Users for the medication-link scope checks, plus a global catalog item. */
async function seedLinkActors(password: string) {
  const org = (await prisma.facility.findUniqueOrThrow({ where: { id: FACILITIES.pune } })).organizationId;
  const other = await prisma.organization.upsert({ where: { id: OTHER_ORG_ID }, update: {}, create: { id: OTHER_ORG_ID, name: "Tenancy Sweep Other Org" } });
  const upsertUser = (email: string, role: Role) =>
    prisma.user.upsert({ where: { email }, update: { passwordHash: password, role }, create: { email, displayName: email, role, passwordHash: password } });
  const orgAdmin = await upsertUser(ORG_ADMIN_EMAIL, Role.HOSPITAL_ADMIN);
  await prisma.organizationMembership.upsert({
    where: { userId_organizationId: { userId: orgAdmin.id, organizationId: org } },
    update: { isAdmin: true }, create: { userId: orgAdmin.id, organizationId: org, isAdmin: true },
  });
  const otherAdmin = await upsertUser(OTHER_ORG_ADMIN_EMAIL, Role.HOSPITAL_ADMIN);
  await prisma.organizationMembership.upsert({
    where: { userId_organizationId: { userId: otherAdmin.id, organizationId: other.id } },
    update: { isAdmin: true }, create: { userId: otherAdmin.id, organizationId: other.id, isAdmin: true },
  });
  await upsertUser(PLATFORM_ADMIN_EMAIL, Role.AAROGYA_ADMIN);
  await prisma.item.upsert({
    where: { sku: GLOBAL_MED_SKU }, update: { active: true },
    create: { sku: GLOBAL_MED_SKU, facilityId: null, name: `${MARKER} Global Medication`, category: ItemCategory.MEDICATION, baseUnit: UnitOfMeasure.TABLET },
  });
}

async function seedSweepData() {
  const password = await hashPassword(PASSWORD);
  await seedLinkActors(password);
  for (const site of Object.keys(FACILITIES) as Site[]) {
    const facilityId = FACILITIES[site];
    const facility = await prisma.facility.findUniqueOrThrow({ where: { id: facilityId } });
    for (const role of HOSPITAL_ROLES) {
    const email = sweepEmail(site, role);
    const user = await prisma.user.upsert({
      where: { email },
      update: { passwordHash: password, role },
      create: { email, displayName: `Tenancy Sweep ${site} ${role}`, role, passwordHash: password },
    });
    await prisma.hospitalStaffProfile.upsert({
      where: { userId: user.id },
      update: { facilityId, status: "ACTIVE" },
      create: { userId: user.id, facilityId, displayRole: `Tenancy sweep ${role}`, status: "ACTIVE" },
    });
    await prisma.facilityMembership.upsert({
      where: { userId_facilityId: { userId: user.id, facilityId } },
      update: { isAdmin: role === Role.HOSPITAL_ADMIN },
      create: { userId: user.id, facilityId, isAdmin: role === Role.HOSPITAL_ADMIN },
    });
    // A plain (non-admin) org member: org admins legitimately see every facility.
    await prisma.organizationMembership.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId: facility.organizationId } },
      update: { isAdmin: false },
      create: { userId: user.id, organizationId: facility.organizationId, isAdmin: false },
    });
    }
    // Marker rows that every search below matches, in BOTH facilities.
    await prisma.patient.upsert({
      where: { uhid: `SWEEP-${site.toUpperCase()}-1` },
      update: {},
      create: { uhid: `SWEEP-${site.toUpperCase()}-1`, facilityId, fullName: `${MARKER} Patient ${site}`, sex: "F" },
    });
    await prisma.item.upsert({
      where: { sku: `SWEEP-${site.toUpperCase()}-ITEM` },
      update: {},
      create: { sku: `SWEEP-${site.toUpperCase()}-ITEM`, facilityId, name: `${MARKER} Gauze ${site}`, category: ItemCategory.CONSUMABLE, baseUnit: UnitOfMeasure.PIECE },
    });
  }
}

/**
 * id → table for every row the facility owns: rows of every table with a
 * facilityId column, plus rows of tables scoped through a parent
 * (encounterId / patientId / admissionId / surgeryCaseId ...), resolved
 * by following that foreign key to a table that has facilityId.
 */
async function ownedIds(facilityId: string): Promise<Map<string, string>> {
  const cols = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`;
  const fks = await prisma.$queryRaw<{ table_name: string; column_name: string; ref_table: string }[]>`
    SELECT kcu.table_name, kcu.column_name, ccu.table_name AS ref_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.column_name = 'id'`;
  const columns = new Map<string, Set<string>>();
  for (const c of cols) columns.set(c.table_name, (columns.get(c.table_name) ?? new Set()).add(c.column_name));
  const direct = [...columns].filter(([, c]) => c.has("id") && c.has("facilityId")).map(([t]) => t);
  const owned = new Map<string, string>();
  for (const t of direct) {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text AS id FROM "${t}" WHERE "facilityId" = $1`, facilityId);
    for (const r of rows) owned.set(r.id, t);
  }
  // One hop through a required parent that carries facilityId.
  const directSet = new Set(direct);
  for (const fk of fks) {
    const c = columns.get(fk.table_name)!;
    if (directSet.has(fk.table_name) || !c.has("id") || !directSet.has(fk.ref_table) || fk.column_name === "facilityId") continue;
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT t.id::text AS id FROM "${fk.table_name}" t JOIN "${fk.ref_table}" p ON p.id = t."${fk.column_name}" WHERE p."facilityId" = $1`,
      facilityId
    );
    for (const r of rows) if (!owned.has(r.id)) owned.set(r.id, fk.table_name);
  }
  return owned;
}

// ── routes ──────────────────────────────────────────────────────────────

interface Route { urlPath: string; segments: string[]; params: string[]; methods: string[] }

/** Every hospital route file, with the HTTP methods it exports. */
function getAllRoutes(dir = API_ROOT): Route[] {
  const out: Route[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...getAllRoutes(p));
    else if (name === "route.ts") {
      const src = readFileSync(p, "utf8");
      const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => new RegExp(`export (async function|const) ${m}\\b`).test(src));
      if (methods.length === 0) continue;
      const rel = path.relative(path.join(ROOT, "src", "app"), path.dirname(p)).split(path.sep);
      const params = [...new Set([...src.matchAll(/searchParams\.get\(\s*["'`](\w+)["'`]/g)].map((m) => m[1]))];
      out.push({ urlPath: "/" + rel.join("/"), segments: rel, params, methods });
    }
  }
  return out.sort((a, b) => a.urlPath.localeCompare(b.urlPath));
}
const getRoutes = () => getAllRoutes().filter((r) => r.methods.includes("GET"));

/** A route segment that carries a record ID ([id], [encounterId], …), as opposed to [kind]/[key]. */
const isRecordIdSegment = (seg: string) => /^\[(id|\w+Id)\]$/.test(seg);
const UNKNOWN_ID = "cmtenancysweepunknown00000";

const singular = (s: string) => s.replace(/-/g, "").replace(/ies$/, "y").replace(/(ses|xes)$/, (m) => m.slice(0, -2)).replace(/s$/, "").toLowerCase();

/** For /a/b/[id]/c: pick an id of the other facility from the table best matching "b". */
function fillDynamic(route: Route, byTable: Map<string, string[]>, allTables: Set<string>): string | null {
  const parts: string[] = [];
  for (let i = 0; i < route.segments.length; i++) {
    const seg = route.segments[i];
    const m = /^\[(\w+)\]$/.exec(seg);
    if (!m) { parts.push(seg); continue; }
    // [encounterId] names its table; [id] is named by the segment(s) before it:
    // blood/requests/[id] → BloodRequest, then Request, then *Request.
    const prev = route.segments[i - 1] ?? "";
    const prev2 = route.segments[i - 2] ?? "";
    const wants = m[1] !== "id" && m[1].endsWith("Id")
      ? [singular(m[1].replace(/Id$/, ""))]
      : [singular(prev2) + singular(prev), singular(prev)];
    // An exactly named table with no rows of the other facility means "no
    // data to probe with": skip rather than guess a different table.
    if (wants.some((w) => allTables.has(w) && ![...byTable.keys()].some((t) => t.toLowerCase() === w))) return null;
    const tables = [...byTable.keys()];
    const table =
      wants.map((w) => tables.find((t) => t.toLowerCase() === w)).find(Boolean) ??
      wants.map((w) => tables.find((t) => t.toLowerCase().endsWith(w))).find(Boolean);
    const id = table ? byTable.get(table)![0] : undefined;
    if (!id) return null;
    parts.push(id);
  }
  return "/" + parts.join("/");
}

// ── server ──────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer(): Promise<{ base: string; child: ChildProcess }> {
  if (!process.argv.includes("--no-build") || !existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    console.log("Building the app (next build)…");
    const b = spawnSync(NEXT, ["build"], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    if (b.status !== 0) throw new Error(`next build failed:\n${(b.stdout + b.stderr).slice(-3000)}`);
  }
  const port = await freePort();
  const child = spawn(NEXT, ["start", "-p", String(port)], { cwd: ROOT, env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`next start exited early:\n${log.slice(-2000)}`);
    try {
      await fetch(base + "/api/hospital/patients");
      return { base, child };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  child.kill("SIGTERM");
  throw new Error(`next start did not become ready:\n${log.slice(-2000)}`);
}

let loginCount = 0;
async function loginEmail(base: string, email: string): Promise<string> {
  loginCount++;
  const res = await fetch(base + "/api/scholar-auth/login", {
    method: "POST",
    // A distinct client address per login keeps the per-IP login limit out of the way.
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${Math.floor(loginCount / 250)}.${loginCount % 250}` },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (res.status !== 200 || cookies.length === 0) throw new Error(`login as ${email} failed: HTTP ${res.status} ${await res.text()}`);
  return cookies.join("; ");
}
const login = (base: string, site: Site, role: Role) => loginEmail(base, sweepEmail(site, role));

/** Runs `tasks` with at most `limit` in flight. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    })
  );
  return results;
}

// ── sweep ───────────────────────────────────────────────────────────────

/** Ids in `text` (JSON or not) that the other facility owns. */
function leaks(text: string, foreign: Map<string, string>): string[] {
  const hits = new Set<string>();
  for (const token of text.match(/[A-Za-z0-9_-]{8,}/g) ?? []) {
    const table = foreign.get(token);
    if (table) hits.add(`${table}:${token}`);
  }
  return [...hits];
}

/**
 * Medication-link scopes: GLOBAL = platform admin only, ORGANIZATION = that
 * org's admin only, FACILITY = that facility's inventory manager. Outside the
 * scope's tenant → 404; inside it without the right → 403. Every GLOBAL and
 * ORGANIZATION link writes an audit event.
 */
async function medicationLinkSection(base: string) {
  console.log("\nMedication link scopes:");
  const run = Date.now().toString(36);
  const org = (await prisma.facility.findUniqueOrThrow({ where: { id: FACILITIES.pune } })).organizationId;
  const globalItem = await prisma.item.findUniqueOrThrow({ where: { sku: GLOBAL_MED_SKU } });
  const noidaItem = await prisma.item.findFirstOrThrow({ where: { facilityId: FACILITIES.noida, category: "MEDICATION", active: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }).catch(() =>
    prisma.item.create({ data: { sku: `SWEEP-NOIDA-MED-${run}`, facilityId: FACILITIES.noida, name: `${MARKER} Noida Medication`, category: ItemCategory.MEDICATION, baseUnit: UnitOfMeasure.TABLET } })
  );
  const actors = {
    "noida inventory manager": await login(base, "noida", Role.HOSPITAL_ADMIN),
    "noida doctor": await login(base, "noida", Role.DOCTOR),
    "org admin": await loginEmail(base, ORG_ADMIN_EMAIL),
    "other org's admin": await loginEmail(base, OTHER_ORG_ADMIN_EMAIL),
    "platform admin": await loginEmail(base, PLATFORM_ADMIN_EMAIL),
  };
  type Actor = keyof typeof actors;
  let n = 0;
  const attempt = async (actor: Actor, body: Record<string, unknown>, want: number, label: string) => {
    const res = await fetch(base + "/api/hospital/inventory/medication-links", {
      method: "POST",
      headers: { cookie: actors[actor], "content-type": "application/json" },
      body: JSON.stringify({ drugName: `SweepLinkDrug-${run}-${++n}`, ...body }),
    });
    const text = await res.text();
    if (res.status === want) { ok(); console.log(`  ✓ ${actor}: ${label} → ${want}`); }
    else bad(`medication link: ${actor} ${label} → HTTP ${res.status}, expected ${want} (${text.slice(0, 120)})`);
    return res.status === 200 ? (JSON.parse(text).link as { id: string }) : null;
  };

  // FACILITY
  await attempt("noida inventory manager", { scope: "FACILITY", facilityId: FACILITIES.noida, itemId: noidaItem.id }, 200, "FACILITY link at own facility");
  await attempt("noida inventory manager", { scope: "FACILITY", facilityId: FACILITIES.pune, itemId: globalItem.id }, 404, "FACILITY link at another facility");
  await attempt("noida doctor", { scope: "FACILITY", facilityId: FACILITIES.noida, itemId: noidaItem.id }, 403, "FACILITY link without inventory:item:manage");
  // ORGANIZATION
  await attempt("noida inventory manager", { scope: "ORGANIZATION", organizationId: org, itemId: globalItem.id }, 403, "ORGANIZATION link as a non-admin member");
  await attempt("other org's admin", { scope: "ORGANIZATION", organizationId: org, itemId: globalItem.id }, 404, "ORGANIZATION link for an org it doesn't belong to");
  await attempt("org admin", { scope: "ORGANIZATION", organizationId: org, itemId: noidaItem.id }, 400, "ORGANIZATION link to one facility's item");
  const orgLink = await attempt("org admin", { scope: "ORGANIZATION", organizationId: org, itemId: globalItem.id }, 200, "ORGANIZATION link to a global item");
  // GLOBAL
  await attempt("noida inventory manager", { scope: "GLOBAL", itemId: globalItem.id }, 403, "GLOBAL link");
  await attempt("org admin", { scope: "GLOBAL", itemId: globalItem.id }, 403, "GLOBAL link");
  await attempt("platform admin", { scope: "GLOBAL", itemId: noidaItem.id }, 400, "GLOBAL link to one facility's item");
  const globalLink = await attempt("platform admin", { scope: "GLOBAL", itemId: globalItem.id }, 200, "GLOBAL link to a global item");

  // Every GLOBAL / ORGANIZATION link change is audited.
  for (const [label, link, scope] of [["ORGANIZATION", orgLink, "ORGANIZATION"], ["GLOBAL", globalLink, "GLOBAL"]] as const) {
    if (!link) continue;
    const audit = await prisma.auditEvent.findFirst({ where: { type: "hospital.inventory.medicationLinked", detail: { path: ["linkId"], equals: link.id } } });
    const okAudit = audit !== null && (audit.detail as { scope?: string } | null)?.scope === scope;
    if (okAudit) { ok(); console.log(`  ✓ ${label} link wrote an audit event`); }
    else bad(`medication link: the ${label} link wrote no audit event with scope ${scope}`);
  }

  // Both facilities resolve through the org and global links.
  for (const site of ["pune", "noida"] as Site[]) {
    const res = await fetch(base + "/api/hospital/inventory/medication-links", { headers: { cookie: await login(base, site, Role.PHARMACIST) } }); // PHARMACIST holds inventory:item:view
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(json.links)) { bad(`medication link: ${site} list → HTTP ${res.status} ${JSON.stringify(json).slice(0, 160)}`); continue; }
    const ids = (json.links as { id: string }[]).map((l) => l.id);
    const visible = [orgLink, globalLink].every((l) => !l || ids.includes(l.id));
    if (visible) { ok(); console.log(`  ✓ ${site} sees the organization and global links`); }
    else bad(`medication link: ${site} does not see the organization/global links`);
  }
}

/** Idempotency keys are client-supplied and globally unique; replay must stay in-facility. */
async function idempotencySection(base: string, owned: Record<Site, Map<string, string>>) {
  console.log("\nIdempotency keys across facilities:");
  const cookies = { pune: await login(base, "pune", Role.HOSPITAL_ADMIN), noida: await login(base, "noida", Role.HOSPITAL_ADMIN) };
  const post = async (site: Site, url: string, body: unknown) => {
    const res = await fetch(base + url, { method: "POST", headers: { cookie: cookies[site], "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  const encounter = async (site: Site) =>
    (await prisma.encounter.findFirstOrThrow({ where: { facilityId: FACILITIES[site] }, orderBy: [{ registeredAt: "asc" }, { id: "asc" }], select: { id: true } })).id;
  const run = Date.now().toString(36);

  const payKey = `sweep-pay-${run}`;
  const punePay = await post("pune", "/api/hospital/payments", { encounterId: await encounter("pune"), amountMinor: 1000, method: "CASH", idempotencyKey: payKey });
  if (punePay.status !== 200) bad(`pune payment setup → HTTP ${punePay.status} ${punePay.text.slice(0, 200)}`);
  const punePaymentId = JSON.parse(punePay.text).payment?.id as string | undefined;
  const replay = await post("noida", "/api/hospital/payments", { encounterId: await encounter("noida"), amountMinor: 1000, method: "CASH", idempotencyKey: payKey });
  const payLeak = punePaymentId && replay.text.includes(punePaymentId);
  if (replay.status === 409 && !payLeak) { ok(); console.log("  ✓ payment: pune's key from noida → 409, no pune data"); }
  else bad(`payment: pune's idempotency key reused by noida → HTTP ${replay.status}${payLeak ? " and returned pune's payment" : ""}`);

  const refundKey = `sweep-refund-${run}`;
  let puneRefundId: string | undefined;
  if (punePaymentId) {
    const r = await post("pune", `/api/hospital/payments/${punePaymentId}/refund`, { amountMinor: 100, reason: "tenancy sweep", idempotencyKey: refundKey });
    if (r.status !== 200) bad(`pune refund setup → HTTP ${r.status} ${r.text.slice(0, 200)}`);
    else puneRefundId = JSON.parse(r.text).refund?.id;
  }
  const noidaPay = await post("noida", "/api/hospital/payments", { encounterId: await encounter("noida"), amountMinor: 1000, method: "CASH", idempotencyKey: `sweep-pay-noida-${run}` });
  const noidaPaymentId = noidaPay.status === 200 ? (JSON.parse(noidaPay.text).payment?.id as string) : undefined;
  if (!noidaPaymentId) bad(`noida payment setup → HTTP ${noidaPay.status} ${noidaPay.text.slice(0, 200)}`);
  else {
    const r = await post("noida", `/api/hospital/payments/${noidaPaymentId}/refund`, { amountMinor: 100, reason: "tenancy sweep", idempotencyKey: refundKey });
    const leaked = leaks(r.text, owned.pune);
    if (puneRefundId && r.text.includes(puneRefundId)) leaked.push(`Refund:${puneRefundId}`);
    if (r.status === 409 && leaked.length === 0) { ok(); console.log("  ✓ refund: pune's key from noida → 409, no pune data"); }
    else bad(`refund: pune's idempotency key reused by noida → HTTP ${r.status}${leaked.length ? ` and returned pune rows ${leaked.join(", ")}` : ""}`);
  }
}

async function main() {
  const routes = getRoutes();
  await seedSweepData();
  const owned: Record<Site, Map<string, string>> = { pune: await ownedIds(FACILITIES.pune), noida: await ownedIds(FACILITIES.noida) };
  console.log(`Owned row ids: pune=${owned.pune.size} noida=${owned.noida.size}; GET routes: ${routes.length}`);

  const allTables = new Set(
    (await prisma.$queryRaw<{ t: string }[]>`SELECT lower(tablename) AS t FROM pg_tables WHERE schemaname = 'public'`).map((r) => r.t)
  );
  const { base, child } = await startServer();
  const statuses: Record<string, number> = {};
  const serverErrors = new Set<string>();
  const covered = new Set<string>();
  const allRoutes = getAllRoutes();
  const recordIdProbed = new Set<string>();
  const recordIdSkipped = new Set<string>();
  const recordIdStatuses: Record<string, number> = {};
  const dynamicProbed = new Set<string>();
  const dynamicSkipped: string[] = [];
  try {
    for (const site of ["noida", "pune"] as Site[]) {
      const other: Site = site === "pune" ? "noida" : "pune";
      const cookies = new Map<Role, string>();
      for (const role of HOSPITAL_ROLES) cookies.set(role, await login(base, site, role));
      const foreign = owned[other];
      const byTable = new Map<string, string[]>();
      for (const [id, t] of foreign) byTable.set(t, [...(byTable.get(t) ?? []), id]);
      console.log(`\nAs ${site} users, ${HOSPITAL_ROLES.length} roles (other facility: ${other}, ${foreign.size} foreign ids):`);

      // One probe = one URL, made as every role.
      const probes: { kind: string; url: string; route: string }[] = [];
      for (const route of routes) {
        if (route.segments.some((s) => s.startsWith("["))) {
          const url = fillDynamic(route, byTable, allTables);
          if (url) probes.push({ kind: "IDOR", url, route: route.urlPath });
          else if (site === "noida") dynamicSkipped.push(route.urlPath);
          continue;
        }
        probes.push({ kind: "list", url: route.urlPath, route: route.urlPath });
        const searchable = route.params.filter((p) => SEARCH_PARAMS.test(p));
        if (searchable.length) probes.push({ kind: "search", url: `${route.urlPath}?${new URLSearchParams(searchable.map((p) => [p, MARKER]))}`, route: route.urlPath });
        probes.push({ kind: "cross-facility", url: `${route.urlPath}?facilityId=${FACILITIES[other]}`, route: route.urlPath });
      }

      const tasks = probes.flatMap((probe) =>
        HOSPITAL_ROLES.map((role) => async () => {
          const res = await fetch(base + probe.url, { headers: { cookie: cookies.get(role)! } });
          const text = await res.text();
          statuses[res.status] = (statuses[res.status] ?? 0) + 1;
          if (res.status >= 500) serverErrors.add(`${res.status} ${probe.url} (${role})`);
          if (res.ok) {
            covered.add(`${probe.kind} ${probe.route}`);
            if (probe.kind === "IDOR") dynamicProbed.add(probe.route);
          }
          const found = res.ok ? leaks(text, foreign) : [];
          if (found.length) bad(`${probe.kind} ${probe.url} as ${site}/${role} → HTTP ${res.status} returned ${found.length} ${other} row(s): ${found.slice(0, 5).join(", ")}`);
          else ok();
        })
      );
      await pool(tasks, 8);
      console.log(`  ${tasks.length} requests`);

      // 404 rule: a record-ID route answers an unknown ID and another facility's
      // ID identically, with 404 (or a 400 both hit before the lookup), never
      // a 2xx, a 500 or a record-level 403. A role's missing-permission 403
      // comes before the lookup and is the same for both.
      const recordTasks: (() => Promise<void>)[] = [];
      for (const route of allRoutes) {
        const dyn = route.segments.filter((x) => x.startsWith("["));
        if (dyn.length === 0 || !dyn.every(isRecordIdSegment)) continue;
        const foreignUrl = fillDynamic(route, byTable, allTables);
        if (!foreignUrl) { if (site === "noida") recordIdSkipped.add(route.urlPath); continue; }
        const unknownUrl = "/" + route.segments.map((x) => (x.startsWith("[") ? UNKNOWN_ID : x)).join("/");
        recordIdProbed.add(route.urlPath);
        for (const method of route.methods) {
          for (const role of HOSPITAL_ROLES) {
            recordTasks.push(async () => {
              const call = async (url: string) => {
                const res = await fetch(base + url, {
                  method,
                  headers: { cookie: cookies.get(role)!, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
                  ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
                });
                const text = await res.text();
                let error = "";
                try { error = String(JSON.parse(text).error ?? ""); } catch { /* not JSON */ }
                return { status: res.status, permission: res.status === 403 && error.startsWith("Missing permission"), text };
              };
              const [u, f] = [await call(unknownUrl), await call(foreignUrl)];
              const label = `${method} ${route.urlPath} as ${site}/${role}`;
              const allowed = (r: typeof u) => r.status === 404 || r.permission || (r.status === 400 && method !== "GET") || r.status === 405;
              const problems: string[] = [];
              if (!allowed(u)) problems.push(`unknown id → ${u.status} ${u.text.slice(0, 80)}`);
              if (!allowed(f)) problems.push(`other facility's id → ${f.status} ${f.text.slice(0, 80)}`);
              if (u.status !== f.status) problems.push(`unknown ${u.status} ≠ other facility's ${f.status}`);
              if (problems.length) bad(`404 rule: ${label}: ${problems.join("; ")}`);
              else ok();
              recordIdStatuses[`${u.status}`] = (recordIdStatuses[`${u.status}`] ?? 0) + 1;
            });
          }
        }
      }
      await pool(recordTasks, 8);
      console.log(`  404 rule: ${recordTasks.length} unknown/other-facility pairs`);
    }
    await idempotencySection(base, owned);
    await medicationLinkSection(base);
  } finally {
    child.kill("SIGTERM");
    await prisma.$disconnect();
  }

  console.log(`\nHTTP statuses seen: ${Object.entries(statuses).map(([s, n]) => `${s}×${n}`).join(" ")}`);
  if (serverErrors.size) console.log(`Server errors (not tenancy failures, listed for follow-up): ${[...serverErrors].join(", ")}`);
  const staticRoutes = routes.filter((r) => !r.segments.some((s) => s.startsWith("[")));
  const listCovered = staticRoutes.filter((r) => covered.has(`list ${r.urlPath}`)).length;
  console.log(`Static routes answered 2xx to at least one role: ${listCovered}/${staticRoutes.length}`);
  console.log(`Dynamic routes probed with the other facility's ids: ${routes.length - staticRoutes.length - dynamicSkipped.length} (2xx for ${dynamicProbed.size}, i.e. the rest refused them); skipped (no matching table/data): ${dynamicSkipped.length}`);
  if (dynamicSkipped.length) console.log(`  skipped: ${dynamicSkipped.join(", ")}`);
  console.log(`404 rule: ${recordIdProbed.size} record-ID routes probed (statuses for unknown ids: ${Object.entries(recordIdStatuses).map(([k, v]) => `${k}×${v}`).join(" ")}); skipped (no data): ${recordIdSkipped.size}${recordIdSkipped.size ? ` — ${[...recordIdSkipped].join(", ")}` : ""}`);
  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
