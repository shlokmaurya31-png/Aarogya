/**
 * Moves verification documents written by the old local-disk store (an
 * absolute path under .data/verification-uploads persisted as storageRef) onto
 * the storage adapter's `verification` bucket. Run by
 * scripts/migrate-verification-uploads.ts.
 *
 * For each legacy row: the path must sit inside the legacy directory, the file
 * must exist, its sha256 must equal the row's, and its bytes must be an
 * allowed type. Only then is it re-stored and the row's storageRef rewritten
 * (and the stored sha256 checked again). Anything else is reported, never
 * guessed at. Legacy files are not deleted; remove the directory once the
 * report is clean and the new refs are confirmed.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { sniffContentType } from "@/lib/storage";
import { getVerificationProvider } from "./provider";

export const LEGACY_UPLOAD_ROOT = path.join(process.cwd(), ".data", "verification-uploads");

export interface LegacyMigrationReport {
  alreadyMigrated: number;
  migrated: string[];
  /** Would be migrated (dry run). */
  pending: string[];
  missing: string[];
  shaMismatch: string[];
  refused: { id: string; reason: string }[];
}

export async function migrateLegacyVerificationUploads(opts: { apply: boolean; legacyRoot?: string }): Promise<LegacyMigrationReport> {
  const root = path.resolve(opts.legacyRoot ?? LEGACY_UPLOAD_ROOT);
  const report: LegacyMigrationReport = { alreadyMigrated: 0, migrated: [], pending: [], missing: [], shaMismatch: [], refused: [] };
  const rows = await prisma.verificationDocument.findMany({ orderBy: [{ id: "asc" }] });

  for (const row of rows) {
    if (row.storageRef.startsWith("verification/")) {
      report.alreadyMigrated++;
      continue;
    }
    const file = path.resolve(row.storageRef);
    if (!file.startsWith(root + path.sep)) {
      report.refused.push({ id: row.id, reason: "path is outside the legacy upload directory" });
      continue;
    }
    const bytes = await readFile(file).catch(() => null);
    if (!bytes) {
      report.missing.push(row.id);
      continue;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
      report.shaMismatch.push(row.id);
      continue;
    }
    const type = sniffContentType(bytes);
    if (!type) {
      report.refused.push({ id: row.id, reason: "content is not an allowed document type" });
      continue;
    }
    if (!opts.apply) {
      report.pending.push(row.id);
      continue;
    }
    const stored = await getVerificationProvider().store(row.studentProfileId, row.kind, bytes, path.basename(file), type);
    if (stored.sha256 !== row.sha256) {
      report.refused.push({ id: row.id, reason: "stored sha256 differs from the original" });
      continue;
    }
    await prisma.verificationDocument.update({ where: { id: row.id }, data: { storageRef: stored.storageRef } });
    report.migrated.push(row.id);
  }
  return report;
}
