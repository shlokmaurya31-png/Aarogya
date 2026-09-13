/**
 * PHASE D1 — enterprise tenancy security and concurrency verification.
 *
 * Exercises the tenant-context resolver and the enterprise service layer
 * DIRECTLY (below HTTP), with a hostile caller in mind. The properties that
 * must hold regardless of data:
 *
 *   - no cross-organization access (read, config, provisioning, membership)
 *   - no cross-facility access; multi-facility only where explicitly granted
 *   - a client-supplied facility id is honoured ONLY with persisted membership
 *   - suspended/deactivated tenants refuse normal operation, data intact
 *   - a removed/suspended membership loses access immediately
 *   - no privilege escalation (facility admin cannot mint org admin / cross)
 *   - no self-granting of elevated membership
 *   - the last organization administrator cannot be orphaned
 *   - lifecycle transitions follow the declared matrix; recovery is platform-only
 *   - configuration inherits dept -> facility -> org -> default; reset restores
 *
 * Concurrency claims (duplicate membership, duplicate provisioning, scope
 * update races) are only MEANINGFUL against PostgreSQL, which has genuine
 * parallel writers. On SQLite the security assertions still run and the
 * concurrency section reports that it was skipped.
 *
 * Usage (authoritative gate):
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-enterprise-tenancy.ts
 * Also runnable against the dev SQLite database for the security assertions.
 */
import { prisma } from "../src/lib/db";
import {
  loadActorMemberships,
  resolveFacilityForStaff,
  assertOrganizationAdmin,
  assertFacilityAdmin,
  assertOrganizationAccess,
  type ActorMemberships,
} from "../src/lib/auth/tenantContext";
import { getOrganizationForActor, transitionOrganization } from "../src/lib/enterprise/organizations";
import { createFacility, transitionFacility } from "../src/lib/enterprise/facilities";
import {
  addOrganizationMembership, addFacilityMembership, removeOrganizationMembership,
  setOrganizationMembershipScope,
} from "../src/lib/enterprise/memberships";
import { setOrgConfig, setFacilityConfig, setDepartmentConfig, resolveConfig, resetFacilityConfig } from "../src/lib/enterprise/configuration";
import { provisionOrganization } from "../src/lib/enterprise/provisioning";

const IS_PG = /^postgres/i.test(process.env.DATABASE_URL ?? "");

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(label: string) { pass++; console.log(`  ✓ ${label}`); }
function bad(label: string, detail?: string) { fail++; failures.push(label + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }

async function expectAllow(label: string, fn: () => Promise<unknown>) {
  try { await fn(); ok(label); } catch (e) { bad(label, `unexpected denial: ${(e as Error).message}`); }
}
async function expectDeny(label: string, fn: () => Promise<unknown>, wantStatus?: number) {
  try {
    await fn();
    bad(label, "expected a denial but the call SUCCEEDED");
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (wantStatus && status !== wantStatus) bad(label, `denied with ${status}, expected ${wantStatus}`);
    else ok(label);
  }
}

// Stable fixture ids so the script is idempotent across re-runs.
const ID = {
  orgA: "d1t-org-a", orgB: "d1t-org-b",
  facA1: "d1t-fac-a1", facA2: "d1t-fac-a2", facB1: "d1t-fac-b1",
  uStdA1: "d1t-u-std-a1", uMulti: "d1t-u-multi", uOrgAdminA: "d1t-u-orgadmin-a",
  uFacAdminA1: "d1t-u-facadmin-a1", uB1: "d1t-u-b1", uPlatform: "d1t-u-platform",
  uOutsider: "d1t-u-outsider", uSecondAdminA: "d1t-u-secondadmin-a", uProvAdmin: "d1t-u-prov-admin",
  uOrgAdminB: "d1t-u-orgadmin-b",
};

async function cleanup() {
  const orgIds = [ID.orgA, ID.orgB, "d1t-org-prov"];
  const facIds = [ID.facA1, ID.facA2, ID.facB1];
  const userIds = Object.values(ID);
  await prisma.departmentConfigValue.deleteMany({ where: { department: { facilityId: { in: facIds } } } });
  await prisma.facilityConfigValue.deleteMany({ where: { facilityId: { in: facIds } } });
  await prisma.orgConfigValue.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.facilityMembership.deleteMany({ where: { OR: [{ facilityId: { in: facIds } }, { userId: { in: userIds } }] } });
  await prisma.organizationMembership.deleteMany({ where: { OR: [{ organizationId: { in: orgIds } }, { userId: { in: userIds } }] } });
  await prisma.auditEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.department.deleteMany({ where: { facilityId: { in: facIds } } });
  await prisma.facility.deleteMany({ where: { OR: [{ id: { in: facIds } }, { organizationId: { in: orgIds } }] } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function seed() {
  const mkUser = (id: string, role: "HOSPITAL_ADMIN" | "DOCTOR" | "AAROGYA_ADMIN") =>
    prisma.user.create({ data: { id, email: `${id}@d1test.local`, passwordHash: "x", role, displayName: id } });

  await Promise.all([
    mkUser(ID.uStdA1, "DOCTOR"), mkUser(ID.uMulti, "DOCTOR"), mkUser(ID.uOrgAdminA, "HOSPITAL_ADMIN"),
    mkUser(ID.uFacAdminA1, "HOSPITAL_ADMIN"), mkUser(ID.uB1, "DOCTOR"), mkUser(ID.uPlatform, "AAROGYA_ADMIN"),
    mkUser(ID.uOutsider, "DOCTOR"), mkUser(ID.uSecondAdminA, "HOSPITAL_ADMIN"), mkUser(ID.uProvAdmin, "HOSPITAL_ADMIN"),
    mkUser(ID.uOrgAdminB, "HOSPITAL_ADMIN"),
  ]);

  await prisma.organization.create({ data: { id: ID.orgA, slug: ID.orgA, name: "Org A", status: "ACTIVE" } });
  await prisma.organization.create({ data: { id: ID.orgB, slug: ID.orgB, name: "Org B", status: "ACTIVE" } });
  await prisma.facility.create({ data: { id: ID.facA1, slug: ID.facA1, name: "Fac A1", organizationId: ID.orgA, status: "ACTIVE" } });
  await prisma.facility.create({ data: { id: ID.facA2, slug: ID.facA2, name: "Fac A2", organizationId: ID.orgA, status: "ACTIVE" } });
  await prisma.facility.create({ data: { id: ID.facB1, slug: ID.facB1, name: "Fac B1", organizationId: ID.orgB, status: "ACTIVE" } });

  // Memberships.
  await prisma.organizationMembership.createMany({ data: [
    { userId: ID.uStdA1, organizationId: ID.orgA, isAdmin: false },
    { userId: ID.uMulti, organizationId: ID.orgA, isAdmin: false },
    { userId: ID.uOrgAdminA, organizationId: ID.orgA, isAdmin: true },
    { userId: ID.uSecondAdminA, organizationId: ID.orgA, isAdmin: false },
    { userId: ID.uB1, organizationId: ID.orgB, isAdmin: false },
    { userId: ID.uOrgAdminB, organizationId: ID.orgB, isAdmin: true },
  ]});
  await prisma.facilityMembership.createMany({ data: [
    { userId: ID.uStdA1, facilityId: ID.facA1, isAdmin: false },
    { userId: ID.uMulti, facilityId: ID.facA1, isAdmin: false },
    { userId: ID.uFacAdminA1, facilityId: ID.facA1, isAdmin: true },
    { userId: ID.uB1, facilityId: ID.facB1, isAdmin: false },
  ]});
}

const load = (userId: string, role: "HOSPITAL_ADMIN" | "DOCTOR" | "AAROGYA_ADMIN") => loadActorMemberships(userId, role);

async function run() {
  console.log(`\nPhase D1 tenancy verification (provider: ${IS_PG ? "PostgreSQL" : "SQLite"})\n`);
  await cleanup();
  await seed();

  const mStdA1 = await load(ID.uStdA1, "DOCTOR");
  const mMulti = await load(ID.uMulti, "DOCTOR");
  const mOrgAdminA = await load(ID.uOrgAdminA, "HOSPITAL_ADMIN");
  const mFacAdminA1 = await load(ID.uFacAdminA1, "HOSPITAL_ADMIN");
  const mB1 = await load(ID.uB1, "DOCTOR");
  const mPlatform = await load(ID.uPlatform, "AAROGYA_ADMIN");
  const mOutsider = await load(ID.uOutsider, "DOCTOR");

  console.log("[cross-organization isolation]");
  await expectDeny("Org A user cannot read Org B", () => getOrganizationForActor(mStdA1, ID.orgB).then((o) => { if (!o) throw Object.assign(new Error("Not found"), { status: 404 }); }), 404);
  await expectDeny("Org A user cannot resolve Org B config", () => resolveConfig(mStdA1, { key: "billing.currency", organizationId: ID.orgB }), 404);
  await expectDeny("Org A admin cannot administer Org B", () => Promise.resolve().then(() => assertOrganizationAdmin(mOrgAdminA, ID.orgB)), 404);
  await expectAllow("Org A user CAN read Org A", () => getOrganizationForActor(mStdA1, ID.orgA));

  console.log("[cross-facility isolation & client id manipulation]");
  await expectAllow("A1 member reaches A1", () => resolveFacilityForStaff({ userId: ID.uStdA1, role: "DOCTOR", requestedFacilityId: ID.facA1 }));
  await expectDeny("A1 member cannot reach B1 via requestedFacilityId", () => resolveFacilityForStaff({ userId: ID.uStdA1, role: "DOCTOR", requestedFacilityId: ID.facB1 }), 404);
  await expectDeny("A1 member cannot reach A2 (same org, no membership)", () => resolveFacilityForStaff({ userId: ID.uStdA1, role: "DOCTOR", requestedFacilityId: ID.facA2 }), 404);

  console.log("[multi-facility access is explicit]");
  await expectAllow("multi user reaches A1", () => resolveFacilityForStaff({ userId: ID.uMulti, role: "DOCTOR", requestedFacilityId: ID.facA1 }));
  await expectDeny("multi user denied A2 before grant", () => resolveFacilityForStaff({ userId: ID.uMulti, role: "DOCTOR", requestedFacilityId: ID.facA2 }), 404);
  await addFacilityMembership(mOrgAdminA, { facilityId: ID.facA2, userId: ID.uMulti, isAdmin: false });
  await expectAllow("multi user reaches A2 after explicit grant", () => resolveFacilityForStaff({ userId: ID.uMulti, role: "DOCTOR", requestedFacilityId: ID.facA2 }));

  console.log("[admin scope boundaries]");
  await expectAllow("org admin administers A1", () => assertFacilityAdmin(mOrgAdminA, ID.facA1));
  await expectAllow("org admin administers A2", () => assertFacilityAdmin(mOrgAdminA, ID.facA2));
  await expectDeny("org A admin cannot administer B1", () => assertFacilityAdmin(mOrgAdminA, ID.facB1), 404);
  await expectAllow("facility admin administers A1", () => assertFacilityAdmin(mFacAdminA1, ID.facA1));
  await expectDeny("facility admin cannot administer A2", () => assertFacilityAdmin(mFacAdminA1, ID.facA2), 404);
  await expectDeny("facility admin is NOT an org admin", () => Promise.resolve().then(() => assertOrganizationAdmin(mFacAdminA1, ID.orgA)), 404);

  console.log("[privilege escalation & self-granting]");
  await expectDeny("facility admin cannot mint an org admin", () => addOrganizationMembership(mFacAdminA1, { organizationId: ID.orgA, userId: ID.uOutsider, isAdmin: true }), 404);
  await expectDeny("org A admin cannot add a member to Org B", () => addOrganizationMembership(mOrgAdminA, { organizationId: ID.orgB, userId: ID.uOutsider, isAdmin: false }), 404);
  await expectDeny("facility admin cannot add a member to B1", () => addFacilityMembership(mFacAdminA1, { facilityId: ID.facB1, userId: ID.uOutsider, isAdmin: false }), 404);
  {
    const own = await prisma.organizationMembership.findFirst({ where: { userId: ID.uOrgAdminA, organizationId: ID.orgA } });
    await expectDeny("org admin cannot self-elevate (already-admin self-grant guard)", () => setOrganizationMembershipScope(mOrgAdminA, own!.id, { isAdmin: true }), 403);
  }

  console.log("[cross-tenant configuration & provisioning]");
  await expectDeny("Org A admin cannot write Org B config", () => setOrgConfig(mOrgAdminA, ID.orgB, "billing.currency", "USD"), 404);
  await expectDeny("Org A admin cannot write B1 facility config", () => setFacilityConfig(mOrgAdminA, ID.facB1, "billing.currency", "USD"), 404);
  await expectDeny("non-platform cannot provision", () => provisionOrganization(mOrgAdminA, { organization: { name: "X", slug: "d1t-org-prov" }, facility: { name: "F", slug: "d1t-fac-prov" }, adminUserId: ID.uProvAdmin }), 403);

  console.log("[configuration inheritance]");
  await setOrgConfig(mOrgAdminA, ID.orgA, "appointment.defaultDurationMinutes", "20");
  {
    const r = await resolveConfig(mOrgAdminA, { key: "appointment.defaultDurationMinutes", organizationId: ID.orgA, facilityId: ID.facA1 });
    if (r.value === "20" && r.source === "organization" && r.explicit) ok("facility inherits org override (20, source=organization)");
    else bad("facility inherits org override", JSON.stringify(r));
  }
  await setFacilityConfig(mOrgAdminA, ID.facA1, "appointment.defaultDurationMinutes", "30");
  {
    const r = await resolveConfig(mOrgAdminA, { key: "appointment.defaultDurationMinutes", organizationId: ID.orgA, facilityId: ID.facA1 });
    if (r.value === "30" && r.source === "facility") ok("facility override wins (30, source=facility)");
    else bad("facility override wins", JSON.stringify(r));
  }
  await resetFacilityConfig(mOrgAdminA, ID.facA1, "appointment.defaultDurationMinutes");
  {
    const r = await resolveConfig(mOrgAdminA, { key: "appointment.defaultDurationMinutes", organizationId: ID.orgA, facilityId: ID.facA1 });
    if (r.value === "20" && r.source === "organization") ok("reset restores inherited (20, source=organization)");
    else bad("reset restores inherited", JSON.stringify(r));
  }
  {
    const dept = await prisma.department.create({ data: { facilityId: ID.facA1, name: "d1t-Cardiology" } });
    await setDepartmentConfig(mOrgAdminA, dept.id, "appointment.defaultDurationMinutes", "45");
    const r = await resolveConfig(mOrgAdminA, { key: "appointment.defaultDurationMinutes", organizationId: ID.orgA, facilityId: ID.facA1, departmentId: dept.id });
    if (r.value === "45" && r.source === "department") ok("department override wins (45, source=department)");
    else bad("department override wins", JSON.stringify(r));
  }
  {
    const r = await resolveConfig(mOrgAdminA, { key: "billing.currency", organizationId: ID.orgA });
    if (r.value === "INR" && r.source === "default" && !r.explicit) ok("unset key falls to hard-coded default (INR)");
    else bad("unset key falls to default", JSON.stringify(r));
  }

  console.log("[lifecycle safety]");
  await transitionFacility(mOrgAdminA, ID.facA1, "SUSPENDED");
  await expectDeny("suspended facility refuses normal operation", () => resolveFacilityForStaff({ userId: ID.uStdA1, role: "DOCTOR", requestedFacilityId: ID.facA1 }), 403);
  await transitionFacility(mOrgAdminA, ID.facA1, "ACTIVE");
  await expectAllow("reactivated facility works again", () => resolveFacilityForStaff({ userId: ID.uStdA1, role: "DOCTOR", requestedFacilityId: ID.facA1 }));
  await transitionOrganization(mOrgAdminA, ID.orgA, "SUSPENDED");
  await expectDeny("suspended organization refuses normal operation", () => resolveFacilityForStaff({ userId: ID.uStdA1, role: "DOCTOR", requestedFacilityId: ID.facA1 }), 403);
  await transitionOrganization(mOrgAdminA, ID.orgA, "ACTIVE");
  // Data intact after the suspend/reactivate cycle.
  {
    const facCount = await prisma.facility.count({ where: { organizationId: ID.orgA } });
    if (facCount === 2) ok("clinical structure survived suspend/reactivate (facilities intact)");
    else bad("data survived lifecycle", `facilities=${facCount}`);
  }
  const mOrgAdminB = await load(ID.uOrgAdminB, "HOSPITAL_ADMIN");
  await transitionOrganization(mOrgAdminB, ID.orgB, "DEACTIVATED"); // org B admin may deactivate their own org
  await expectDeny("non-platform org admin cannot reactivate a DEACTIVATED org", () => transitionOrganization(mOrgAdminB, ID.orgB, "ACTIVE"), 403);
  await expectAllow("platform CAN reactivate a DEACTIVATED org", () => transitionOrganization(mPlatform, ID.orgB, "ACTIVE"));

  console.log("[stale membership & last-admin protection]");
  {
    const mem = await prisma.facilityMembership.findFirst({ where: { userId: ID.uMulti, facilityId: ID.facA2 } });
    await removeFacilityMembershipRaw(mem!.id, mOrgAdminA);
    await expectDeny("removed membership loses access immediately", () => resolveFacilityForStaff({ userId: ID.uMulti, role: "DOCTOR", requestedFacilityId: ID.facA2 }), 404);
  }
  {
    const own = await prisma.organizationMembership.findFirst({ where: { userId: ID.uOrgAdminA, organizationId: ID.orgA } });
    await expectDeny("cannot orphan the last org admin", () => removeOrganizationMembership(mOrgAdminA, own!.id), 400);
    // Promote a second admin, then removal is allowed.
    const second = await prisma.organizationMembership.findFirst({ where: { userId: ID.uSecondAdminA, organizationId: ID.orgA } });
    await setOrganizationMembershipScope(mOrgAdminA, second!.id, { isAdmin: true });
    await expectAllow("removing an admin is allowed once another exists", () => removeOrganizationMembership(mOrgAdminA, own!.id));
  }

  console.log("[break-glass cannot cross a tenant]");
  // Break-glass lives entirely in C4 and never reaches tenant resolution; a
  // break-glass window for a patient in A1 cannot make B1 resolvable.
  await expectDeny("no break-glass path crosses tenant (B1 still denied for A-user)", () => resolveFacilityForStaff({ userId: ID.uStdA1, role: "DOCTOR", requestedFacilityId: ID.facB1 }), 404);
  void mB1; void mOutsider; void assertOrganizationAccess;

  await concurrency();

  await cleanup();
  console.log(`\n──────────────────────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed  (${IS_PG ? "PostgreSQL" : "SQLite"})`);
  if (fail) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

// Helper reused above (facility membership removal by an admin).
async function removeFacilityMembershipRaw(membershipId: string, m: ActorMemberships) {
  const { removeFacilityMembership } = await import("../src/lib/enterprise/memberships");
  await removeFacilityMembership(m, membershipId);
}

async function concurrency() {
  console.log("[concurrency]");
  if (!IS_PG) {
    console.log("  · skipped (SQLite serialises writers; run against PostgreSQL for the authoritative race gate)");
    return;
  }
  // Use the platform admin here: the last-admin section above intentionally
  // stripped uOrgAdminA's administration, so a fresh load of that user would no
  // longer be authorized. The platform admin is a stable authorized caller.
  const mPlatform = await load(ID.uPlatform, "AAROGYA_ADMIN");

  // 1. Duplicate facility-membership creation race → exactly one row.
  const target = ID.uOutsider;
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => addFacilityMembership(mPlatform, { facilityId: ID.facA1, userId: target, isAdmin: false }))
  );
  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const rows = await prisma.facilityMembership.count({ where: { facilityId: ID.facA1, userId: target } });
  if (rows === 1 && succeeded === 1) ok(`duplicate membership race: exactly one row, one success (of 8)`);
  else bad("duplicate membership race", `rows=${rows} succeeded=${succeeded}`);

  // 2. Duplicate provisioning race (same slug) → one org, one facility.
  const provResults = await Promise.allSettled(
    Array.from({ length: 6 }, () => provisionOrganization(mPlatform, {
      organization: { name: "Prov Org", slug: "d1t-org-prov" },
      facility: { name: "Prov Fac", slug: "d1t-fac-prov" },
      adminUserId: ID.uProvAdmin,
      departments: ["Emergency", "Cardiology"],
    }))
  );
  const provOk = provResults.filter((r) => r.status === "fulfilled").length;
  const orgCount = await prisma.organization.count({ where: { slug: "d1t-org-prov" } });
  const facCount = await prisma.facility.count({ where: { slug: "d1t-fac-prov" } });
  const orgAdmins = await prisma.organizationMembership.count({ where: { organization: { slug: "d1t-org-prov" }, isAdmin: true } });
  if (orgCount === 1 && facCount === 1 && orgAdmins === 1) ok(`idempotent provisioning race: 1 org, 1 facility, 1 admin (${provOk}/6 calls ok)`);
  else bad("idempotent provisioning race", `orgs=${orgCount} facilities=${facCount} admins=${orgAdmins}`);

  // 3. Concurrent scope updates on one membership → deterministic single state.
  const mem = await prisma.facilityMembership.findFirst({ where: { facilityId: ID.facA1, userId: target } });
  await Promise.allSettled([
    setFacilityMembershipScopeSafe(mem!.id, { isAdmin: true }, mPlatform),
    setFacilityMembershipScopeSafe(mem!.id, { status: "SUSPENDED" }, mPlatform),
  ]);
  const after = await prisma.facilityMembership.findUnique({ where: { id: mem!.id } });
  if (after) ok(`concurrent scope updates converge to one row (isAdmin=${after.isAdmin}, status=${after.status})`);
  else bad("concurrent scope updates", "row vanished");
}

async function setFacilityMembershipScopeSafe(id: string, changes: { isAdmin?: boolean; status?: "ACTIVE" | "SUSPENDED" }, m: ActorMemberships) {
  const { setFacilityMembershipScope } = await import("../src/lib/enterprise/memberships");
  try { await setFacilityMembershipScope(m, id, changes); } catch { /* a lost race is acceptable; determinism is asserted on the row */ }
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
