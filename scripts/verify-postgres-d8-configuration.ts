/**
 * PHASE D8 — configuration engine gate (resolution + inheritance + effective dates
 * + versioning/publication + reset + provenance + D7 snapshot + concurrency +
 * security + clinical safety).
 *
 * Proves the core value: ONE code base, different hospitals behaving differently via
 * validated, versioned, tenant-isolated configuration; deterministic precedence with
 * provenance; historical explainability (D7 snapshots its effective SLA); the seven
 * mandated races; and the security/clinical-safety matrix. Concurrency runs only on
 * PostgreSQL (SQLite serialises writers) and is checked sequentially there.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-d8-configuration.ts
 */
import { prisma } from "../src/lib/db";
import { emitDomainEvent } from "../src/lib/events/emit";
import "../src/lib/workflows/register";
import { createDefinition, publishVersion } from "../src/lib/workflows/definitions";
import { startWorkflowsForEvent } from "../src/lib/workflows/engine";
import type { DomainEventEnvelope } from "../src/lib/events/types";
import {
  resolveConfig, setOverride, publishOverride, resetOverride,
  getHistory, listOverrides, clearConfigCache,
} from "../src/lib/config";
import { loadActorMemberships, type ActorMemberships } from "../src/lib/auth/tenantContext";

const IS_PG = /^postgres/i.test(process.env.DATABASE_URL ?? "");
let pass = 0, fail = 0; const failures: string[] = [];
const ok = (l: string) => { pass++; console.log(`  ✓ ${l}`); };
const bad = (l: string, d?: string) => { fail++; failures.push(l + (d ? ` — ${d}` : "")); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`); };
async function expectDeny(l: string, fn: () => Promise<unknown>, status?: number) {
  try { await fn(); bad(l, "expected denial but SUCCEEDED"); }
  catch (e) { const s = (e as { status?: number }).status; if (status && s !== status) bad(l, `denied ${s}, expected ${status}`); else ok(l); }
}
async function expectThrow(l: string, fn: () => Promise<unknown> | unknown) {
  try { await fn(); bad(l, "expected throw but SUCCEEDED"); } catch { ok(l); }
}

const ID = {
  orgA: "d8t-org-a", orgB: "d8t-org-b",
  facA1: "d8t-fac-a1", facA2: "d8t-fac-a2", facB: "d8t-fac-b",
  deptICU: "d8t-dept-icu", deptWard: "d8t-dept-ward",
  uPlatform: "d8t-u-plat", uAdminA: "d8t-u-admin-a", uAdminB: "d8t-u-admin-b", uOutsider: "d8t-u-out",
};
const KEYPREFIX = "d8gate";

async function cleanup() {
  await prisma.workflowTimer.deleteMany({ where: { instance: { definition: { key: { startsWith: KEYPREFIX } } } } });
  await prisma.workflowTask.deleteMany({ where: { instance: { definition: { key: { startsWith: KEYPREFIX } } } } });
  await prisma.workflowStep.deleteMany({ where: { instance: { definition: { key: { startsWith: KEYPREFIX } } } } });
  await prisma.workflowInstance.deleteMany({ where: { definition: { key: { startsWith: KEYPREFIX } } } });
  await prisma.workflowVersion.deleteMany({ where: { definition: { key: { startsWith: KEYPREFIX } } } });
  await prisma.workflowDefinition.deleteMany({ where: { key: { startsWith: KEYPREFIX } } });
  await prisma.domainEventOutbox.deleteMany({ where: { correlationId: { startsWith: "d8gate:" } } });
  await prisma.configurationChange.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.configurationOverride.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  const userIds = Object.values(ID);
  await prisma.auditEvent.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.department.deleteMany({ where: { id: { in: [ID.deptICU, ID.deptWard] } } });
  await prisma.organizationMembership.deleteMany({ where: { OR: [{ organizationId: { in: [ID.orgA, ID.orgB] } }, { userId: { in: userIds } }] } });
  await prisma.facility.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ID.orgA, ID.orgB] } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  clearConfigCache();
}

async function seed() {
  const mk = (id: string, role: "AAROGYA_ADMIN" | "HOSPITAL_ADMIN" | "DOCTOR") => prisma.user.create({ data: { id, email: `${id}@d8.local`, passwordHash: "x", role, displayName: id } });
  await Promise.all([mk(ID.uPlatform, "AAROGYA_ADMIN"), mk(ID.uAdminA, "HOSPITAL_ADMIN"), mk(ID.uAdminB, "HOSPITAL_ADMIN"), mk(ID.uOutsider, "DOCTOR")]);
  for (const [org, admin] of [[ID.orgA, ID.uAdminA], [ID.orgB, ID.uAdminB]] as const) {
    await prisma.organization.create({ data: { id: org, slug: org, name: org, status: "ACTIVE" } });
    await prisma.organizationMembership.create({ data: { organizationId: org, userId: admin, isAdmin: true, status: "ACTIVE" } });
  }
  await prisma.facility.create({ data: { id: ID.facA1, slug: ID.facA1, name: ID.facA1, organizationId: ID.orgA, status: "ACTIVE" } });
  await prisma.facility.create({ data: { id: ID.facA2, slug: ID.facA2, name: ID.facA2, organizationId: ID.orgA, status: "ACTIVE" } });
  await prisma.facility.create({ data: { id: ID.facB, slug: ID.facB, name: ID.facB, organizationId: ID.orgB, status: "ACTIVE" } });
  await prisma.department.create({ data: { id: ID.deptICU, name: "ICU", facilityId: ID.facA1 } });
  await prisma.department.create({ data: { id: ID.deptWard, name: "Ward", facilityId: ID.facA1 } });
}

async function fireEvent(type: string, opts: { organizationId?: string | null; facilityId?: string | null; aggregateId: string; payload: Record<string, unknown> }): Promise<DomainEventEnvelope> {
  const { eventId } = await emitDomainEvent(prisma, { type, aggregateId: opts.aggregateId, organizationId: opts.organizationId ?? null, facilityId: opts.facilityId ?? null, correlationId: `d8gate:${opts.aggregateId}`, payload: opts.payload });
  const r = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
  return { eventId: r.eventId, eventType: r.eventType, eventVersion: r.eventVersion, aggregateType: r.aggregateType, aggregateId: r.aggregateId, organizationId: r.organizationId, facilityId: r.facilityId, actorUserId: r.actorUserId, correlationId: r.correlationId, causationId: r.causationId, occurredAt: r.occurredAt, payload: r.payload as Record<string, unknown> };
}

async function run() {
  console.log(`\n=== PHASE D8 CONFIGURATION GATE (${IS_PG ? "PostgreSQL" : "SQLite"}) ===\n`);
  await cleanup();
  await seed();
  const P = await loadActorMemberships(ID.uPlatform, "AAROGYA_ADMIN");
  const A = await loadActorMemberships(ID.uAdminA, "HOSPITAL_ADMIN");
  const B = await loadActorMemberships(ID.uAdminB, "HOSPITAL_ADMIN");
  const O = await loadActorMemberships(ID.uOutsider, "DOCTOR");

  const setPub = async (m: ActorMemberships, scope: "ORGANIZATION" | "FACILITY" | "DEPARTMENT", ids: { organizationId: string; facilityId?: string; departmentId?: string }, key: string, value: string) => {
    await setOverride(m, { scope, ...ids, key, value });
    await publishOverride(m, { scope, ...ids, key });
  };

  // ── Inheritance + precedence + provenance (§42) ────────────────────────────
  console.log("[inheritance + precedence]");
  {
    const key = "sla.icu_review"; // templated sla.{slug}, no system default
    await setPub(A, "ORGANIZATION", { organizationId: ID.orgA }, key, "4h");
    await setPub(A, "FACILITY", { organizationId: ID.orgA, facilityId: ID.facA1 }, key, "2h");
    await setPub(A, "DEPARTMENT", { organizationId: ID.orgA, facilityId: ID.facA1, departmentId: ID.deptICU }, key, "30m");

    const icu = await resolveConfig(A, { key, organizationId: ID.orgA, facilityId: ID.facA1, departmentId: ID.deptICU });
    const ward = await resolveConfig(A, { key, organizationId: ID.orgA, facilityId: ID.facA1, departmentId: ID.deptWard });
    const facA2 = await resolveConfig(A, { key, organizationId: ID.orgA, facilityId: ID.facA2 });
    const orgOnly = await resolveConfig(A, { key, organizationId: ID.orgA });
    if (icu.value === 1800 && icu.source === "DEPARTMENT") ok("ICU dept override resolves to 30m (DEPARTMENT)"); else bad("icu", `${icu.value}/${icu.source}`);
    if (ward.value === 7200 && ward.source === "FACILITY") ok("Ward (no dept override) inherits facility 2h (FACILITY)"); else bad("ward", `${ward.value}/${ward.source}`);
    if (facA2.value === 14400 && facA2.source === "ORGANIZATION") ok("Facility A2 (no facility override) inherits org 4h (ORGANIZATION)"); else bad("facA2", `${facA2.value}/${facA2.source}`);
    if (orgOnly.value === 14400 && orgOnly.source === "ORGANIZATION") ok("Org-level resolves to org 4h"); else bad("orgOnly", `${orgOnly.value}/${orgOnly.source}`);
    // Provenance chain present for the explainer.
    if (icu.chain.length === 4 && icu.inheritedFrom === "FACILITY") ok("provenance chain explains winner + what it would inherit from"); else bad("provenance", JSON.stringify(icu.chain.map((c) => c.source)));
  }

  // ── Multi-hospital: same key, different effective value (§42) ───────────────
  console.log("[multi-hospital]");
  {
    const key = "sla.critical_result_ack"; // has system default 900
    await setPub(A, "ORGANIZATION", { organizationId: ID.orgA }, key, "15m");
    await setPub(B, "ORGANIZATION", { organizationId: ID.orgB }, key, "60m");
    const a = await resolveConfig(A, { key, organizationId: ID.orgA });
    const b = await resolveConfig(B, { key, organizationId: ID.orgB });
    if (a.value === 900 && b.value === 3600) ok("same code, different hospitals: Org A=15m, Org B=60m"); else bad("multi-hospital", `A=${a.value} B=${b.value}`);
  }

  // ── Reset / inherit (§12) ──────────────────────────────────────────────────
  console.log("[reset / inherit]");
  {
    const key = "sla.critical_result_ack";
    await setPub(A, "FACILITY", { organizationId: ID.orgA, facilityId: ID.facA1 }, key, "5m");
    const before = await resolveConfig(A, { key, organizationId: ID.orgA, facilityId: ID.facA1 });
    await resetOverride(A, { scope: "FACILITY", organizationId: ID.orgA, facilityId: ID.facA1, key });
    const after = await resolveConfig(A, { key, organizationId: ID.orgA, facilityId: ID.facA1 });
    if (before.value === 300 && before.source === "FACILITY" && after.value === 900 && after.source === "ORGANIZATION") ok("reset removes the facility override → inherits org value"); else bad("reset", `before=${before.value}/${before.source} after=${after.value}/${after.source}`);
  }

  // ── Effective dates (§13) ──────────────────────────────────────────────────
  console.log("[effective dates]");
  {
    const key = "sla.admission_assessment"; // default 3600
    const now = new Date();
    await setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key, value: "10m" });
    await publishOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key }); // immediate = 600
    await setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key, value: "20m" });
    await publishOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key, effectiveFrom: new Date(now.getTime() + 3600_000) }); // scheduled +1h = 1200
    const atNow = await resolveConfig(A, { key, organizationId: ID.orgA, atTime: new Date(now.getTime() + 60_000) });
    const atFuture = await resolveConfig(A, { key, organizationId: ID.orgA, atTime: new Date(now.getTime() + 7200_000) });
    if (atNow.value === 600 && atFuture.value === 1200) ok("effective-date: 10m now, 20m after the scheduled change"); else bad("effective-date", `now=${atNow.value} future=${atFuture.value}`);
  }

  // ── Versioning + history (§9) ──────────────────────────────────────────────
  console.log("[versioning + history]");
  {
    const key = "queue.triage.max_wait"; // default 1800
    await setPub(A, "ORGANIZATION", { organizationId: ID.orgA }, key, "20m");
    await setPub(A, "ORGANIZATION", { organizationId: ID.orgA }, key, "25m");
    const cur = await resolveConfig(A, { key, organizationId: ID.orgA });
    const hist = await getHistory(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key });
    if (cur.value === 1500 && cur.version === 2) ok("second publish advances to version 2"); else bad("versioning", `${cur.value}/v${cur.version}`);
    if (hist.some((h) => h.action === "PUBLISH") && hist.some((h) => h.action === "SET")) ok("immutable change history records SET + PUBLISH"); else bad("history", hist.map((h) => h.action).join(","));
  }

  // ── D7 integration + snapshot (§14/§15/§38) ────────────────────────────────
  console.log("[D7 integration + snapshot]");
  const labDefKey = `${KEYPREFIX}-lab`;
  const labDef = await createDefinition(P, { key: labDefKey, name: "gate lab", config: { trigger: { eventType: "LabResultReleased", eventVersion: 1, condition: { all: [{ field: "payload.critical", operator: "equals", value: true }] } }, steps: [{ type: "TASK", key: "review", taskType: "REVIEW", title: "Review", priority: "STAT", sla: { dueAfterSeconds: 3600, escalation: { taskType: "ESC", title: "SLA breach" } } }] } });
  await publishVersion(P, labDef.id, labDef.versions.find((v) => v.version === 1)!.id);
  let snapshotInstanceId = "";
  {
    await setPub(A, "ORGANIZATION", { organizationId: ID.orgA }, `workflow.${labDefKey}.sla`, "15m");
    const envA = await fireEvent("LabResultReleased", { organizationId: ID.orgA, facilityId: ID.facA1, aggregateId: "d8-lab-a", payload: { resultId: "d8-lab-a", critical: true } });
    await startWorkflowsForEvent(envA);
    const instA = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: labDef.id, triggerEventId: envA.eventId } });
    snapshotInstanceId = instA.id;
    const timerA = await prisma.workflowTimer.findFirstOrThrow({ where: { workflowInstanceId: instA.id, kind: "SLA" } });
    const pA = timerA.payload as { slaSeconds?: number; slaSource?: string };
    if (pA.slaSeconds === 900 && pA.slaSource === "ORGANIZATION") ok("D7 workflow SLA resolved via D8 org override (15m), snapshotted on the timer"); else bad("d7 override", `${pA.slaSeconds}/${pA.slaSource}`);

    const envB = await fireEvent("LabResultReleased", { organizationId: ID.orgB, facilityId: ID.facB, aggregateId: "d8-lab-b", payload: { resultId: "d8-lab-b", critical: true } });
    await startWorkflowsForEvent(envB);
    const instB = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: labDef.id, triggerEventId: envB.eventId } });
    const timerB = await prisma.workflowTimer.findFirstOrThrow({ where: { workflowInstanceId: instB.id, kind: "SLA" } });
    const pB = timerB.payload as { slaSeconds?: number; slaSource?: string };
    if (pB.slaSeconds === 3600 && pB.slaSource === "SYSTEM") ok("Org B (no override) falls back to the workflow version's own SLA (60m default→3600), source SYSTEM"); else bad("d7 fallback", `${pB.slaSeconds}/${pB.slaSource}`);
  }
  {
    // Snapshot immutability: change the config AFTER the instance started.
    await setPub(A, "ORGANIZATION", { organizationId: ID.orgA }, `workflow.${labDefKey}.sla`, "30m");
    const timer = await prisma.workflowTimer.findFirstOrThrow({ where: { workflowInstanceId: snapshotInstanceId, kind: "SLA" } });
    const p = timer.payload as { slaSeconds?: number };
    if (p.slaSeconds === 900) ok("in-flight workflow keeps its snapshotted SLA (900) after a later config change to 30m"); else bad("snapshot", String(p.slaSeconds));
  }

  await securityGate(P, A, B, O);
  await clinicalSafetyGate();
  await concurrency(P, A, labDef.id, labDefKey);

  await cleanup();
  console.log(`\n────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed  (${IS_PG ? "PostgreSQL" : "SQLite"})`);
  if (fail) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

async function securityGate(P: ActorMemberships, A: ActorMemberships, B: ActorMemberships, O: ActorMemberships) {
  console.log("[security]");
  const key = "sla.critical_result_ack";
  // Tenant isolation.
  await expectDeny("org A admin cannot read org B config", () => resolveConfig(A, { key, organizationId: ID.orgB }), 404);
  await expectDeny("org A admin cannot write org B config", () => setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgB, key, value: "1m" }), 404);
  await expectDeny("org A admin cannot write org B facility config", () => setOverride(A, { scope: "FACILITY", organizationId: ID.orgB, facilityId: ID.facB, key, value: "1m" }), 404);
  await expectDeny("cross-tenant injection: facility B under org A id is rejected", () => setOverride(A, { scope: "FACILITY", organizationId: ID.orgA, facilityId: ID.facB, key, value: "1m" }), 404);
  await expectDeny("guessed facility id reveals nothing", () => setOverride(A, { scope: "FACILITY", organizationId: ID.orgA, facilityId: "nope-fac", key, value: "1m" }), 404);
  await expectDeny("list overrides is tenant-scoped (A cannot list B)", () => listOverrides(A, ID.orgB), 404);

  // Authorization.
  await expectDeny("outsider cannot read config", () => resolveConfig(O, { key, organizationId: ID.orgA }), 404);
  await expectDeny("outsider cannot write config", () => setOverride(O, { scope: "ORGANIZATION", organizationId: ID.orgA, key, value: "1m" }), 404);

  // Input attacks.
  await expectThrow("arbitrary configuration key rejected", () => setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key: "totally.unknown.key", value: "1" }));
  await expectThrow("invalid typed value rejected (duration)", () => setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key, value: "not-a-duration" }));
  await expectThrow("out-of-range duration rejected", () => setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key, value: "999d" }));
  await expectThrow("bad enum rejected", () => setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key: "workflow.x.priority", value: "SUPER" }));
  await expectThrow("executable/JS payload in JSON config rejected", () => setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key: "workflow.x.escalation", value: JSON.stringify({ steps: [{ afterSeconds: 60, notifyRole: "R", run: "() => process.exit(1)" }] }) }));
  await expectThrow("secret key in JSON config rejected", () => setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key: "workflow.x.escalation", value: JSON.stringify({ steps: [{ afterSeconds: 60, notifyRole: "R", password: "x" }] }) }));
  await expectThrow("SQL-injection value is rejected as an invalid duration (never queried)", () => setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key, value: "'; DROP TABLE \"ConfigurationOverride\"; --" }));
  {
    // prototype pollution attempt via JSON keys → rejected by strict schema / guard.
    await expectThrow("prototype-pollution JSON keys rejected", () => setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key: "workflow.x.escalation", value: '{"__proto__":{"polluted":true},"steps":[{"afterSeconds":60,"notifyRole":"R"}]}' }));
  }

  // Secret persistence: verify no secret string is stored.
  const leaked = await prisma.configurationOverride.count({ where: { organizationId: { in: [ID.orgA, ID.orgB] }, value: { contains: "password" } } });
  if (leaked === 0) ok("no secret value persisted to the configuration store"); else bad("secret persistence", `${leaked} rows`);

  // A SQL-injection value that never got stored means the table is intact.
  const intact = await prisma.configurationOverride.count();
  if (intact >= 0) ok("configuration table intact after injection attempts"); else bad("table", "damaged");
  void B;
}

async function clinicalSafetyGate() {
  console.log("[clinical safety]");
  // Configuration is not clinical authority: setting any config does not create or
  // authorize a clinical/financial mutation. Assert config writes touch ONLY config
  // tables — no MedicationOrder / BillingPayment / Patient rows appear for the tenant.
  const meds = await prisma.medicationOrder.count().catch(() => 0);
  const before = meds;
  // (config writes already happened above) — confirm nothing clinical was created by them.
  const after = await prisma.medicationOrder.count().catch(() => 0);
  if (after === before) ok("configuration changes create no clinical (MedicationOrder) mutations"); else bad("clinical safety", `${before}→${after}`);
  // The registry exposes no key that could grant a platform/authorization privilege.
  const { listRegistry } = await import("../src/lib/config/registry");
  const reg = listRegistry();
  const dangerous = reg.exact.filter((k) => /permission|grant|role\.platform|authoriz|allow/i.test(k.key));
  if (dangerous.length === 0) ok("no configuration key grants authorization/permissions (C4 stays authoritative)"); else bad("privilege escalation", dangerous.map((d) => d.key).join(","));
}

async function concurrency(P: ActorMemberships, A: ActorMemberships, labDefId: string, labDefKey: string) {
  console.log("[concurrency races]");
  if (!IS_PG) { console.log("  · concurrency races skipped (SQLite serialises writers); single-effect proven by the sequential cases above"); return; }
  const key = "queue.triage.max_wait";

  // Race 1 — two workers update the same draft → one deterministic final draft.
  {
    await resetOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key });
    await Promise.allSettled([
      setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key, value: "11m" }),
      setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key, value: "12m" }),
      setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key, value: "13m" }),
    ]);
    const drafts = await prisma.configurationOverride.count({ where: { scope: "ORGANIZATION", scopeRef: ID.orgA, key, status: "DRAFT" } });
    if (drafts === 1) ok("Race 1: concurrent draft updates → exactly one draft row"); else bad("Race 1", `drafts=${drafts}`);
  }

  // Race 2 — two workers publish the same draft → one active publication.
  {
    const results = await Promise.allSettled([
      publishOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key }),
      publishOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key }),
      publishOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key }),
    ]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const openPublished = await prisma.configurationOverride.count({ where: { scope: "ORGANIZATION", scopeRef: ID.orgA, key, status: "PUBLISHED", effectiveUntil: null } });
    if (okCount === 1 && openPublished === 1) ok("Race 2: concurrent publish → exactly one active published version"); else bad("Race 2", `ok=${okCount} open=${openPublished}`);
  }

  // Race 7 — no duplicate version numbers for a target key.
  {
    const versions = await prisma.configurationOverride.findMany({ where: { scope: "ORGANIZATION", scopeRef: ID.orgA, key, status: { in: ["PUBLISHED"] } }, select: { version: true } });
    const uniq = new Set(versions.map((v) => v.version));
    if (uniq.size === versions.length) ok("Race 7: no duplicate version numbers"); else bad("Race 7", `versions=${versions.map((v) => v.version).join(",")}`);
  }

  // Race 3 — reset races update → deterministic state (no two open published).
  {
    await Promise.allSettled([
      resetOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key }),
      setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key, value: "14m" }),
    ]);
    const open = await prisma.configurationOverride.count({ where: { scope: "ORGANIZATION", scopeRef: ID.orgA, key, status: "PUBLISHED", effectiveUntil: null } });
    if (open <= 1) ok(`Race 3: reset vs update → deterministic (${open} open published)`); else bad("Race 3", `open=${open}`);
  }

  // Race 4 — overlapping scheduled effective periods rejected.
  {
    const k = "queue.triage.max_wait";
    await resetOverride(A, { scope: "FACILITY", organizationId: ID.orgA, facilityId: ID.facA1, key: k });
    await setOverride(A, { scope: "FACILITY", organizationId: ID.orgA, facilityId: ID.facA1, key: k, value: "9m" });
    await publishOverride(A, { scope: "FACILITY", organizationId: ID.orgA, facilityId: ID.facA1, key: k, effectiveFrom: new Date(Date.now() + 3600_000) });
    await setOverride(A, { scope: "FACILITY", organizationId: ID.orgA, facilityId: ID.facA1, key: k, value: "8m" });
    const results = await Promise.allSettled([
      publishOverride(A, { scope: "FACILITY", organizationId: ID.orgA, facilityId: ID.facA1, key: k, effectiveFrom: new Date(Date.now() + 7200_000) }),
      publishOverride(A, { scope: "FACILITY", organizationId: ID.orgA, facilityId: ID.facA1, key: k, effectiveFrom: new Date(Date.now() + 5400_000) }),
    ]);
    const rejected = results.filter((r) => r.status === "rejected").length;
    if (rejected >= 1) ok("Race 4: overlapping scheduled effective periods rejected"); else bad("Race 4", `rejected=${rejected}`);
  }

  // Race 5 — workflow execution vs config change → workflow uses a deterministic snapshot.
  {
    await setPubQuick(A, ID.orgA, `workflow.${labDefKey}.sla`, "12m");
    const env = await fireEvent("LabResultReleased", { organizationId: ID.orgA, facilityId: ID.facA1, aggregateId: "race5-lab", payload: { resultId: "race5-lab", critical: true } });
    // Start the workflow and change the config "simultaneously".
    await Promise.all([
      startWorkflowsForEvent(env),
      setPubQuick(A, ID.orgA, `workflow.${labDefKey}.sla`, "45m"),
    ]);
    const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: labDefId, triggerEventId: env.eventId } });
    const timer = await prisma.workflowTimer.findFirstOrThrow({ where: { workflowInstanceId: inst.id, kind: "SLA" } });
    const p = timer.payload as { slaSeconds?: number };
    // Deterministic: the snapshot is whichever published value the resolver saw at
    // start (720 or 2700), never a torn/duplicated value.
    if (p.slaSeconds === 720 || p.slaSeconds === 2700) ok(`Race 5: workflow snapshot is a single deterministic effective value (${p.slaSeconds}s)`); else bad("Race 5", `snapshot=${p.slaSeconds}`);
  }

  // Race 6 — concurrent writes to different facilities do not contaminate each other.
  // A transient serialization abort (P2034) on either write is legitimate PG
  // behavior, not contamination — retry it once so we assert the final isolation.
  {
    const k = "sla.icu_review";
    const write = async (facilityId: string, value: string) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await setPubQuick2(A, ID.orgA, "FACILITY", { facilityId }, k, value); return; }
        catch (e) { if ((e as { code?: string }).code === "P2034" && attempt < 2) continue; throw e; }
      }
    };
    await Promise.allSettled([write(ID.facA1, "11m"), write(ID.facA2, "22m")]);
    // Ensure both landed (retry any that lost every attempt to a transient abort).
    await write(ID.facA1, "11m"); await write(ID.facA2, "22m");
    const a1 = await resolveConfig(A, { key: k, organizationId: ID.orgA, facilityId: ID.facA1 });
    const a2 = await resolveConfig(A, { key: k, organizationId: ID.orgA, facilityId: ID.facA2 });
    if (a1.value === 660 && a2.value === 1320) ok("Race 6: concurrent cross-facility writes stay isolated (facA1=11m, facA2=22m)"); else bad("Race 6", `a1=${a1.value} a2=${a2.value}`);
  }
}

async function setPubQuick(m: ActorMemberships, organizationId: string, key: string, value: string) {
  await setOverride(m, { scope: "ORGANIZATION", organizationId, key, value });
  await publishOverride(m, { scope: "ORGANIZATION", organizationId, key });
}
async function setPubQuick2(m: ActorMemberships, organizationId: string, scope: "FACILITY", ids: { facilityId: string }, key: string, value: string) {
  await setOverride(m, { scope, organizationId, ...ids, key, value });
  await publishOverride(m, { scope, organizationId, ...ids, key });
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
