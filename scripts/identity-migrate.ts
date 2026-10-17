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

async function main() {
  const args = new Set(process.argv.slice(2));
  const host = hostOf(process.env.DATABASE_URL);
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  if (/supabase\./.test(host)) throw new Error(`Refusing: ${host} is a Supabase host.`);
  if (!local && process.env.IDENTITY_MIGRATE_ALLOW_REMOTE !== "1") throw new Error(`Refusing: ${host || "(no host)"} is not localhost (set IDENTITY_MIGRATE_ALLOW_REMOTE=1 deliberately).`);
  const report = await migrateIdentities({ dryRun: args.has("--dry-run") });
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
