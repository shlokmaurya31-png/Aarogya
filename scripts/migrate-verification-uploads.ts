/**
 * One-off: move student verification uploads from the old local-disk store
 * onto the storage adapter (docs/POSTGRES_CUTOVER_REPORT.md §8.3).
 *
 *   npm run verification:migrate              dry run: report only
 *   npm run verification:migrate -- --apply   re-store and rewrite refs
 *
 * Uses the app's own storage target (.env.local / .env: local disk, or S3 /
 * Supabase Storage when STORAGE_S3_* is set). Exits 1 if any row is missing,
 * mismatched or refused, so nothing is silently left behind.
 */
import { existsSync } from "node:fs";
import path from "node:path";

for (const f of [".env.local", ".env"]) {
  const file = path.join(process.cwd(), f);
  if (existsSync(file)) process.loadEnvFile(file);
}

async function main() {
  const { migrateLegacyVerificationUploads } = await import("../src/lib/verification/migrateLegacy");
  const { prisma } = await import("../src/lib/db");
  const apply = process.argv.includes("--apply");
  const r = await migrateLegacyVerificationUploads({ apply });
  console.log(`${apply ? "APPLY" : "DRY RUN"}: already migrated ${r.alreadyMigrated}, ${apply ? `migrated ${r.migrated.length}` : `would migrate ${r.pending.length}`}`);
  if (r.missing.length) console.log(`missing files (${r.missing.length}): ${r.missing.join(", ")}`);
  if (r.shaMismatch.length) console.log(`sha256 mismatch (${r.shaMismatch.length}): ${r.shaMismatch.join(", ")}`);
  for (const x of r.refused) console.log(`refused ${x.id}: ${x.reason}`);
  await prisma.$disconnect();
  process.exitCode = r.missing.length + r.shaMismatch.length + r.refused.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
