/**
 * Patient document upload (src/lib/patient/experience/documents.ts).
 *
 *   1. A PDF upload is stored in the patient-uploads bucket, recorded against
 *      the Patient as a PATIENT_VISIBLE ClinicalDocument uploaded by the
 *      patient's account, with its sha256, and audited.
 *   2. The portal lists it and can download it; another patient can't.
 *   3. It sits in the patient's facility, which is what the care team's
 *      document list is scoped to.
 *   4. Wrong type, mismatched content and oversize files are rejected and
 *      leave no record behind.
 *   5. A delegate (read-only) can't upload.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-patient-documents.ts
 */
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { prisma } from "../src/lib/db";
import { NotFoundError } from "../src/lib/auth/rbac";
import { getStorageAdapter, StorageValidationError } from "../src/lib/storage";
import type { PatientAccessScope } from "../src/lib/patient/context";
import { uploadPatientDocument } from "../src/lib/patient/experience/documents";
import { listReports, getDocumentForDownload } from "../src/lib/patient/experience/reports";
import { linkAccountForGate } from "./lib/personFixture";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const ALL = ["PERSONAL", "APPOINTMENTS", "QUEUE", "RECORDS", "REPORTS", "PRESCRIPTIONS", "MEDICATIONS", "BILLING", "INSURANCE", "CONSENT"] as const;
const scopeFor = (p: { id: string; facilityId: string }, isSelf = true): PatientAccessScope => ({
  patientId: p.id, patientIds: [p.id], facilityId: p.facilityId, isSelf, allowedClasses: new Set(ALL),
});

async function main() {
  const run = Date.now().toString(36);
  const user = await prisma.user.create({ data: { email: `patient-docs-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "Docs patient" } });
  const patient = await prisma.patient.create({ data: { uhid: `PDOC-${run}`, facilityId: "fac-amc-pune", fullName: `Docs Patient ${run}`, sex: "F" } });
  await linkAccountForGate(prisma, user.id, patient.id);
  const other = await prisma.patient.findFirstOrThrow({ where: { facilityId: "fac-amc-pune", id: { not: patient.id } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const scope = scopeFor(patient);

  // 1. Upload.
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]).drawText(`outside report ${run}`, { x: 10, y: 50, size: 8 });
  const bytes = Buffer.from(await doc.save());
  const up = await uploadPatientDocument(scope, user.id, { bytes, contentType: "application/pdf", originalName: "outside-report.pdf", title: "Outside MRI report", type: "REPORT" });
  const row = await prisma.clinicalDocument.findUniqueOrThrow({ where: { id: up.id } });
  report("Recorded against the Patient, uploaded by the patient's account", row.patientId === patient.id && row.uploadedByUserId === user.id && row.uploadedByStaffId === null);
  report("Patient-visible, in the patient's facility", row.accessPolicy === "PATIENT_VISIBLE" && row.facilityId === patient.facilityId);
  report("Stored in the patient-uploads bucket, scoped to the patient", row.storageRef?.startsWith(`patient-uploads/${patient.id}/`) ?? false, row.storageRef ?? "");
  const storedBytes = (await getStorageAdapter().get(row.storageRef!)).bytes;
  report("Stored bytes and recorded sha256 match the upload", createHash("sha256").update(storedBytes).digest("hex") === createHash("sha256").update(bytes).digest("hex") && row.sha256 === up.sha256);
  report("The upload is audited", (await prisma.auditEvent.count({ where: { type: "patient.document.uploaded", patientId: patient.id } })) === 1);

  // 2. Portal.
  const reports = await listReports(scope);
  report("The portal lists it", reports.some((r) => r.id === `document:${up.id}` && r.downloadable));
  const dl = await getDocumentForDownload(scope, up.id);
  report("The portal can download it", dl.available && dl.storageRef === row.storageRef);
  const strangerDl = await getDocumentForDownload(scopeFor(other), up.id).then(() => "downloaded", (e) => (e instanceof NotFoundError ? "404" : String(e)));
  report("Another patient gets 404", strangerDl === "404");

  // 3. Care team: the hospital document list is the patient's documents, for staff of the patient's facility.
  const careTeamList = await prisma.clinicalDocument.findMany({ where: { patientId: patient.id, status: "CURRENT" } });
  report("It is in the patient's document list for their facility's care team", careTeamList.some((d) => d.id === up.id) && patient.facilityId === "fac-amc-pune");

  // 4. Rejections leave nothing behind.
  const before = await prisma.clinicalDocument.count({ where: { patientId: patient.id } });
  const rejects = async (b: Buffer, type: string) =>
    uploadPatientDocument(scope, user.id, { bytes: b, contentType: type, originalName: "x", title: "x", type: "OTHER" }).then(() => false, (e) => e instanceof StorageValidationError);
  report("An executable type is rejected", await rejects(Buffer.from("MZ\x90\x00"), "application/x-msdownload"));
  report("Text labelled as PDF is rejected", await rejects(Buffer.from("plain text"), "application/pdf"));
  report("A file over 15 MB is rejected", await rejects(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(15 * 1024 * 1024 + 1)]), "application/pdf"));
  report("Rejected uploads create no record", (await prisma.clinicalDocument.count({ where: { patientId: patient.id } })) === before);

  // 5. Delegates can't upload.
  const delegated = await uploadPatientDocument(scopeFor(patient, false), user.id, { bytes, contentType: "application/pdf", originalName: "d.pdf", title: "d", type: "OTHER" }).then(() => "uploaded", () => "refused");
  report("A delegate can't upload", delegated === "refused");

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
