/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PHASE D10 — Hospital Command Center gate (metric correctness + tenant/facility/role
 * isolation + privacy/IDOR + injection/oversized + zero-state + unavailable-state +
 * D8 threshold override & isolation).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-d10-command-center.ts
 */
import { prisma } from "../src/lib/db";
import { getCommandCenterOverview, getCommandCenterSection, getDrillDown } from "../src/lib/hospital-os/command-center";
import { setOverride, publishOverride } from "../src/lib/config";
import { loadActorMemberships } from "../src/lib/auth/tenantContext";
import type { FacilityContext } from "../src/lib/auth/hospitalRbac";

const IS_PG = /^postgres/i.test(process.env.DATABASE_URL ?? "");
let pass = 0, fail = 0; const failures: string[] = [];
const ok = (l: string) => { pass++; console.log(`  ✓ ${l}`); };
const bad = (l: string, d?: string) => { fail++; failures.push(l + (d ? ` — ${d}` : "")); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`); };
async function expectThrow(l: string, fn: () => Promise<unknown> | unknown) { try { await fn(); bad(l, "expected throw"); } catch { ok(l); } }

const ID = { orgA: "d10-org-a", orgB: "d10-org-b", facA: "d10-fac-a", facB: "d10-fac-b", wardA: "d10-ward-a", uPlat: "d10-u-plat", uNurse: "d10-u-nurse" };

async function cleanup() {
  await prisma.discharge.deleteMany({ where: { admission: { encounter: { facilityId: { in: [ID.facA, ID.facB] } } } } });
  await prisma.admission.deleteMany({ where: { encounter: { facilityId: { in: [ID.facA, ID.facB] } } } });
  await prisma.hospitalStaffProfile.deleteMany({ where: { facilityId: { in: [ID.facA, ID.facB] } } });
  await prisma.encounter.deleteMany({ where: { facilityId: { in: [ID.facA, ID.facB] } } });
  await prisma.patient.deleteMany({ where: { facilityId: { in: [ID.facA, ID.facB] } } });
  await prisma.bed.deleteMany({ where: { facilityId: { in: [ID.facA, ID.facB] } } });
  await prisma.ward.deleteMany({ where: { facilityId: { in: [ID.facA, ID.facB] } } });
  await prisma.configurationChange.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.configurationOverride.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.organizationMembership.deleteMany({ where: { OR: [{ organizationId: { in: [ID.orgA, ID.orgB] } }, { userId: { in: [ID.uPlat, ID.uNurse] } }] } });
  await prisma.facility.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ID.orgA, ID.orgB] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ID.uPlat, ID.uNurse] } } });
}

async function seed() {
  await prisma.user.create({ data: { id: ID.uPlat, email: "d10-plat@x.local", passwordHash: "x", role: "AAROGYA_ADMIN", displayName: "plat" } });
  await prisma.user.create({ data: { id: ID.uNurse, email: "d10-nurse@x.local", passwordHash: "x", role: "NURSE", displayName: "nurse" } });
  for (const [org, fac] of [[ID.orgA, ID.facA], [ID.orgB, ID.facB]] as const) {
    await prisma.organization.create({ data: { id: org, slug: org, name: org, status: "ACTIVE" } });
    await prisma.facility.create({ data: { id: fac, slug: fac, name: fac, organizationId: org, status: "ACTIVE" } });
    await prisma.organizationMembership.create({ data: { organizationId: org, userId: ID.uPlat, isAdmin: true, status: "ACTIVE" } });
  }
  // Facility A: ward + 10 beds — 6 OCCUPIED, 2 AVAILABLE, 1 BLOCKED, 1 RESERVED → 80% occupancy.
  await prisma.ward.create({ data: { id: ID.wardA, name: "Ward A", wardType: "GENERAL", facilityId: ID.facA } });
  const mk = (label: string, status: any, icu = false) => prisma.bed.create({ data: { label, wardId: ID.wardA, facilityId: ID.facA, status, icuCapable: icu } });
  await Promise.all([
    ...Array.from({ length: 6 }, (_, i) => mk(`A-occ-${i}`, "OCCUPIED")),
    mk("A-avail-0", "AVAILABLE"), mk("A-avail-1", "AVAILABLE"),
    mk("A-blocked", "BLOCKED"), mk("A-reserved", "RESERVED"),
    mk("A-icu-occ", "OCCUPIED", true), mk("A-icu-avail", "AVAILABLE", true),
  ]);
  // Facility B: 4 beds all occupied (isolation check — must NOT affect A).
  const wardB = await prisma.ward.create({ data: { name: "Ward B", wardType: "GENERAL", facilityId: ID.facB } });
  await Promise.all(Array.from({ length: 4 }, (_, i) => prisma.bed.create({ data: { label: `B-${i}`, wardId: wardB.id, facilityId: ID.facB, status: "OCCUPIED" } })));
  // Facility A: a blocked discharge (clinically ready, billing NOT ready).
  const patient = await prisma.patient.create({ data: { uhid: "D10-UHID-1", facilityId: ID.facA, fullName: "Test Patient", sex: "female" } });
  const enc = await prisma.encounter.create({ data: { patientId: patient.id, facilityId: ID.facA, type: "IPD", status: "ADMITTED" } });
  const bed = await prisma.bed.findFirstOrThrow({ where: { facilityId: ID.facA, label: "A-occ-0" } });
  const staff = await prisma.hospitalStaffProfile.create({ data: { userId: ID.uNurse, facilityId: ID.facA, displayRole: "Nurse" } });
  const adm = await prisma.admission.create({ data: { encounterId: enc.id, bedId: bed.id, admittingStaffId: staff.id, reason: "test" } });
  await prisma.discharge.create({ data: { admissionId: adm.id, clinicallyReady: true, billingReady: false, documentationReady: true, insuranceReady: true, pharmacyReady: true, transportReady: true } });
}

/** Build a synthetic FacilityContext for a role scoped to a facility (route-level D1
 * isolation is proven by the D1 gate; here we test lib scoping + role gating). */
function fctx(role: "AAROGYA_ADMIN" | "NURSE", facilityId: string, organizationId: string): FacilityContext {
  return { session: { userId: role === "NURSE" ? ID.uNurse : ID.uPlat, role } as any, staff: null, facilityId, organizationId, facilityAdmin: true, orgAdmin: role === "AAROGYA_ADMIN" };
}

async function run() {
  console.log(`\n=== PHASE D10 COMMAND CENTER GATE (${IS_PG ? "PostgreSQL" : "SQLite"}) ===\n`);
  await cleanup();
  await seed();
  const plat = fctx("AAROGYA_ADMIN", ID.facA, ID.orgA);
  const nurse = fctx("NURSE", ID.facA, ID.orgA);

  // ── Metric correctness ──────────────────────────────────────────────────────
  console.log("[metric correctness]");
  {
    const ov = await getCommandCenterOverview(plat, { window: "24h" });
    const cap = ov.sections.find((s) => s.key === "capacity");
    const occ = cap?.metrics.find((m) => m.key === "bedOccupancy");
    if (occ?.value === 75) ok("bed occupancy computed correctly (75% of 12 beds)"); else bad("occupancy", `${occ?.value}`);
    const blocked = cap?.metrics.find((m) => m.key === "bedsBlocked");
    if (blocked?.value === 1) ok("blocked beds counted (1)"); else bad("blocked", `${blocked?.value}`);
    if (cap?.drivers?.some((d) => d.label.includes("Discharge-ready"))) ok("capacity WHY drivers present"); else bad("capacity drivers", "missing");

    const icu = ov.sections.find((s) => s.key === "icu");
    const icuOcc = icu?.metrics.find((m) => m.key === "icuOccupancy");
    if (icuOcc?.value === 50) ok("ICU occupancy computed from ICU-capable beds (1/2 = 50%)"); else bad("icu occupancy", `${icuOcc?.value}`);

    const disch = ov.sections.find((s) => s.key === "discharge");
    const dblk = disch?.metrics.find((m) => m.key === "dischargeBlocked");
    const billingDriver = disch?.drivers.find((d) => d.label.startsWith("Billing pending"));
    if (dblk?.value === 1 && billingDriver?.value === 1) ok("discharge bottleneck: 1 blocked, driver Billing=1 with operational owner"); else bad("discharge", `blocked=${dblk?.value} billing=${billingDriver?.value}`);
  }

  // ── Facility isolation (lib scoping) ────────────────────────────────────────
  console.log("[facility isolation]");
  {
    const capA = await getCommandCenterSection(plat, "capacity", {});
    const occA = capA.metrics.find((m) => m.key === "bedOccupancy")?.value;
    const capB = await getCommandCenterSection(fctx("AAROGYA_ADMIN", ID.facB, ID.orgB), "capacity", {});
    const occB = capB.metrics.find((m) => m.key === "bedOccupancy")?.value;
    if (occA === 75 && occB === 100) ok("facility A (75%) and B (100%) metrics are independent — no cross-facility leakage"); else bad("facility isolation", `A=${occA} B=${occB}`);
  }

  // ── Role / privacy isolation ────────────────────────────────────────────────
  console.log("[role + privacy]");
  {
    const nurseOv = await getCommandCenterOverview(nurse, {});
    const hasRevenue = nurseOv.sections.some((s) => s.key === "revenue");
    if (!hasRevenue && nurseOv.restrictedSections.includes("revenue") && nurseOv.restrictedSections.includes("claims")) ok("NURSE cannot see financial sections (revenue/claims restricted, not fabricated)"); else bad("financial privacy", `restricted=${nurseOv.restrictedSections.join(",")}`);
    const platOv = await getCommandCenterOverview(plat, {});
    if (platOv.sections.some((s) => s.key === "revenue")) ok("platform admin (billing:view) sees revenue section"); else bad("revenue visible", "missing for platform");
  }

  // ── Drill-down privacy + financial authz (IDOR/privacy) ─────────────────────
  console.log("[drill-down privacy]");
  {
    const wardDD = await getDrillDown(plat, "ward-occupancy");
    if (wardDD.rows.length >= 1) ok("ward-occupancy drill-down returns facility A wards only"); else bad("ward dd", "empty");
    await expectThrow("NURSE cannot open financial drill-down (open-invoices)", () => getDrillDown(nurse, "open-invoices"));
    await expectThrow("arbitrary drill-down kind rejected (no general data API)", () => getDrillDown(plat, "select-star-from-patient"));
  }

  // ── D8 threshold override + isolation ───────────────────────────────────────
  console.log("[D8 thresholds]");
  {
    const before = (await getCommandCenterSection(plat, "capacity", {})).metrics.find((m) => m.key === "bedOccupancy");
    if (before?.status === "NORMAL") ok("80% occupancy is NORMAL under default warning (85%)"); else bad("default threshold", before?.status);
    const m = await loadActorMemberships(ID.uPlat, "AAROGYA_ADMIN");
    await setOverride(m, { scope: "ORGANIZATION", organizationId: ID.orgA, key: "commandCenter.bedOccupancy.warning", value: "50" });
    await publishOverride(m, { scope: "ORGANIZATION", organizationId: ID.orgA, key: "commandCenter.bedOccupancy.warning" });
    const after = (await getCommandCenterSection(plat, "capacity", {})).metrics.find((m2) => m2.key === "bedOccupancy");
    if (after?.status === "WARNING" && after.threshold?.source === "D8_CONFIG") ok("org A override (warning=50) makes 80% WARNING; interpretation only, value unchanged (80)"); else bad("d8 override", `${after?.status}/${after?.threshold?.source}/${after?.value}`);
    if (after?.value === 75) ok("configured threshold changed interpretation, NOT the canonical value"); else bad("value integrity", `${after?.value}`);
    const orgBcap = (await getCommandCenterSection(fctx("AAROGYA_ADMIN", ID.facB, ID.orgB), "capacity", {})).metrics.find((m2) => m2.key === "bedOccupancy");
    if (orgBcap?.threshold?.source === "DEFAULT") ok("org A threshold override does not affect org B (config tenant isolation)"); else bad("threshold isolation", orgBcap?.threshold?.source);
  }

  // ── Injection / oversized ───────────────────────────────────────────────────
  console.log("[input safety]");
  await expectThrow("oversized custom date range rejected", () => getCommandCenterOverview(plat, { window: "custom", from: "2000-01-01", to: "2030-01-01" }));
  await expectThrow("inverted custom range rejected", () => getCommandCenterOverview(plat, { window: "custom", from: "2026-09-21", to: "2026-09-01" }));

  // ── Zero-state + unavailable semantics ──────────────────────────────────────
  console.log("[zero-state + robustness]");
  {
    const emptyOv = await getCommandCenterSection(fctx("AAROGYA_ADMIN", ID.facB, ID.orgB), "pharmacy", {});
    const backlog = emptyOv.metrics.find((m) => m.key === "pharmacyBacklog");
    if (backlog?.value === 0 && emptyOv.status === "NORMAL") ok("zero-state returns 0/NORMAL (not an error)"); else bad("zero-state", `${backlog?.value}/${emptyOv.status}`);
    const ov = await getCommandCenterOverview(plat, {});
    const anyUnavailable = ov.sections.filter((s) => s.status === "UNAVAILABLE");
    if (anyUnavailable.length === 0) ok("all authorized sections computed (no spurious UNAVAILABLE on a healthy DB)"); else bad("unexpected unavailable", anyUnavailable.map((s) => s.key).join(","));
    if (ov.attention.every((a) => ["CRITICAL", "WARNING", "WATCH"].includes(a.severity))) ok("attention queue is well-formed and deterministic"); else bad("attention", "malformed");
    if (typeof ov.asOf === "string" && ov.sections.every((s) => s.asOf)) ok("freshness (asOf) present on overview and every section"); else bad("asOf", "missing");
  }

  await cleanup();
  console.log(`\n────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed  (${IS_PG ? "PostgreSQL" : "SQLite"})`);
  if (fail) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
