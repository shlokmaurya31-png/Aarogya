/**
 * docs/POSTGRES_CUTOVER_REPORT.md §8 end state, so it can't quietly regress:
 *
 *   1. No text column named like a status / priority / severity / urgency /
 *      state, except the deliberate ones in ALLOWED_TEXT (each with a reason).
 *      A new `status String` column fails here until it is an enum, a CHECKed
 *      set, or allowlisted on purpose.
 *   2. Every idempotencyKey is unique per tenant: a unique index on
 *      (facilityId | organizationId, idempotencyKey), never on the key alone,
 *      except the engine-generated workflow keys (§8.4).
 *   3. The CHECKed text sets and currency codes refuse an out-of-set value.
 *   4. The Scholar lists are text[].
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-schema-constraints.ts
 */
import { prisma } from "../src/lib/db";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

/** Status-like text columns that stay text on purpose, or await a decision outside §8. */
const ALLOWED_TEXT: Record<string, string> = {
  "HealthInformationExchange.abdmProtocolState": "ABDM protocol states: external spec (§8.2)",
  "NhcxExchange.protocolState": "NHCX protocol states: contract not yet verified (§8.2)",
  "ExternalIdentifier.syncStatus": "free-form registry sync detail, nullable",
  "InteropConnection.lastHealthState": "last health-probe result from an external system",
  // Found by the §8 re-grep (not in the §8 inventory). Awaiting a decision; listed in the Week 2 report.
  "Allergy.severity": "not in §8 inventory — decision pending",
  "Problem.severity": "not in §8 inventory — decision pending",
  "Problem.status": "not in §8 inventory (lowercase values) — decision pending",
  "BiomedicalEquipment.calibrationStatus": "not in §8 inventory — decision pending",
  "Encounter.referralUrgency": "not in §8 inventory — decision pending",
  "PharmacyStorageCheck.status": "not in §8 inventory — decision pending",
  "QualityIncidentTransition.fromStatus": "history of QualityIncident.status — decision pending",
  "QualityIncidentTransition.toStatus": "history of QualityIncident.status — decision pending",
  "Surgery.consentStatus": "not in §8 inventory — decision pending",
  "TriageAssessment.mentalStatus": "clinical observation, not a lifecycle — decision pending",
  "TriageAssessment.pregnancyStatus": "clinical observation, not a lifecycle — decision pending",
};
const ENGINE_KEYS = new Set(["WorkflowInstance", "WorkflowTask", "WorkflowTimer"]);

async function refused(sql: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(sql);
    throw new Error("accepted");
  }).then(() => false, (e: Error) => e.message !== "accepted");
}

async function main() {
  // 1. Status-like text columns.
  const textCols = (await prisma.$queryRaw<{ c: string }[]>`
    SELECT table_name || '.' || column_name AS c FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'text' AND column_name ~* '(status|priority|severity|urgency|state)$'`).map((r) => r.c);
  const unexpected = textCols.filter((c) => !ALLOWED_TEXT[c]);
  report(`No unexpected status-like text column (${textCols.length} allowlisted)`, unexpected.length === 0, unexpected.join(", "));
  const stale = Object.keys(ALLOWED_TEXT).filter((c) => !textCols.includes(c));
  report("The allowlist has no stale entries", stale.length === 0, stale.join(", "));
  const enumCols = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'USER-DEFINED' AND udt_name <> 'vector'`;
  report("Enum-typed columns exist in number", Number(enumCols[0].n) > 200, `${enumCols[0].n}`);

  // 2. Idempotency keys unique per tenant.
  const idx = await prisma.$queryRaw<{ tbl: string; def: string }[]>`
    SELECT tablename AS tbl, indexdef AS def FROM pg_indexes
    WHERE schemaname = 'public' AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%"idempotencyKey"%'`;
  const keyed = await prisma.$queryRaw<{ tbl: string }[]>`
    SELECT table_name AS tbl FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'idempotencyKey'`;
  const problems: string[] = [];
  for (const { tbl } of keyed) {
    const defs = idx.filter((i) => i.tbl === tbl).map((i) => i.def);
    if (ENGINE_KEYS.has(tbl)) continue;
    const perTenant = defs.some((d) => /\("(facilityId|organizationId)", "idempotencyKey"\)/.test(d));
    const global = defs.some((d) => /\("idempotencyKey"\)/.test(d));
    if (!perTenant || global) problems.push(`${tbl}: ${defs.join(" | ") || "no unique index"}`);
  }
  report(`Every idempotency key is unique per tenant (${keyed.length - ENGINE_KEYS.size} tables)`, problems.length === 0, problems.join("; "));

  // 3. CHECKs refuse out-of-set values.
  const facility = "fac-amc-pune";
  report("A text set refuses an unknown value (Notification.category)",
    await refused(`UPDATE "Notification" SET category = 'MARKETING' WHERE id = (SELECT id FROM "Notification" LIMIT 1)`)
      || (await prisma.notification.count()) === 0);
  report("A currency refuses a non-ISO code (Charge.currency)",
    await refused(`UPDATE "Charge" SET currency = 'rupees' WHERE id = (SELECT id FROM "Charge" WHERE "facilityId" = '${facility}' LIMIT 1)`)
      || (await prisma.charge.count({ where: { facilityId: facility } })) === 0);
  report("An enum refuses an unknown value (Task.status)",
    await refused(`UPDATE "Task" SET status = 'DONE' WHERE id = (SELECT id FROM "Task" LIMIT 1)`) || (await prisma.task.count()) === 0);
  report("learnerTracks refuses a value that isn't a LearningTrack",
    await refused(`UPDATE "ClinicalCase" SET "learnerTracks" = ARRAY['ASTRONAUT'] WHERE id = (SELECT id FROM "ClinicalCase" LIMIT 1)`)
      || (await prisma.clinicalCase.count()) === 0);
  const checks = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace AND conname LIKE '%\_check' ESCAPE '\\'`;
  report("The §8 CHECK constraints are present", Number(checks[0].n) >= 34, `${checks[0].n}`);

  // 4. Scholar lists.
  const arrays = await prisma.$queryRaw<{ c: string; t: string }[]>`
    SELECT table_name || '.' || column_name AS c, data_type AS t FROM information_schema.columns
    WHERE table_schema = 'public' AND (table_name, column_name) IN
      (('StudentProfile','clinicalInterests'), ('ClinicalCase','learningObjectives'), ('NotebookEntry','tags'),
       ('LearningRecommendation','caseIds'), ('ClinicalCase','learnerTracks'))`;
  report("The 5 Scholar lists are text[]", arrays.length === 5 && arrays.every((a) => a.t === "ARRAY"), arrays.map((a) => `${a.c}:${a.t}`).join(", "));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
