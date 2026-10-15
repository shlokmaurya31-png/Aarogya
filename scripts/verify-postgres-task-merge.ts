/**
 * Workflow spine §9 step 5 (D6): the Task merge migrations refuse rather than guess.
 *
 * Builds a scratch database at the state just before 20261015180000_task_merge,
 * plants Task and WorkflowTask rows, and checks:
 *   1. Every row the migration cannot map is refused, by name, and nothing is
 *      changed: an unknown Task.source, a NULL source with nothing linking it, an
 *      OVERDUE task with no dueAt, a WorkflowTask with no tenant, with a facility
 *      outside its organization, with a patient or encounter outside its facility,
 *      and id or idempotency-key collisions.
 *   2. The mappable rows map: free-text sources → TaskSource, OVERDUE → OPEN with
 *      its dueAt, WorkflowTask → Task with the same id, status and links (an
 *      organization-level one with no facility).
 *   3. The drop migration refuses while a WorkflowTask row is not reachable as a
 *      Task, then drops the table.
 *   4. The merged table's constraints: a facility unless an organization-level
 *      workflow task; workflow links exactly on workflow tasks; workflow keys
 *      unique; OVERDUE no longer a status.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-task-merge.ts
 * (needs CREATEDB; it creates and drops its own scratch database.)
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "prisma", "migrations");
const MERGE = "20261015180000_task_merge";
const DROP = "20261015190000_drop_workflow_task";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required");
const scratchName = `aarogya_taskmerge_${Date.now().toString(36)}`;
const scratchUrl = (() => { const u = new URL(baseUrl); u.pathname = `/${scratchName}`; u.search = ""; return u.toString(); })();
const env = { ...process.env, DATABASE_URL: scratchUrl, DIRECT_URL: scratchUrl };

/** Run a SQL script against the scratch database; returns null on success or the error text. */
function sql(script: string): string | null {
  try {
    execFileSync("npx", ["prisma", "db", "execute", "--stdin", "--url", scratchUrl], { cwd: ROOT, env, input: script, stdio: ["pipe", "pipe", "pipe"] });
    return null;
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    return `${err.stderr?.toString() ?? ""}${err.stdout?.toString() ?? ""}`;
  }
}
const migration = (name: string) => readFileSync(path.join(MIGRATIONS, name, "migration.sql"), "utf8");
/** Apply `setup` then a migration inside one transaction that is always rolled back. */
const refusal = (setup: string, name: string) => sql(`BEGIN;\n${setup}\n${migration(name)}\nROLLBACK;`);

const BASE = `
INSERT INTO "Organization"(id, name) VALUES ('tm-org-a', 'A'), ('tm-org-b', 'B');
INSERT INTO "Facility"(id, name, "organizationId") VALUES ('tm-fac-a', 'A', 'tm-org-a'), ('tm-fac-b', 'B', 'tm-org-b');
INSERT INTO "User"(id, email, "passwordHash", role, "displayName", "updatedAt") VALUES ('tm-u', 'tm@taskmerge.local', 'x', 'DOCTOR', 'tm', now());
INSERT INTO "HospitalStaffProfile"(id, "userId", "displayRole") VALUES ('tm-staff', 'tm-u', 'Doctor');
INSERT INTO "Patient"(id, uhid, "facilityId", "fullName", sex, "updatedAt") VALUES
  ('tm-pt-a', 'TM-A', 'tm-fac-a', 'A', 'F', now()), ('tm-pt-a2', 'TM-A2', 'tm-fac-a', 'A2', 'M', now()), ('tm-pt-b', 'TM-B', 'tm-fac-b', 'B', 'F', now());
INSERT INTO "Encounter"(id, "patientId", "facilityId", type) VALUES ('tm-enc-a', 'tm-pt-a', 'tm-fac-a', 'IPD'), ('tm-enc-a2', 'tm-pt-a2', 'tm-fac-a', 'OPD');
INSERT INTO "CarePlan"(id, "createdByStaffId", "patientId", "facilityId", problem, goal) VALUES ('tm-cp', 'tm-staff', 'tm-pt-a', 'tm-fac-a', 'p', 'g');
INSERT INTO "Order"(id, "facilityId", "encounterId", "patientId", "orderingStaffId", "orderType") VALUES ('tm-order', 'tm-fac-a', 'tm-enc-a', 'tm-pt-a', 'tm-staff', 'LAB');
INSERT INTO "WorkflowDefinition"(id, key, name, "triggerEventType", "triggerEventVersion", "updatedAt") VALUES ('tm-def', 'tm-def', 'TM', 'AdmissionCreated', 1, now());
INSERT INTO "WorkflowVersion"(id, "workflowDefinitionId", version, config) VALUES ('tm-ver', 'tm-def', 1, '{}');
INSERT INTO "WorkflowInstance"(id, "workflowDefinitionId", "workflowVersionId", "triggerEventId", "idempotencyKey", "aggregateType", "aggregateId", "correlationId", "updatedAt")
  VALUES ('tm-inst', 'tm-def', 'tm-ver', 'ev1', 'tm-inst', 'ADMISSION', 'a1', 'c1', now());

INSERT INTO "Task"(id, "facilityId", title, type, status, source, "dueAt", "orderId", "idempotencyKey") VALUES
  ('tm-t-manual', 'tm-fac-a', 't', 'GENERAL', 'OPEN', 'manual', NULL, NULL, NULL),
  ('tm-t-lab', 'tm-fac-a', 't', 'SPECIMEN_COLLECTION', 'OPEN', 'lab-order', NULL, NULL, NULL),
  ('tm-t-img', 'tm-fac-a', 't', 'IMAGING_PREP', 'OPEN', 'imaging-order', NULL, NULL, NULL),
  ('tm-t-cp', 'tm-fac-a', 't', 'CARE_PLAN_INTERVENTION', 'OPEN', 'care-plan', NULL, NULL, NULL),
  ('tm-t-ev', 'tm-fac-a', 't', 'BED_ALLOCATION', 'COMPLETED', 'event', NULL, NULL, 'BED_ALLOCATION:r1'),
  ('tm-t-overdue', 'tm-fac-a', 't', 'GENERAL', 'OVERDUE', 'manual', '2026-01-01', NULL, NULL),
  ('tm-t-null-order', 'tm-fac-a', 't', 'SPECIMEN_COLLECTION', 'OPEN', NULL, NULL, 'tm-order', NULL),
  ('tm-t-null-cp', 'tm-fac-a', 't', 'CARE_PLAN_INTERVENTION', 'OPEN', NULL, NULL, NULL, NULL);
INSERT INTO "CarePlanIntervention"(id, "carePlanId", description, "responsibleRole", "taskId") VALUES ('tm-cpi', 'tm-cp', 'd', 'NURSE', 'tm-t-null-cp');
INSERT INTO "WorkflowTask"(id, "workflowInstanceId", "workflowStepId", "organizationId", "facilityId", "patientId", "encounterId", "taskType", title, priority, status,
  "assignedRole", "completedByUserId", "completedAt", "dueAt", "idempotencyKey", "updatedAt") VALUES
  ('tm-w-fac', 'tm-inst', 's1', 'tm-org-a', 'tm-fac-a', 'tm-pt-a', 'tm-enc-a', 'REVIEW', 'Review', 'STAT', 'COMPLETED', 'NURSE', 'tm-u', now(), '2026-02-01', 's1:task', now()),
  ('tm-w-org', 'tm-inst', 's2', 'tm-org-a', NULL, NULL, NULL, 'COLLECTIONS', 'Follow up', 'ROUTINE', 'EXPIRED', NULL, NULL, NULL, NULL, 's2:task', now());
`;

const wt = (id: string, cols: { org?: string | null; fac?: string | null; pt?: string | null; enc?: string | null; key?: string }) =>
  `INSERT INTO "WorkflowTask"(id, "workflowInstanceId", "organizationId", "facilityId", "patientId", "encounterId", "taskType", title, "idempotencyKey", "updatedAt") VALUES ('${id}', 'tm-inst', ${q(cols.org)}, ${q(cols.fac)}, ${q(cols.pt)}, ${q(cols.enc)}, 'X', 'x', '${cols.key ?? `${id}:key`}', now());`;
const q = (v: string | null | undefined) => (v == null ? "NULL" : `'${v}'`);

async function main() {
  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  const tmp = mkdtempSync(path.join(tmpdir(), "task-merge-"));
  let db: PrismaClient | null = null;
  try {
    // Scratch database at the state just before the merge.
    copyFileSync(path.join(ROOT, "prisma", "schema.prisma"), path.join(tmp, "schema.prisma"));
    mkdirSync(path.join(tmp, "migrations"));
    copyFileSync(path.join(MIGRATIONS, "migration_lock.toml"), path.join(tmp, "migrations", "migration_lock.toml"));
    for (const d of readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d) && d < MERGE)) cpSync(path.join(MIGRATIONS, d), path.join(tmp, "migrations", d), { recursive: true });
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", path.join(tmp, "schema.prisma")], { cwd: ROOT, env, stdio: "pipe" });
    const seeded = sql(BASE);
    if (seeded) throw new Error(`fixture rows failed: ${seeded}`);

    // 1. Refusals.
    const cases: [string, string, string][] = [
      ["an unknown Task.source", `INSERT INTO "Task"(id, "facilityId", title, type, source) VALUES ('tm-bad-src', 'tm-fac-a', 't', 'GENERAL', 'discharge-workflow');`, "discharge-workflow (tm-bad-src)"],
      ["a NULL Task.source with no order or care-plan link", `INSERT INTO "Task"(id, "facilityId", title, type) VALUES ('tm-bad-null', 'tm-fac-a', 't', 'GENERAL');`, "NULL (tm-bad-null)"],
      ["an OVERDUE task with no dueAt", `INSERT INTO "Task"(id, "facilityId", title, type, status, source) VALUES ('tm-bad-overdue', 'tm-fac-a', 't', 'GENERAL', 'OVERDUE', 'manual');`, "OVERDUE with no dueAt (cannot stay overdue once OVERDUE is derived): tm-bad-overdue"],
      ["a WorkflowTask with neither facility nor organization", wt("tm-bad-notenant", {}), "neither a facility nor an organization: tm-bad-notenant"],
      ["a WorkflowTask whose facility is outside its organization", wt("tm-bad-org", { org: "tm-org-a", fac: "tm-fac-b" }), "outside their organization: tm-bad-org"],
      ["a WorkflowTask naming another facility's patient", wt("tm-bad-pt", { org: "tm-org-a", fac: "tm-fac-a", pt: "tm-pt-b" }), "patient that does not exist in their facility: tm-bad-pt"],
      ["a WorkflowTask naming a patient that does not exist", wt("tm-bad-pt2", { org: "tm-org-a", fac: "tm-fac-a", pt: "p1" }), "patient that does not exist in their facility: tm-bad-pt2"],
      ["a WorkflowTask whose encounter belongs to another patient", wt("tm-bad-enc", { org: "tm-org-a", fac: "tm-fac-a", pt: "tm-pt-a", enc: "tm-enc-a2" }), "or belongs to another patient): tm-bad-enc"],
      ["a WorkflowTask id that collides with a Task id", wt("tm-t-manual", { org: "tm-org-a", fac: "tm-fac-a" }), "ids collide with Task ids: tm-t-manual"],
      ["a WorkflowTask idempotency key that collides with a Task key", wt("tm-bad-key", { org: "tm-org-a", fac: "tm-fac-a", key: "BED_ALLOCATION:r1" }), "keys collide with Task keys: BED_ALLOCATION:r1"],
    ];
    for (const [label, setup, expected] of cases) {
      const err = refusal(setup, MERGE);
      report(`The merge refuses ${label}, by name`, err !== null && err.includes(expected), err === null ? "migration succeeded" : err.includes(expected) ? undefined : err.slice(0, 300));
    }

    // 2. The mappable rows map.
    const applied = sql(migration(MERGE));
    report("With only mappable rows, the merge applies", applied === null, applied?.slice(0, 300));
    db = new PrismaClient({ datasourceUrl: scratchUrl });
    const rows = await db.$queryRawUnsafe<{ id: string; source: string; status: string; facilityId: string | null; organizationId: string | null; type: string; dueAt: Date | null; workflowInstanceId: string | null; workflowStepId: string | null; patientId: string | null; encounterId: string | null; priority: string; assignedRole: string | null; completedByUserId: string | null; idempotencyKey: string | null }[]>(
      `SELECT id, source::text, status::text, "facilityId", "organizationId", type, "dueAt", "workflowInstanceId", "workflowStepId", "patientId", "encounterId", priority::text, "assignedRole", "completedByUserId", "idempotencyKey" FROM "Task" WHERE id LIKE 'tm-%'`);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    const sources = ["tm-t-manual", "tm-t-lab", "tm-t-img", "tm-t-cp", "tm-t-ev", "tm-t-null-order", "tm-t-null-cp"].map((id) => `${id}=${by[id]?.source}`).join(" ");
    report("Free-text sources map to TaskSource (manual, lab/imaging order, care plan, event; NULL only via its order or intervention)",
      sources === "tm-t-manual=MANUAL tm-t-lab=ORDER tm-t-img=ORDER tm-t-cp=CARE_PLAN tm-t-ev=EVENT tm-t-null-order=ORDER tm-t-null-cp=CARE_PLAN", sources);
    const od = by["tm-t-overdue"];
    report("An OVERDUE task becomes OPEN and keeps its dueAt (overdue is derived now)", od?.status === "OPEN" && od.dueAt?.toISOString().startsWith("2026-01-01") === true);
    const wf = by["tm-w-fac"];
    report("A WorkflowTask becomes a Task with the same id, status, links and assignment",
      wf?.source === "WORKFLOW" && wf.status === "COMPLETED" && wf.facilityId === "tm-fac-a" && wf.organizationId === "tm-org-a" && wf.type === "REVIEW"
      && wf.workflowInstanceId === "tm-inst" && wf.workflowStepId === "s1" && wf.patientId === "tm-pt-a" && wf.encounterId === "tm-enc-a"
      && wf.priority === "STAT" && wf.assignedRole === "NURSE" && wf.completedByUserId === "tm-u" && wf.idempotencyKey === "s1:task");
    const org = by["tm-w-org"];
    report("An organization-level WorkflowTask becomes a Task with no facility, EXPIRED kept", org?.facilityId === null && org.organizationId === "tm-org-a" && org.status === "EXPIRED");
    report("No other rows appeared", rows.length === 10, String(rows.length));

    // 3. The drop refuses while a WorkflowTask row is not reachable as a Task.
    const stray = refusal(wt("tm-w-stray", { org: "tm-org-a", fac: "tm-fac-a" }), DROP);
    report("The drop refuses a WorkflowTask row that is not a Task (written between the two migrations)", stray !== null && stray.includes("not reachable as a matching Task: tm-w-stray"), stray === null ? "drop succeeded" : undefined);
    const dropped = sql(migration(DROP));
    const gone = await db.$queryRawUnsafe<{ t: string | null }[]>(`SELECT to_regclass('"WorkflowTask"')::text AS t`);
    report("Otherwise it drops WorkflowTask", dropped === null && gone[0].t === null, dropped?.slice(0, 200));

    // 4. Constraints of the merged table.
    const rejects = async (s: string) => db!.$executeRawUnsafe(s).then(() => false, () => true);
    report("A task with no facility is refused unless it is an organization-level workflow task",
      await rejects(`INSERT INTO "Task"(id, title, type, source, "organizationId") VALUES ('tm-c1', 't', 'GENERAL', 'MANUAL', 'tm-org-a')`));
    report("A workflow task without its instance is refused", await rejects(`INSERT INTO "Task"(id, "facilityId", title, type, source) VALUES ('tm-c2', 'tm-fac-a', 't', 'X', 'WORKFLOW')`));
    report("Workflow links on a non-workflow task are refused", await rejects(`INSERT INTO "Task"(id, "facilityId", title, type, source, "workflowInstanceId") VALUES ('tm-c3', 'tm-fac-a', 't', 'X', 'MANUAL', 'tm-inst')`));
    report("A workflow idempotency key is unique across facilities",
      await rejects(`INSERT INTO "Task"(id, "facilityId", title, type, source, "workflowInstanceId", "idempotencyKey") VALUES ('tm-c4', 'tm-fac-b', 't', 'X', 'WORKFLOW', 'tm-inst', 's1:task')`));
    report("OVERDUE is no longer a status", await rejects(`INSERT INTO "Task"(id, "facilityId", title, type, source, status) VALUES ('tm-c5', 'tm-fac-a', 't', 'X', 'MANUAL', 'OVERDUE')`));
  } finally {
    await db?.$disconnect();
    rmSync(tmp, { recursive: true, force: true });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
