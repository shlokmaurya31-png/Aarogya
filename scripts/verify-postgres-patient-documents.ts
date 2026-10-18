/**
 * Patient document upload (src/lib/patient/experience/documents.ts).
 *
 *   1. A PDF upload is stored in the patient-uploads bucket, scoped to the
 *      person, recorded as their own PersonDocument (no facility; Phase 0,
 *      part 2) with its sha256, audited and evented (PERSON scope).
 *   2. The portal lists it; the person downloads it by a signed URL; another
 *      person can't.
 *   3. The care team sees it only after the person shares uploads with
 *      hospitals treating them, within a care relationship; a staff download
 *      is a signed URL in the person's access log; another facility's is 404.
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
import { listReports } from "../src/lib/patient/experience/reports";
import { personDocumentDownload, staffPersonDocuments } from "../src/lib/person/documents";
import { decidePersonConsent } from "../src/lib/person/consent";
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
  const scope = scopeFor(patient);

  // 1. Upload.
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]).drawText(`outside report ${run}`, { x: 10, y: 50, size: 8 });
  const bytes = Buffer.from(await doc.save());
  const up = await uploadPatientDocument(scope, user.id, { bytes, contentType: "application/pdf", originalName: "outside-report.pdf", title: "Outside MRI report", type: "REPORT" });
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: user.id } })).personId;
  const row = await prisma.personDocument.findUniqueOrThrow({ where: { id: up.id } });
  report("Recorded as the person's own document (PersonDocument), uploaded by their account", row.personId === personId && row.uploadedByUserId === user.id && row.status === "CURRENT");
  report("…tied to no facility (person-level)", !("facilityId" in row) && row.legacyFacilityId === null);
  report("Stored in the patient-uploads bucket, scoped to the person", row.storageRef.startsWith(`patient-uploads/${personId}/`), row.storageRef);
  const storedBytes = (await getStorageAdapter().get(row.storageRef)).bytes;
  report("Stored bytes and recorded sha256 match the upload", createHash("sha256").update(storedBytes).digest("hex") === createHash("sha256").update(bytes).digest("hex") && row.sha256 === up.sha256);
  report("The upload is audited", (await prisma.auditEvent.count({ where: { type: "person.document.uploaded", detail: { path: ["documentId"], equals: up.id } } })) === 1);
  report("…and emits PersonDocumentUploaded (PERSON scope)", (await prisma.domainEventOutbox.count({ where: { eventType: "PersonDocumentUploaded", aggregateId: up.id, personId, facilityId: null } })) === 1);

  // 2. Portal.
  const reports = await listReports(scope);
  report("The portal lists it", reports.some((r) => r.id === `upload:${up.id}` && r.downloadable));
  const dl = await personDocumentDownload({ kind: "OWNER", userId: user.id }, up.id);
  report("The person downloads it through a short-lived signed URL (never the storage path)", dl.url.length > 0 && !dl.url.includes(row.storageRef) && new Date(dl.expiresAt).getTime() > Date.now());
  const stranger = await prisma.user.create({ data: { email: `patient-docs-other-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "Other" } });
  const strangerRec = await prisma.patient.create({ data: { uhid: `PDOC-X-${run}`, facilityId: "fac-amc-pune", fullName: `Docs Other ${run}`, sex: "M" } });
  await linkAccountForGate(prisma, stranger.id, strangerRec.id);
  const strangerDl = await personDocumentDownload({ kind: "OWNER", userId: stranger.id }, up.id).then(() => "downloaded", (e) => (e instanceof NotFoundError ? "404" : String(e)));
  report("Another person gets 404", strangerDl === "404");

  // 3. Care team: only after the person shares uploads with hospitals treating them, within a care relationship.
  const careTeam = async () => (await staffPersonDocuments("fac-amc-pune", [patient.id])).some((d) => d.id === up.id);
  report("The care team doesn't see it before the person chooses", !(await careTeam()));
  await prisma.encounter.create({ data: { patientId: patient.id, facilityId: "fac-amc-pune", type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "documents gate" } });
  await decidePersonConsent({ userId: user.id, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  report("…and sees it once they share and are being treated", await careTeam());
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { user: { email: "doctor1@amc-demo.aarogya" } }, select: { userId: true } });
  const staffDl = await personDocumentDownload({ kind: "STAFF", userId: staff.userId, facilityId: "fac-amc-pune", patientId: patient.id }, up.id);
  report("A staff download is a signed URL, written to the person's access log", Boolean(staffDl.url) && (await prisma.personAccessLogEntry.count({ where: { personId, kind: "RECORD_ACCESSED", accessingFacilityId: "fac-amc-pune" } })) === 1);
  const otherFacility = await personDocumentDownload({ kind: "STAFF", userId: staff.userId, facilityId: "fac-amc-noida", patientId: patient.id }, up.id).then(() => "downloaded", (e) => (e instanceof NotFoundError ? "404" : String(e)));
  report("…another facility's staff get 404", otherFacility === "404");

  // 4. Rejections leave nothing behind.
  const before = await prisma.personDocument.count({ where: { personId } });
  const rejects = async (b: Buffer, type: string) =>
    uploadPatientDocument(scope, user.id, { bytes: b, contentType: type, originalName: "x", title: "x", type: "OTHER" }).then(() => false, (e) => e instanceof StorageValidationError);
  report("An executable type is rejected", await rejects(Buffer.from("MZ\x90\x00"), "application/x-msdownload"));
  report("Text labelled as PDF is rejected", await rejects(Buffer.from("plain text"), "application/pdf"));
  report("A file over 15 MB is rejected", await rejects(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(15 * 1024 * 1024 + 1)]), "application/pdf"));
  report("Rejected uploads create no record", (await prisma.personDocument.count({ where: { personId } })) === before);

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
