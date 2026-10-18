/**
 * Phase 0 — move existing PATIENT accounts onto Persons
 * (src/lib/person/migration.ts; docs/PERSON_IDENTITY_DESIGN.md §10).
 * Refuses rather than guesses; idempotent; one transaction per account.
 *
 *   --dry-run          plan only, write nothing (default: write)
 *   --accept-refusals  exit 0 even when some accounts were refused
 *                      (refused accounts are still left untouched)
 *
 * Safety: refuses any database that is not on localhost unless
 * IDENTITY_MIGRATE_ALLOW_REMOTE=1, and refuses Supabase hosts even then
 * (staging is migrated deliberately, never from here by default).
 *
 * Usage: npm run identity:migrate -- [--dry-run] [--accept-refusals]
 */
import { prisma } from "../src/lib/db";
import { migrateIdentities } from "../src/lib/person/migration";

function hostOf(url: string | undefined): string {
  try { return new URL(url ?? "").hostname; } catch { return ""; }
}

/**
 * The same plan as migration.ts#planAccount, for a schema without Phase 0
 * tables: read-only SELECTs over User, Patient, AuditEvent,
 * PatientLinkRequest and ClinicalDocument (no Person can exist yet, so
 * nothing is "already migrated" and no record is already linked).
 */
async function legacyDryRun() {
  const has = async (table: string) => Boolean((await prisma.$queryRawUnsafe<{ t: string | null }[]>(`SELECT to_regclass('public."${table}"')::text AS t`))[0]?.t);
  const n = async (sql: string) => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql))[0].n);
  const linkRequests = await has("PatientLinkRequest");
  const linked = `FROM "User" u JOIN "Patient" p ON p."userId" = u."id" WHERE u."role" = 'PATIENT'`;
  const selfCreated = `EXISTS (SELECT 1 FROM "AuditEvent" a WHERE a."type" = 'patient.account.registered' AND a."userId" = u."id" AND a."detail"->>'patientId' = p."id")`;
  const byCode = linkRequests ? `EXISTS (SELECT 1 FROM "PatientLinkRequest" r WHERE r."userId" = u."id" AND r."candidatePatientId" = p."id" AND r."status" = 'LINKED' AND r."resolvedByUserId" IS NULL)` : "false";
  const byDesk = linkRequests ? `EXISTS (SELECT 1 FROM "PatientLinkRequest" r WHERE r."userId" = u."id" AND r."candidatePatientId" = p."id" AND r."status" = 'LINKED' AND r."resolvedByUserId" IS NOT NULL)` : "false";
  const live = `p."mergedIntoId" IS NULL`;
  return {
    dryRun: true,
    schemaBehind: true,
    note: "This database predates Phase 0 (no Person tables); planned read-only from the pre-Phase-0 tables. Nothing was written.",
    accountsSeen: await n(`SELECT count(*) AS n FROM "User" WHERE "role" = 'PATIENT'`),
    alreadyMigrated: 0,
    personsCreated: await n(`SELECT count(*) AS n FROM "User" u WHERE u."role" = 'PATIENT' AND NOT EXISTS (SELECT 1 FROM "Patient" p WHERE p."userId" = u."id" AND p."mergedIntoId" IS NOT NULL)`),
    linksActive: {
      SELF_CREATED: await n(`SELECT count(*) AS n ${linked} AND ${live} AND ${selfCreated}`),
      OTP_RECORD_CONTACT: await n(`SELECT count(*) AS n ${linked} AND ${live} AND NOT ${selfCreated} AND ${byCode}`),
    },
    linksReverificationRequired: {
      FRONT_DESK_LINK: await n(`SELECT count(*) AS n ${linked} AND ${live} AND NOT ${selfCreated} AND NOT ${byCode} AND ${byDesk}`),
      NO_EVIDENCE: await n(`SELECT count(*) AS n ${linked} AND ${live} AND NOT ${selfCreated} AND NOT ${byCode} AND NOT ${byDesk}`),
    },
    accountsWithoutRecord: await n(`SELECT count(*) AS n FROM "User" u WHERE u."role" = 'PATIENT' AND NOT EXISTS (SELECT 1 FROM "Patient" p WHERE p."userId" = u."id")`),
    refusals: { MERGED_RECORD: await n(`SELECT count(*) AS n ${linked} AND p."mergedIntoId" IS NOT NULL`), RECORD_ALREADY_LINKED: 0 },
    uploadsByPatientAccounts: await n(`SELECT count(*) AS n FROM "ClinicalDocument" d JOIN "User" u ON u."id" = d."uploadedByUserId" WHERE u."role" = 'PATIENT'`),
    openLinkRequests: linkRequests ? await n(`SELECT count(*) AS n FROM "PatientLinkRequest" WHERE "status" IN ('OTP_SENT', 'FRONT_DESK_REVIEW')`) : 0,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const host = hostOf(process.env.DATABASE_URL);
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  if (/supabase\./.test(host)) throw new Error(`Refusing: ${host} is a Supabase host.`);
  if (!local && process.env.IDENTITY_MIGRATE_ALLOW_REMOTE !== "1") throw new Error(`Refusing: ${host || "(no host)"} is not localhost (set IDENTITY_MIGRATE_ALLOW_REMOTE=1 deliberately).`);
  const dryRun = args.has("--dry-run");
  // A database whose schema predates Phase 0 has no Person tables. A dry run
  // there plans from the pre-Phase-0 tables with read-only SELECTs (it never
  // applies migrations); a real run refuses until migrations are applied.
  const ready = (await prisma.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public."Person"')::text AS t`)[0]?.t;
  if (!ready) {
    if (!dryRun) throw new Error("Refusing: this database has no Phase 0 tables. Apply the migrations first (prisma migrate deploy), then run again.");
    console.log(JSON.stringify(await legacyDryRun(), null, 2));
    await prisma.$disconnect();
    return;
  }
  const report = await migrateIdentities({ dryRun });
  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
  if (report.refusals.length && !args.has("--accept-refusals")) {
    console.error(`${report.refusals.length} account(s) refused; they were left untouched. Resolve them, or rerun with --accept-refusals.`);
    process.exit(2);
  }
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
