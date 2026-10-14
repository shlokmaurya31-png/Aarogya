/**
 * Student verification uploads live in the storage adapter's private
 * `verification` bucket (docs/POSTGRES_CUTOVER_REPORT.md §8.3).
 *
 *   1. A valid PDF round-trips: logical ref scoped by student profile,
 *      sha256 recorded, bytes read back identical.
 *   2. Disallowed uploads are rejected (wrong type, content that doesn't
 *      match the declared type).
 *   3. Reads refuse anything outside the verification bucket: absolute
 *      paths (the old store's refs), traversal, other buckets.
 *   4. The legacy migration moves a file only when it is inside the legacy
 *      directory, present, and its sha256 matches; everything else is
 *      reported. Dry run changes nothing.
 *
 * Uses whatever storage target the environment configures (local disk by
 * default). Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-verification-uploads.ts
 */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { prisma } from "../src/lib/db";
import { StorageRefError, StorageValidationError } from "../src/lib/storage";
import { getVerificationProvider } from "../src/lib/verification/provider";
import { migrateLegacyVerificationUploads } from "../src/lib/verification/migrateLegacy";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const rejects = async (fn: () => Promise<unknown>, cls: new (...a: never[]) => Error) =>
  fn().then(() => false, (e) => e instanceof cls);

async function pdf(label: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]).drawText(`${label} ${Date.now()}`, { x: 10, y: 50, size: 8 });
  return Buffer.from(await doc.save());
}

async function main() {
  const profile = await prisma.studentProfile.findFirstOrThrow({ orderBy: [{ id: "asc" }] });
  const provider = getVerificationProvider();

  // 1. Round trip.
  const bytes = await pdf("id-card");
  const stored = await provider.store(profile.id, "STUDENT_ID_CARD", bytes, "college-id.pdf", "application/pdf");
  report("Stored under the verification bucket, scoped by student profile", stored.storageRef.startsWith(`verification/${profile.id}/`), stored.storageRef);
  report("Recorded sha256 is the file's", stored.sha256 === sha(bytes));
  report("Reading it back returns the same bytes", sha(await provider.read(stored.storageRef)) === sha(bytes));

  // 2. Rejected uploads.
  report("An executable type is rejected", await rejects(() => provider.store(profile.id, "STUDENT_ID_CARD", Buffer.from("MZ\x90\x00binary"), "x.exe", "application/x-msdownload"), StorageValidationError));
  report("Text labelled as a PDF is rejected", await rejects(() => provider.store(profile.id, "STUDENT_ID_CARD", Buffer.from("not a pdf at all"), "fake.pdf", "application/pdf"), StorageValidationError));

  // 3. Refs outside the verification bucket are refused.
  const legacyStyle = path.join(process.cwd(), ".data", "verification-uploads", "x.pdf");
  report("An absolute path (the old store's ref shape) is refused", await rejects(() => provider.read(legacyStyle), StorageRefError));
  report("Traversal is refused", await rejects(() => provider.read("verification/../generated-pdf/x.pdf"), StorageRefError));
  report("Another bucket is refused", await rejects(() => provider.read("generated-pdf/fac/x.pdf"), StorageRefError));

  // 4. Legacy migration.
  const root = path.join(process.cwd(), ".data", "verification-uploads-gate");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const good = await pdf("legacy-good");
  const goodPath = path.join(root, "good.pdf");
  await writeFile(goodPath, good);
  const tamperedPath = path.join(root, "tampered.pdf");
  await writeFile(tamperedPath, await pdf("legacy-tampered"));
  const mk = (storageRef: string, digest: string) =>
    prisma.verificationDocument.create({ data: { studentProfileId: profile.id, kind: "ENROLLMENT_DOCUMENT", storageRef, sha256: digest } });
  const rowGood = await mk(goodPath, sha(good));
  const rowTampered = await mk(tamperedPath, sha(good)); // recorded sha ≠ file
  const rowMissing = await mk(path.join(root, "gone.pdf"), sha(good));
  const rowOutside = await mk("/etc/hosts", sha(good));

  const dry = await migrateLegacyVerificationUploads({ apply: false, legacyRoot: root });
  const unchanged = (await prisma.verificationDocument.findUniqueOrThrow({ where: { id: rowGood.id } })).storageRef === goodPath;
  report("Dry run reports the movable file and changes nothing", dry.pending.includes(rowGood.id) && unchanged);

  const applied = await migrateLegacyVerificationUploads({ apply: true, legacyRoot: root });
  const after = await prisma.verificationDocument.findUniqueOrThrow({ where: { id: rowGood.id } });
  report("Apply re-stores the file and rewrites its ref", applied.migrated.includes(rowGood.id) && after.storageRef.startsWith(`verification/${profile.id}/`), after.storageRef);
  report("The migrated document reads back identical", sha(await provider.read(after.storageRef)) === sha(good));
  report("A file whose sha256 doesn't match is reported, not moved", applied.shaMismatch.includes(rowTampered.id));
  report("A missing file is reported", applied.missing.includes(rowMissing.id));
  report("A path outside the legacy directory is refused", applied.refused.some((r) => r.id === rowOutside.id));

  await prisma.verificationDocument.deleteMany({ where: { id: { in: [rowGood.id, rowTampered.id, rowMissing.id, rowOutside.id] } } });
  await provider.delete(after.storageRef);
  await provider.delete(stored.storageRef);
  await rm(root, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
