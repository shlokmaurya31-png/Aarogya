/**
 * D4: generating a document also creates its ClinicalDocument, in the same
 * transaction, so generated PDFs are part of the patient's record.
 *
 *   1. A generated prescription has a linked ClinicalDocument: same patient,
 *      file and hash, PATIENT_VISIBLE, authored by the issuing staff member.
 *   2. The portal lists and downloads it; the Hospital OS document list
 *      (GET /api/hospital/documents's query) shows it; /verify still works.
 *   3. A draft is kept out of both lists; a claim packet is staff-only.
 *   4. A patient in another facility is refused and nothing is written.
 *   5. The database allows exactly one source per ClinicalDocument (staff
 *      upload, patient upload or generated).
 *   6. No generated document from this run lacks its ClinicalDocument.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-generated-documents.ts
 */
import "./lib/gateBootstrap";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { generateAndStoreDocument } from "../src/lib/documents/service";
import { verifyDocumentByToken } from "../src/lib/documents/verify";
import type { DocumentInput } from "../src/lib/documents/templates";
import { listReports, getDocumentForDownload } from "../src/lib/patient/experience/reports";
import type { PatientAccessScope } from "../src/lib/patient/context";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = (p: Promise<unknown>) => p.then(() => false, () => true);
const ALL = ["PERSONAL", "APPOINTMENTS", "QUEUE", "RECORDS", "REPORTS", "PRESCRIPTIONS", "MEDICATIONS", "BILLING", "INSURANCE", "CONSENT"] as const;

async function main() {
  const run = Date.now().toString(36);
  const startedAt = new Date();
  const facilityId = "fac-amc-pune";
  const doctorUser = await prisma.user.findFirstOrThrow({ where: { email: "doctor1@amc-demo.aarogya" }, include: { hospitalStaffProfile: true } });
  const patient = await prisma.patient.create({ data: { uhid: `GEN-${run}`, facilityId, fullName: `Generated Docs ${run}`, sex: "F" } });
  const scope: PatientAccessScope = { patientId: patient.id, patientIds: [patient.id], facilityId, isSelf: true, allowedClasses: new Set(ALL) };
  const letterhead = { facilityName: "Aarogya Medical Centre", authorName: "Dr Verify", authorRegistration: "MMC-0000" };
  const rx: DocumentInput = {
    type: "prescription",
    patient: { name: patient.fullName, uhid: patient.uhid ?? undefined },
    diagnosis: "D4 gate",
    items: [{ drug: "Paracetamol 500 mg", dose: "1 tablet", frequency: "TDS", duration: "3 days" }],
  };
  const ctx = { facilityId, letterhead, issuedByUserId: doctorUser.id, patientId: patient.id };

  // 1. Linked ClinicalDocument.
  const doc = await generateAndStoreDocument(rx, ctx);
  const clinical = await prisma.clinicalDocument.findUniqueOrThrow({ where: { id: doc.clinicalDocumentId } });
  const generated = await prisma.generatedDocument.findUniqueOrThrow({ where: { id: doc.id } });
  report("Generating a document creates a linked ClinicalDocument", clinical.generatedDocumentId === doc.id);
  report("…for the patient, in the facility", clinical.patientId === patient.id && clinical.facilityId === facilityId);
  report("…with the same file and hash", clinical.storageRef === generated.storageRef && clinical.sha256 === generated.sha256);
  report("…current, patient-visible, typed and titled", clinical.status === "CURRENT" && clinical.accessPolicy === "PATIENT_VISIBLE" && clinical.type === "PRESCRIPTION" && clinical.title === generated.title);
  report("…authored by the issuing staff member", clinical.authorStaffId === doctorUser.hospitalStaffProfile?.id);
  report("…with no uploader (its source is the generated document)", clinical.uploadedByStaffId === null && clinical.uploadedByUserId === null);

  // 2. Where it shows up.
  const reports = await listReports(scope);
  report("The portal lists it", reports.some((r) => r.id === `document:${clinical.id}`));
  const dl = await getDocumentForDownload(scope, clinical.id);
  report("The portal can download it", dl.available && dl.storageRef === generated.storageRef);
  const hospitalList = await prisma.clinicalDocument.findMany({ where: { patientId: patient.id, status: "CURRENT" } });
  report("The Hospital OS document list shows it", hospitalList.some((d) => d.id === clinical.id));
  const verified = await verifyDocumentByToken(doc.verifyToken);
  report("/verify still validates it from GeneratedDocument", verified.valid && verified.documentNumber === doc.documentNumber);

  // 3. Drafts and claim packets.
  const draft = await generateAndStoreDocument(rx, { ...ctx, isDraft: true });
  const draftClinical = await prisma.clinicalDocument.findUniqueOrThrow({ where: { id: draft.clinicalDocumentId } });
  const reportsAfter = await listReports(scope);
  report("A draft is recorded as DRAFT", draftClinical.status === "DRAFT");
  report("…and listed neither in the portal nor in the default Hospital OS list",
    !reportsAfter.some((r) => r.id === `document:${draftClinical.id}`)
      && !(await prisma.clinicalDocument.findMany({ where: { patientId: patient.id, status: "CURRENT" } })).some((d) => d.id === draftClinical.id));
  const packet = await generateAndStoreDocument({
    type: "claim-packet", patient: { name: patient.fullName }, claimNo: `CLM-${run}`, payer: "Verify Insurer",
    diagnoses: ["D4 gate"], claimedMinor: 100_00, documents: ["Prescription"],
  }, ctx);
  const packetClinical = await prisma.clinicalDocument.findUniqueOrThrow({ where: { id: packet.clinicalDocumentId } });
  report("A claim packet is staff-only (in the Hospital OS list, not the portal)",
    packetClinical.accessPolicy === "CLINICAL_STAFF" && packetClinical.status === "CURRENT" && !(await listReports(scope)).some((r) => r.id === `document:${packetClinical.id}`));

  // 4. Wrong facility: refused, nothing written.
  const before = await prisma.generatedDocument.count();
  // The local adapter stores under .data/object-store/<bucket>/<scope>/ (verify runs use it).
  const noidaFiles = () => readdir(path.join(process.cwd(), ".data", "object-store", "generated-pdf", "fac-amc-noida"), { recursive: true }).then((f) => f.length, () => 0);
  const filesBefore = await noidaFiles();
  report("A patient in another facility is refused", await refused(generateAndStoreDocument(rx, { ...ctx, facilityId: "fac-amc-noida" })));
  report("…and no GeneratedDocument is written", (await prisma.generatedDocument.count()) === before);
  report("…and no file is stored", (await noidaFiles()) === filesBefore);

  // 5. One source per ClinicalDocument.
  const base = { facilityId, patientId: patient.id, type: "OTHER", title: "D4 check" };
  report("The database refuses a ClinicalDocument with no source", await refused(prisma.clinicalDocument.create({ data: base })));
  report("…and one that is both generated and staff-uploaded",
    await refused(prisma.clinicalDocument.create({ data: { ...base, uploadedByStaffId: doctorUser.hospitalStaffProfile!.id, generatedDocumentId: doc.id } })));

  // 6. No orphans from this run.
  const orphans = await prisma.generatedDocument.count({ where: { createdAt: { gte: startedAt }, clinicalDocument: null } });
  report("Every document generated in this run has its ClinicalDocument", orphans === 0, `${orphans} orphan(s)`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
