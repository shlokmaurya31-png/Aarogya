/**
 * PHASE D2 — SaaS commercial security, semantics and concurrency verification.
 *
 * Exercises the entitlement evaluator and commercial services directly, with a
 * hostile caller in mind. Properties that must hold regardless of data:
 *
 *   - no cross-organization commercial read (summary/entitlements/usage)
 *   - commercial mutation is platform-only (no self-upgrade, no self-override)
 *   - a facility admin cannot touch the organization subscription
 *   - suspended/expired subscriptions disable premium capabilities (data intact)
 *   - plan edits never change an existing subscriber's snapshot
 *   - overrides raise/lower effective values; facility scope is explicit
 *   - limits are enforced server-side and are race-safe (exactly one of N wins)
 *   - entitlement never bypasses D1 tenancy / C4 authorization
 *
 * Concurrency claims are only meaningful on PostgreSQL. On SQLite the security
 * and semantics assertions still run; the concurrency section reports skipped.
 *
 * Usage (authoritative gate; run against a freshly migrated + seeded DB):
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-commercial-entitlements.ts
 */
import { prisma } from "../src/lib/db";
import { ensureCommercialBootstrap } from "../src/lib/commercial/bootstrap";
import { loadActorMemberships, type ActorMemberships } from "../src/lib/auth/tenantContext";
import { assignPlan, transitionSubscription, cancelSubscription } from "../src/lib/commercial/subscriptions";
import { setOrganizationOverride, removeOrganizationOverride, setFacilityOverride } from "../src/lib/commercial/overrides";
import { setPlanEntitlement } from "../src/lib/commercial/plans";
import { hasEntitlement, resolveLimit, evaluateEntitlement } from "../src/lib/commercial/evaluator";
import { getCommercialSummary } from "../src/lib/commercial/summary";
import { createFacility } from "../src/lib/enterprise/facilities";
import { addOrganizationMembership } from "../src/lib/enterprise/memberships";

const IS_PG = /^postgres/i.test(process.env.DATABASE_URL ?? "");
let pass = 0, fail = 0;
const failures: string[] = [];
function ok(l: string) { pass++; console.log(`  ✓ ${l}`); }
function bad(l: string, d?: string) { fail++; failures.push(l + (d ? ` — ${d}` : "")); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`); }
async function expectAllow(l: string, fn: () => Promise<unknown>) { try { await fn(); ok(l); } catch (e) { bad(l, `unexpected: ${(e as Error).message}`); } }
async function expectDeny(l: string, fn: () => Promise<unknown>, status?: number) {
  try { await fn(); bad(l, "expected denial but SUCCEEDED"); }
  catch (e) { const s = (e as { status?: number }).status; if (status && s !== status) bad(l, `denied ${s}, expected ${status}`); else ok(l); }
}

const ID = {
  orgA: "d2t-org-a", orgB: "d2t-org-b", orgC: "d2t-org-c",
  facA1: "d2t-fac-a1", facB1: "d2t-fac-b1", facC1: "d2t-fac-c1",
  uPlatform: "d2t-u-platform", uAdminA: "d2t-u-admin-a", uAdminB: "d2t-u-admin-b",
  uAdminC: "d2t-u-admin-c", uFacAdminA1: "d2t-u-facadmin-a1", uOutsider: "d2t-u-outsider", uExtra: "d2t-u-extra",
};

async function cleanup() {
  const orgIds = [ID.orgA, ID.orgB, ID.orgC];
  const userIds = Object.values(ID);
  const subs = await prisma.organizationSubscription.findMany({ where: { organizationId: { in: orgIds } }, select: { id: true } });
  await prisma.subscriptionEntitlement.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
  await prisma.organizationSubscription.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.facilityEntitlementOverride.deleteMany({ where: { facility: { organizationId: { in: orgIds } } } });
  await prisma.organizationEntitlementOverride.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.facilityMembership.deleteMany({ where: { OR: [{ facility: { organizationId: { in: orgIds } } }, { userId: { in: userIds } }] } });
  await prisma.organizationMembership.deleteMany({ where: { OR: [{ organizationId: { in: orgIds } }, { userId: { in: userIds } }] } });
  await prisma.auditEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.facility.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function seed() {
  const mkUser = (id: string, role: "AAROGYA_ADMIN" | "HOSPITAL_ADMIN" | "DOCTOR") =>
    prisma.user.create({ data: { id, email: `${id}@d2test.local`, passwordHash: "x", role, displayName: id } });
  await Promise.all([
    mkUser(ID.uPlatform, "AAROGYA_ADMIN"), mkUser(ID.uAdminA, "HOSPITAL_ADMIN"), mkUser(ID.uAdminB, "HOSPITAL_ADMIN"),
    mkUser(ID.uAdminC, "HOSPITAL_ADMIN"), mkUser(ID.uFacAdminA1, "HOSPITAL_ADMIN"), mkUser(ID.uOutsider, "DOCTOR"), mkUser(ID.uExtra, "DOCTOR"),
  ]);
  for (const [org, fac] of [[ID.orgA, ID.facA1], [ID.orgB, ID.facB1], [ID.orgC, ID.facC1]] as const) {
    await prisma.organization.create({ data: { id: org, slug: org, name: org, status: "ACTIVE" } });
    await prisma.facility.create({ data: { id: fac, slug: fac, name: fac, organizationId: org, status: "ACTIVE" } });
  }
  await prisma.organizationMembership.createMany({ data: [
    { userId: ID.uAdminA, organizationId: ID.orgA, isAdmin: true },
    { userId: ID.uAdminB, organizationId: ID.orgB, isAdmin: true },
    { userId: ID.uAdminC, organizationId: ID.orgC, isAdmin: true },
  ]});
  await prisma.facilityMembership.create({ data: { userId: ID.uFacAdminA1, facilityId: ID.facA1, isAdmin: true } });
}

const load = (id: string, role: "AAROGYA_ADMIN" | "HOSPITAL_ADMIN" | "DOCTOR") => loadActorMemberships(id, role);

async function run() {
  console.log(`\nPhase D2 commercial verification (provider: ${IS_PG ? "PostgreSQL" : "SQLite"})\n`);
  await cleanup();
  await ensureCommercialBootstrap();
  await seed();

  const mPlatform = await load(ID.uPlatform, "AAROGYA_ADMIN");
  const mAdminA = await load(ID.uAdminA, "HOSPITAL_ADMIN");
  const mAdminB = await load(ID.uAdminB, "HOSPITAL_ADMIN");
  const mAdminC = await load(ID.uAdminC, "HOSPITAL_ADMIN");
  const mFacAdminA1 = await load(ID.uFacAdminA1, "HOSPITAL_ADMIN");
  const mOutsider = await load(ID.uOutsider, "DOCTOR");

  // Assign plans (platform).
  await assignPlan(mPlatform, { organizationId: ID.orgA, planCode: "professional" });
  await assignPlan(mPlatform, { organizationId: ID.orgB, planCode: "starter" });
  await assignPlan(mPlatform, { organizationId: ID.orgC, planCode: "professional" });

  console.log("[cross-tenant commercial isolation]");
  await expectAllow("org A admin reads OWN commercial state", () => getCommercialSummary(mAdminA, ID.orgA));
  await expectDeny("org A admin cannot read org B commercial state", () => getCommercialSummary(mAdminA, ID.orgB), 404);
  await expectDeny("outsider cannot read org A commercial state", () => getCommercialSummary(mOutsider, ID.orgA), 404);

  console.log("[commercial mutation is platform-only — no self-upgrade / self-grant]");
  await expectDeny("org admin cannot upgrade own plan to enterprise", () => assignPlan(mAdminA, { organizationId: ID.orgA, planCode: "enterprise" }), 403);
  await expectDeny("org admin cannot grant self an override", () => setOrganizationOverride(mAdminA, ID.orgA, { key: "max_facilities", unlimited: true }), 403);
  await expectDeny("facility admin cannot transition the org subscription", () => transitionSubscription(mFacAdminA1, ID.orgA, "SUSPENDED"), 403);
  await expectDeny("org admin cannot transition own subscription", () => transitionSubscription(mAdminA, ID.orgA, "SUSPENDED"), 403);

  console.log("[entitlement semantics]");
  {
    const pharma = await hasEntitlement({ organizationId: ID.orgA, key: "advanced_pharmacy" });
    const nhcx = await hasEntitlement({ organizationId: ID.orgA, key: "nhcx_claims" });
    if (pharma && !nhcx) ok("professional: advanced_pharmacy enabled, nhcx_claims not"); else bad("professional entitlements", `pharma=${pharma} nhcx=${nhcx}`);
    const starterIcu = await hasEntitlement({ organizationId: ID.orgB, key: "icu" });
    if (!starterIcu) ok("starter: icu not included"); else bad("starter icu", "unexpectedly enabled");
    const lim = await resolveLimit({ organizationId: ID.orgA, key: "max_facilities" });
    if (lim.limit === 5 && !lim.unlimited) ok("professional max_facilities = 5"); else bad("professional limit", JSON.stringify(lim));
  }

  console.log("[overrides raise/lower effective value; facility scope explicit]");
  await setOrganizationOverride(mPlatform, ID.orgA, { key: "max_facilities", numberValue: 20 });
  {
    const lim = await resolveLimit({ organizationId: ID.orgA, key: "max_facilities" });
    if (lim.limit === 20) ok("org override raises max_facilities to 20"); else bad("org override", JSON.stringify(lim));
  }
  await removeOrganizationOverride(mPlatform, ID.orgA, "max_facilities");
  {
    const lim = await resolveLimit({ organizationId: ID.orgA, key: "max_facilities" });
    if (lim.limit === 5) ok("removing override restores plan value (5)"); else bad("override removed", JSON.stringify(lim));
  }
  // Facility-scoped override: enable ICU for one facility of the starter org B.
  await setFacilityOverride(mPlatform, ID.facB1, { key: "icu", boolValue: true });
  {
    const orgWide = await hasEntitlement({ organizationId: ID.orgB, key: "icu" });
    const atFacility = await hasEntitlement({ organizationId: ID.orgB, facilityId: ID.facB1, key: "icu" });
    if (!orgWide && atFacility) ok("facility override enables ICU at B1 only (org-wide still off)"); else bad("facility scope", `orgWide=${orgWide} atFacility=${atFacility}`);
  }

  console.log("[plan edits do not change existing subscribers — snapshot immutability]");
  {
    const planPro = await prisma.subscriptionPlan.findUnique({ where: { code: "professional" } });
    await setPlanEntitlement(mPlatform, planPro!.id, { key: "advanced_pharmacy", boolValue: false });
    const stillHas = await hasEntitlement({ organizationId: ID.orgA, key: "advanced_pharmacy" });
    if (stillHas) ok("existing subscriber keeps advanced_pharmacy after the plan edit (snapshot)"); else bad("snapshot immutability", "subscriber lost entitlement");
    // restore
    await setPlanEntitlement(mPlatform, planPro!.id, { key: "advanced_pharmacy", boolValue: true });
  }

  console.log("[commercial state gates premium features]");
  await transitionSubscription(mPlatform, ID.orgA, "SUSPENDED");
  {
    const pharma = await hasEntitlement({ organizationId: ID.orgA, key: "advanced_pharmacy" });
    if (!pharma) ok("SUSPENDED org loses premium capability (advanced_pharmacy=false)"); else bad("suspended gate", "still enabled");
  }
  await transitionSubscription(mPlatform, ID.orgA, "ACTIVE");
  await expectAllow("reactivated org regains capability", async () => {
    if (!(await hasEntitlement({ organizationId: ID.orgA, key: "advanced_pharmacy" }))) throw new Error("still off");
  });

  console.log("[lifecycle & trial]");
  {
    await assignPlan(mPlatform, { organizationId: ID.orgB, planCode: "professional", trial: true });
    const sub = await prisma.organizationSubscription.findUnique({ where: { organizationId: ID.orgB } });
    const days = sub?.trialEndsAt ? (sub.trialEndsAt.getTime() - Date.now()) / 86_400_000 : 0;
    if (sub?.status === "TRIAL" && days > 10 && days < 20) ok("trial dates are server-set (~14 days)"); else bad("trial", JSON.stringify({ status: sub?.status, days }));
  }
  await expectDeny("an undeclared subscription transition is refused", () => transitionSubscription(mPlatform, ID.orgB, "TRIAL"), 400);
  await expectAllow("cancel-at-period-end keeps access", async () => {
    await cancelSubscription(mPlatform, ID.orgC, { immediate: false });
    if (!(await hasEntitlement({ organizationId: ID.orgC, key: "hospital_os" }))) throw new Error("lost access on scheduled cancel");
  });

  console.log("[D2.5 hardening — boundary & lifecycle edge cases]");
  {
    // Facility override must NOT leak across organizations. org B holds blood_bank
    // via its plan snapshot; place a DISABLING facility override on a facility of
    // org C and evaluate it for org B passing org C's facility id — if the foreign
    // override leaked, org B would lose blood_bank. It must not.
    await setFacilityOverride(mPlatform, ID.facC1, { key: "blood_bank", boolValue: false });
    const stillHas = await hasEntitlement({ organizationId: ID.orgB, facilityId: ID.facC1, key: "blood_bank" });
    if (stillHas) ok("facility override does not leak across organizations (foreign facilityId ignored)");
    else bad("facility override cross-org leak", "org B evaluated org C's facility override");
    await prisma.facilityEntitlementOverride.deleteMany({ where: { facilityId: ID.facC1, entitlement: { key: "blood_bank" } } });
  }
  // Cancel-at-period-end with no billing period (org B is on a trial → no period)
  // must be refused rather than silently never taking effect.
  await expectDeny("cancel-at-period-end refused when there is no billing period", () => cancelSubscription(mPlatform, ID.orgB, { immediate: false }), 400);
  {
    // A GRACE window past its end must lapse on read (no cron in this codebase).
    await transitionSubscription(mPlatform, ID.orgA, "PAST_DUE");
    await transitionSubscription(mPlatform, ID.orgA, "GRACE");
    const openGrace = await hasEntitlement({ organizationId: ID.orgA, key: "hospital_os" });
    await prisma.organizationSubscription.update({ where: { organizationId: ID.orgA }, data: { gracePeriodEndsAt: new Date(Date.now() - 86_400_000) } });
    const lapsedGrace = await hasEntitlement({ organizationId: ID.orgA, key: "hospital_os" });
    if (openGrace && !lapsedGrace) ok("grace keeps access while open, lapses once gracePeriodEndsAt passes");
    else bad("grace lazy expiry", `open=${openGrace} lapsed=${lapsedGrace}`);
    await transitionSubscription(mPlatform, ID.orgA, "ACTIVE");
  }

  await concurrency(mPlatform);

  await cleanup();
  console.log(`\n──────────────────────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed  (${IS_PG ? "PostgreSQL" : "SQLite"})`);
  if (fail) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

async function concurrency(mPlatform: ActorMemberships) {
  console.log("[concurrency]");
  if (!IS_PG) { console.log("  · skipped (SQLite serialises writers; run against PostgreSQL for the authoritative race gate)"); return; }
  const mAdminC = await load(ID.uAdminC, "HOSPITAL_ADMIN");

  // 1. Facility limit race: org C has 1 facility, cap it at 2, fire 5 concurrent creates → exactly one succeeds.
  await setOrganizationOverride(mPlatform, ID.orgC, { key: "max_facilities", numberValue: 2 });
  const facResults = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => createFacility(mAdminC, ID.orgC, { name: `d2t race fac ${i}` }))
  );
  const facOk = facResults.filter((r) => r.status === "fulfilled").length;
  const facCount = await prisma.facility.count({ where: { organizationId: ID.orgC, status: { not: "DEACTIVATED" } } });
  if (facCount === 2 && facOk === 1) ok(`facility limit race: exactly one of 5 creates succeeds (total facilities = 2)`);
  else bad("facility limit race", `succeeded=${facOk} total=${facCount}`);

  // 2. User limit race: cap max_users at 2 (org C has 1 org member), fire 5 concurrent adds → exactly one succeeds.
  await setOrganizationOverride(mPlatform, ID.orgC, { key: "max_users", numberValue: 2 });
  const userResults = await Promise.allSettled(
    [ID.uExtra, ID.uOutsider, ID.uAdminA, ID.uAdminB, ID.uFacAdminA1].map((uid) =>
      addOrganizationMembership(mAdminC, { organizationId: ID.orgC, userId: uid, isAdmin: false }))
  );
  const userOk = userResults.filter((r) => r.status === "fulfilled").length;
  const memCount = await prisma.organizationMembership.count({ where: { organizationId: ID.orgC, status: "ACTIVE" } });
  if (memCount === 2 && userOk === 1) ok(`user limit race: exactly one of 5 adds succeeds (total members = 2)`);
  else bad("user limit race", `succeeded=${userOk} total=${memCount}`);

  // 3. Duplicate subscription creation race → one subscription row per org.
  const subResults = await Promise.allSettled(
    Array.from({ length: 6 }, () => assignPlan(mPlatform, { organizationId: ID.orgA, planCode: "professional" }))
  );
  const subOk = subResults.filter((r) => r.status === "fulfilled").length;
  const subCount = await prisma.organizationSubscription.count({ where: { organizationId: ID.orgA } });
  if (subCount === 1) ok(`duplicate subscription race: exactly one subscription row (${subOk}/6 calls ok)`);
  else bad("duplicate subscription race", `rows=${subCount}`);

  // 4. Override creation race → one override row per (org, entitlement).
  const ovResults = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => setOrganizationOverride(mPlatform, ID.orgB, { key: "max_users", numberValue: 100 + i }))
  );
  const ovOk = ovResults.filter((r) => r.status === "fulfilled").length;
  const ovCount = await prisma.organizationEntitlementOverride.count({ where: { organizationId: ID.orgB, entitlement: { key: "max_users" } } });
  if (ovCount === 1) ok(`override upsert race: exactly one override row (${ovOk}/6 calls ok)`);
  else bad("override race", `rows=${ovCount}`);
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
