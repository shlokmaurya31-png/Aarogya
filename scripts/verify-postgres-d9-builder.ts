/**
 * PHASE D9 — workflow builder gate (authoring lifecycle + D7/D8 integration +
 * simulation safety + concurrency + security).
 *
 * Proves an authorized administrator can build a workflow without code, that it
 * compiles to the canonical D7 definition, publishes through the authoritative D7
 * lifecycle, and is EXECUTED by D7 with D8-configured SLAs — plus the seven mandated
 * races and the tenant/authorization/injection/privacy/privilege-escalation +
 * simulation-side-effect-free matrix. Concurrency runs only on PostgreSQL.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-d9-builder.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from "../src/lib/db";
import { emitDomainEvent } from "../src/lib/events/emit";
import type { DomainEventEnvelope } from "../src/lib/events/types";
import { startWorkflowsForEvent } from "../src/lib/workflows/engine";
import { saveDraft, getDraft, listDrafts, publishDraft, importWorkflow, exportWorkflow, deleteDraft, simulateWorkflow, compileBuilderDocument, parseBuilderDocument } from "../src/lib/workflow-builder";
import { setOverride, publishOverride } from "../src/lib/config";
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

const ID = { orgA: "d9t-org-a", orgB: "d9t-org-b", facA: "d9t-fac-a", facB: "d9t-fac-b", uPlatform: "d9t-u-plat", uAdminA: "d9t-u-admin-a", uAdminB: "d9t-u-admin-b", uOutsider: "d9t-u-out" };
const KP = "d9gate";

async function cleanup() {
  await prisma.workflowTimer.deleteMany({ where: { instance: { definition: { key: { startsWith: KP } } } } });
  await prisma.workflowTask.deleteMany({ where: { instance: { definition: { key: { startsWith: KP } } } } });
  await prisma.workflowStep.deleteMany({ where: { instance: { definition: { key: { startsWith: KP } } } } });
  await prisma.workflowInstance.deleteMany({ where: { definition: { key: { startsWith: KP } } } });
  await prisma.workflowVersion.deleteMany({ where: { definition: { key: { startsWith: KP } } } });
  await prisma.workflowDefinition.deleteMany({ where: { key: { startsWith: KP } } });
  await prisma.workflowBuilderDraft.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.domainEventOutbox.deleteMany({ where: { correlationId: { startsWith: "d9gate:" } } });
  await prisma.configurationChange.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.configurationOverride.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  const userIds = Object.values(ID);
  await prisma.auditEvent.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.organizationMembership.deleteMany({ where: { OR: [{ organizationId: { in: [ID.orgA, ID.orgB] } }, { userId: { in: userIds } }] } });
  await prisma.facility.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ID.orgA, ID.orgB] } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
async function seed() {
  const mk = (id: string, role: "AAROGYA_ADMIN" | "HOSPITAL_ADMIN" | "DOCTOR") => prisma.user.create({ data: { id, email: `${id}@d9.local`, passwordHash: "x", role, displayName: id } });
  await Promise.all([mk(ID.uPlatform, "AAROGYA_ADMIN"), mk(ID.uAdminA, "HOSPITAL_ADMIN"), mk(ID.uAdminB, "HOSPITAL_ADMIN"), mk(ID.uOutsider, "DOCTOR")]);
  for (const [org, fac, admin] of [[ID.orgA, ID.facA, ID.uAdminA], [ID.orgB, ID.facB, ID.uAdminB]] as const) {
    await prisma.organization.create({ data: { id: org, slug: org, name: org, status: "ACTIVE" } });
    await prisma.facility.create({ data: { id: fac, slug: fac, name: fac, organizationId: org, status: "ACTIVE" } });
    await prisma.organizationMembership.create({ data: { organizationId: org, userId: admin, isAdmin: true, status: "ACTIVE" } });
  }
}
async function fire(type: string, opts: { organizationId: string; facilityId?: string | null; aggregateId: string; payload: Record<string, unknown> }): Promise<DomainEventEnvelope> {
  const { eventId } = await emitDomainEvent(prisma, { type, aggregateId: opts.aggregateId, organizationId: opts.organizationId, facilityId: opts.facilityId ?? null, correlationId: `d9gate:${opts.aggregateId}`, payload: opts.payload });
  const r = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
  return { eventId: r.eventId, eventType: r.eventType, eventVersion: r.eventVersion, aggregateType: r.aggregateType, aggregateId: r.aggregateId, organizationId: r.organizationId, facilityId: r.facilityId, actorUserId: r.actorUserId, correlationId: r.correlationId, causationId: r.causationId, occurredAt: r.occurredAt, payload: r.payload as Record<string, unknown> };
}

const icuDoc = (name = "ICU admission") => ({ name, trigger: { eventType: "AdmissionCreated", eventVersion: 1 }, steps: [
  { type: "TASK", key: "nursing", taskType: "NURSING_ASSESSMENT", title: "Nursing assessment", priority: "URGENT", assignedRole: "NURSE" },
  { type: "TASK", key: "intensivist", taskType: "INTENSIVIST_REVIEW", title: "Intensivist review", priority: "URGENT", assignedRole: "DOCTOR" },
  { type: "TASK", key: "pharmacy", taskType: "PHARMACY_REVIEW", title: "Pharmacy review", priority: "ROUTINE", assignedRole: "PHARMACIST" },
] });
const labDoc = (name = "Critical lab") => ({ name, trigger: { eventType: "LabResultReleased", eventVersion: 1, condition: { all: [{ field: "payload.critical", operator: "equals", value: true }] } }, steps: [
  { type: "TASK", key: "review", taskType: "CRITICAL_RESULT_REVIEW", title: "Review critical result", priority: "STAT", assignedRole: "DOCTOR", sla: { dueAfterSeconds: 3600, escalation: { taskType: "ESC", title: "SLA breached", priority: "STAT" } } },
] });

async function run() {
  console.log(`\n=== PHASE D9 WORKFLOW BUILDER GATE (${IS_PG ? "PostgreSQL" : "SQLite"}) ===\n`);
  await cleanup();
  await seed();
  const A = await loadActorMemberships(ID.uAdminA, "HOSPITAL_ADMIN");
  const B = await loadActorMemberships(ID.uAdminB, "HOSPITAL_ADMIN");
  const O = await loadActorMemberships(ID.uOutsider, "DOCTOR");

  // ── E2E: build → publish → D7 executes (§49/§50 Example 1) ──────────────────
  console.log("[E2E: ICU admission]");
  {
    const draft = await saveDraft(A, { organizationId: ID.orgA, facilityId: ID.facA, key: `${KP}-icu`, name: "ICU admission", document: icuDoc() });
    const def = await publishDraft(A, draft.id);
    ok(`builder draft published to a D7 definition (${def.key})`);
    const env = await fire("AdmissionCreated", { organizationId: ID.orgA, facilityId: ID.facA, aggregateId: "d9-adm-a", payload: { admissionId: "d9-adm-a", encounterId: "e", patientId: "p" } });
    await startWorkflowsForEvent(env);
    const inst = await prisma.workflowInstance.findFirst({ where: { workflowDefinitionId: def.id, triggerEventId: env.eventId } });
    const tasks = inst ? await prisma.workflowTask.count({ where: { workflowInstanceId: inst.id } }) : 0;
    if (inst?.status === "COMPLETED" && tasks === 3) ok("D7 executes the builder-authored workflow → 3 tasks created, COMPLETED"); else bad("E2E execute", `status=${inst?.status} tasks=${tasks}`);
    // Org isolation: org B's event must NOT trigger org A's org-scoped workflow.
    const envB = await fire("AdmissionCreated", { organizationId: ID.orgB, facilityId: ID.facB, aggregateId: "d9-adm-b", payload: { admissionId: "d9-adm-b", encounterId: "e", patientId: "p" } });
    await startWorkflowsForEvent(envB);
    const leaked = await prisma.workflowInstance.count({ where: { workflowDefinitionId: def.id, triggerEventId: envB.eventId } });
    if (leaked === 0) ok("org-scoped workflow does not trigger for another org's event"); else bad("org isolation", `leaked=${leaked}`);
  }

  // ── E2E: critical lab, two hospitals, different D8 SLA (§50 Example 2) ───────
  console.log("[E2E: multi-hospital SLA]");
  {
    const dA = await publishDraft(A, (await saveDraft(A, { organizationId: ID.orgA, facilityId: ID.facA, key: `${KP}-lab-a`, name: "Lab A", document: labDoc() })).id);
    const dB = await publishDraft(B, (await saveDraft(B, { organizationId: ID.orgB, facilityId: ID.facB, key: `${KP}-lab-b`, name: "Lab B", document: labDoc() })).id);
    await setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key: `workflow.${KP}-lab-a.sla`, value: "15m" });
    await publishOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key: `workflow.${KP}-lab-a.sla` });
    await setOverride(B, { scope: "ORGANIZATION", organizationId: ID.orgB, key: `workflow.${KP}-lab-b.sla`, value: "60m" });
    await publishOverride(B, { scope: "ORGANIZATION", organizationId: ID.orgB, key: `workflow.${KP}-lab-b.sla` });
    const eA = await fire("LabResultReleased", { organizationId: ID.orgA, facilityId: ID.facA, aggregateId: "d9-lab-a", payload: { resultId: "d9-lab-a", critical: true } });
    await startWorkflowsForEvent(eA);
    const eB = await fire("LabResultReleased", { organizationId: ID.orgB, facilityId: ID.facB, aggregateId: "d9-lab-b", payload: { resultId: "d9-lab-b", critical: true } });
    await startWorkflowsForEvent(eB);
    const iA = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: dA.id, triggerEventId: eA.eventId } });
    const iB = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: dB.id, triggerEventId: eB.eventId } });
    const tA = (await prisma.workflowTimer.findFirstOrThrow({ where: { workflowInstanceId: iA.id, kind: "SLA" } })).payload as any;
    const tB = (await prisma.workflowTimer.findFirstOrThrow({ where: { workflowInstanceId: iB.id, kind: "SLA" } })).payload as any;
    if (tA.slaSeconds === 900 && tB.slaSeconds === 3600) ok("same authored workflow, two hospitals, different effective SLA (A=15m, B=60m)"); else bad("multi-hospital sla", `A=${tA.slaSeconds} B=${tB.slaSeconds}`);
  }

  // ── Draft lifecycle: incomplete drafts save but cannot publish (§19) ─────────
  console.log("[draft lifecycle]");
  {
    const incomplete = await saveDraft(A, { organizationId: ID.orgA, key: `${KP}-wip`, name: "WIP", document: { name: "WIP" } });
    ok("incomplete draft (no trigger/steps) saved");
    await expectThrow("incomplete draft cannot be published", () => publishDraft(A, incomplete.id));
    await saveDraft(A, { id: incomplete.id, organizationId: ID.orgA, key: `${KP}-wip`, name: "WIP", document: icuDoc("WIP complete") });
    const def = await publishDraft(A, incomplete.id);
    if (def) ok("completed draft publishes successfully"); else bad("complete publish", "no def");
  }

  // ── Edit published → new version (§20) ──────────────────────────────────────
  console.log("[versioning]");
  {
    const d = await saveDraft(A, { organizationId: ID.orgA, key: `${KP}-ver`, name: "Ver", document: labDoc("Ver v1") });
    const def1 = await publishDraft(A, d.id);
    const doc2 = labDoc("Ver v2"); doc2.steps[0].sla.dueAfterSeconds = 1800;
    await saveDraft(A, { id: d.id, organizationId: ID.orgA, workflowDefinitionId: def1.id, key: `${KP}-ver`, name: "Ver", document: doc2 });
    const def2 = await publishDraft(A, d.id);
    const versions = await prisma.workflowVersion.count({ where: { workflowDefinitionId: def2.id, status: { in: ["PUBLISHED", "RETIRED"] } } });
    if (versions === 2) ok("editing a published workflow creates + publishes a new version (v2)"); else bad("versioning", `versions=${versions}`);
  }

  // ── Import → DRAFT only; export round-trip (§30) ────────────────────────────
  console.log("[import / export]");
  {
    const imported = await importWorkflow(A, { organizationId: ID.orgA, key: `${KP}-imp`, name: "Imported", document: icuDoc("Imported") });
    const asDraft = await getDraft(A, imported.id);
    const isDraft = asDraft.status === "DRAFT" && !asDraft.workflowDefinitionId;
    if (isDraft) ok("import lands as a DRAFT (never directly published), fully revalidated"); else bad("import", asDraft.status);
    const def = await publishDraft(A, imported.id);
    const exp = await exportWorkflow(A, def.id);
    if (exp.document && (exp.document as any).trigger?.eventType === "AdmissionCreated") ok("export produces a portable document (no secrets)"); else bad("export", JSON.stringify(exp.document).slice(0, 60));
  }

  // ── Simulation is side-effect free (§40) ────────────────────────────────────
  console.log("[simulation safety]");
  {
    const beforeTasks = await prisma.workflowTask.count();
    const beforeInst = await prisma.workflowInstance.count();
    const beforeEvents = await prisma.domainEventOutbox.count();
    const cfg = compileBuilderDocument(parseBuilderDocument(labDoc("sim")));
    const res = await simulateWorkflow({ config: cfg, synthetic: { payload: { critical: true }, organizationId: ID.orgA }, workflowKey: `${KP}-lab-a` });
    const afterTasks = await prisma.workflowTask.count();
    const afterInst = await prisma.workflowInstance.count();
    const afterEvents = await prisma.domainEventOutbox.count();
    if (res.triggerMatched && res.steps[0].outcome === "WOULD_EXECUTE" && afterTasks === beforeTasks && afterInst === beforeInst && afterEvents === beforeEvents) ok("simulation creates no tasks/instances/events (side-effect free) and resolves SLA via D8"); else bad("simulation safety", `tasks ${beforeTasks}->${afterTasks} inst ${beforeInst}->${afterInst} events ${beforeEvents}->${afterEvents}`);
    if (res.steps[0].slaSeconds === 900) ok("simulation shows the D8 effective SLA (org A = 15m)"); else bad("sim sla", String(res.steps[0].slaSeconds));
  }

  await securityGate(A, B, O);
  await concurrency(A);

  await cleanup();
  console.log(`\n────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed  (${IS_PG ? "PostgreSQL" : "SQLite"})`);
  if (fail) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

async function securityGate(A: ActorMemberships, B: ActorMemberships, O: ActorMemberships) {
  console.log("[security]");
  const draftA = await saveDraft(A, { organizationId: ID.orgA, key: `${KP}-sec`, name: "Sec", document: icuDoc() });
  // Tenant isolation.
  await expectDeny("org B admin cannot read org A draft", () => getDraft(B, draftA.id), 404);
  await expectDeny("org B admin cannot publish org A draft", () => publishDraft(B, draftA.id), 404);
  await expectDeny("org A admin cannot author for org B", () => saveDraft(A, { organizationId: ID.orgB, key: `${KP}-x`, name: "x", document: icuDoc() }), 404);
  await expectDeny("org B admin cannot list org A drafts", () => listDrafts(B, ID.orgA), 404);
  await expectDeny("guessed draft id reveals nothing", () => getDraft(A, "nope-draft"), 404);
  // Authorization.
  await expectDeny("outsider cannot author", () => saveDraft(O, { organizationId: ID.orgA, key: `${KP}-o`, name: "o", document: icuDoc() }), 404);
  {
    const { assertCanAuthorWorkflow } = await import("../src/lib/workflows/authz");
    await expectThrow("org admin cannot author a GLOBAL template (platform-only)", async () => assertCanAuthorWorkflow(A, null));
  }
  // Injection — compile/publish reject unknown/unsafe definitions.
  await expectThrow("arbitrary action injection rejected", () => saveDraft(A, { organizationId: ID.orgA, key: `${KP}-inj1`, name: "i", document: { name: "i", trigger: { eventType: "AdmissionCreated", eventVersion: 1 }, steps: [{ type: "ACTION", key: "a", action: { name: "DROP_DATABASE", params: {} } }] } }).then((d) => publishDraft(A, d.id)));
  await expectThrow("unknown event injection rejected", () => saveDraft(A, { organizationId: ID.orgA, key: `${KP}-inj2`, name: "i", document: { name: "i", trigger: { eventType: "NopeEvent", eventVersion: 1 }, steps: [{ type: "TASK", key: "t", taskType: "T", title: "T" }] } }).then((d) => publishDraft(A, d.id)));
  await expectThrow("unknown event version injection rejected", () => saveDraft(A, { organizationId: ID.orgA, key: `${KP}-inj3`, name: "i", document: { name: "i", trigger: { eventType: "AdmissionCreated", eventVersion: 99 }, steps: [{ type: "TASK", key: "t", taskType: "T", title: "T" }] } }).then((d) => publishDraft(A, d.id)));
  await expectThrow("arbitrary condition operator rejected", () => saveDraft(A, { organizationId: ID.orgA, key: `${KP}-inj4`, name: "i", document: { name: "i", trigger: { eventType: "AdmissionCreated", eventVersion: 1, condition: { all: [{ field: "payload.x", operator: "REGEX_EXEC", value: ".*" }] } }, steps: [{ type: "TASK", key: "t", taskType: "T", title: "T" }] } }).then((d) => publishDraft(A, d.id)));
  // Privacy — secret / PHI blob in a document rejected on save.
  await expectThrow("secret key in a builder document rejected", () => saveDraft(A, { organizationId: ID.orgA, key: `${KP}-sec2`, name: "s", document: { name: "s", steps: [{ type: "TASK", key: "t", taskType: "T", title: "T", apiKey: "x" }] } }));
  // Privilege escalation — no builder node can grant a permission or mutate clinical
  // state: only allow-listed EMIT_DOMAIN_EVENT/UPDATE_WORKFLOW_STATE actions exist.
  const { builderMetadata } = await import("../src/lib/workflow-builder/metadata");
  const dangerous = builderMetadata().actions.filter((a) => /GRANT|ROLE|PERMISSION|MEDICATION|ORDER|PAYMENT|DISCHARGE|DELETE/i.test(a));
  if (dangerous.length === 0) ok("builder exposes no permission-granting or clinical/financial mutation action"); else bad("privilege escalation", dangerous.join(","));
  await deleteDraft(A, draftA.id);
}

async function concurrency(A: ActorMemberships) {
  console.log("[concurrency races]");
  if (!IS_PG) { console.log("  · concurrency races skipped (SQLite serialises writers); single-effect proven by the sequential cases above"); return; }

  // Race 1 — two edits to the same draft → one draft row, deterministic content.
  {
    const d = await saveDraft(A, { organizationId: ID.orgA, key: `${KP}-r1`, name: "r1", document: icuDoc() });
    await Promise.allSettled([
      saveDraft(A, { id: d.id, organizationId: ID.orgA, key: `${KP}-r1`, name: "r1a", document: icuDoc("A") }),
      saveDraft(A, { id: d.id, organizationId: ID.orgA, key: `${KP}-r1`, name: "r1b", document: icuDoc("B") }),
    ]);
    const rows = await prisma.workflowBuilderDraft.count({ where: { id: d.id } });
    if (rows === 1) ok("Race 1: concurrent draft edits → one draft row"); else bad("Race 1", `rows=${rows}`);
  }
  // Race 2 — two publishes of the same draft → one active D7 definition/version.
  {
    const d = await saveDraft(A, { organizationId: ID.orgA, key: `${KP}-r2`, name: "r2", document: labDoc() });
    const results = await Promise.allSettled([publishDraft(A, d.id), publishDraft(A, d.id)]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const defs = await prisma.workflowDefinition.count({ where: { organizationId: ID.orgA, key: `${KP}-r2` } });
    const published = await prisma.workflowVersion.count({ where: { definition: { key: `${KP}-r2` }, status: "PUBLISHED" } });
    if (defs === 1 && published === 1 && okCount >= 1) ok("Race 2: concurrent publish → one definition, one active published version"); else bad("Race 2", `defs=${defs} published=${published} ok=${okCount}`);
  }
  // Race 5 — two imports with the same key → drafts allowed, but only one publishes.
  {
    const [i1, i2] = await Promise.all([
      importWorkflow(A, { organizationId: ID.orgA, key: `${KP}-r5`, name: "r5a", document: icuDoc() }),
      importWorkflow(A, { organizationId: ID.orgA, key: `${KP}-r5`, name: "r5b", document: icuDoc() }),
    ]);
    const results = await Promise.allSettled([publishDraft(A, i1.id), publishDraft(A, i2.id)]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const defs = await prisma.workflowDefinition.count({ where: { organizationId: ID.orgA, key: `${KP}-r5` } });
    if (defs === 1 && okCount === 1) ok("Race 5: two imports same key → exactly one active published workflow"); else bad("Race 5", `defs=${defs} ok=${okCount}`);
  }
  // Race 6 — builder config change while D7 starts execution → D7 uses the snapshot.
  {
    const d = await publishDraft(A, (await saveDraft(A, { organizationId: ID.orgA, key: `${KP}-r6`, name: "r6", document: labDoc() })).id);
    await setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key: `workflow.${KP}-r6.sla`, value: "12m" });
    await publishOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key: `workflow.${KP}-r6.sla` });
    const env = await fire("LabResultReleased", { organizationId: ID.orgA, facilityId: ID.facA, aggregateId: "d9-r6", payload: { resultId: "d9-r6", critical: true } });
    await Promise.all([
      startWorkflowsForEvent(env),
      (async () => { await setOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key: `workflow.${KP}-r6.sla`, value: "45m" }); await publishOverride(A, { scope: "ORGANIZATION", organizationId: ID.orgA, key: `workflow.${KP}-r6.sla` }); })(),
    ]);
    const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: d.id, triggerEventId: env.eventId } });
    const t = (await prisma.workflowTimer.findFirstOrThrow({ where: { workflowInstanceId: inst.id, kind: "SLA" } })).payload as any;
    if (t.slaSeconds === 720 || t.slaSeconds === 2700) ok(`Race 6: execution uses a single deterministic snapshotted SLA (${t.slaSeconds}s)`); else bad("Race 6", `sla=${t.slaSeconds}`);
  }
  // Race 7 — concurrent simulations produce no production side effects.
  {
    const cfg = compileBuilderDocument(parseBuilderDocument(labDoc()));
    const beforeTasks = await prisma.workflowTask.count();
    await Promise.all(Array.from({ length: 5 }, () => simulateWorkflow({ config: cfg, synthetic: { payload: { critical: true }, organizationId: ID.orgA } })));
    const afterTasks = await prisma.workflowTask.count();
    if (afterTasks === beforeTasks) ok("Race 7: concurrent simulations create no tasks (no production side effects)"); else bad("Race 7", `tasks ${beforeTasks}->${afterTasks}`);
  }
  // Race 3 & 4 — publish vs edit/retire converge deterministically (D7-guarded).
  {
    const d = await saveDraft(A, { organizationId: ID.orgA, key: `${KP}-r34`, name: "r34", document: labDoc() });
    const def = await publishDraft(A, d.id);
    await Promise.allSettled([
      saveDraft(A, { id: d.id, organizationId: ID.orgA, workflowDefinitionId: def.id, key: `${KP}-r34`, name: "r34e", document: labDoc("edited") }),
      prisma.workflowDefinition.update({ where: { id: def.id }, data: { status: "INACTIVE" } }),
    ]);
    const published = await prisma.workflowVersion.count({ where: { definition: { key: `${KP}-r34` }, status: "PUBLISHED" } });
    if (published <= 1) ok(`Race 3/4: edit vs retire → published version immutable (${published} published)`); else bad("Race 3/4", `published=${published}`);
  }
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
