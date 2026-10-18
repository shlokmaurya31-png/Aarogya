/**
 * Week 4a, step c: the document pipeline's models and state machine.
 *
 *   1. The database refuses: a patient-provided record that isn't labelled
 *      so; a decided fact without who/when; a corrected fact without the
 *      correction; a record entry for a fact that wasn't confirmed; a second
 *      open run of a document; a patient-provided allergy without its
 *      record (and a clinician one with one).
 *   2. The state machine: a run has its five steps; one claim wins under
 *      concurrency; a permanent error ends the step, a transient one keeps
 *      it for a retry; terminal states never move.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-document-models.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { uploadPersonDocument } from "../src/lib/person/documents";
import { createRun, moveRun, claimStep, finishStep } from "../src/lib/documents/pipelineState";
import { PDFDocument } from "pdf-lib";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);

async function main() {
  const run = Date.now().toString(36);
  const a = await registerPatientAccount({ fullName: `Models ${run}`, email: `docmodels-${run}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1980-01-01") });
  if (a.status !== "LINKED_NEW") throw new Error("fixture");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  const doc = await uploadPersonDocument(a.userId, { bytes: Buffer.from(await pdf.save()), contentType: "application/pdf", originalName: "m.pdf", title: "Models", type: "REPORT" });
  const runRow = await prisma.$transaction((tx) => createRun(tx, { personId, documentId: doc.id, targetLanguage: "en" }));
  report("A run starts QUEUED with its five steps PENDING", runRow.status === "QUEUED" && (await prisma.documentProcessingStep.count({ where: { processingId: runRow.id, status: "PENDING" } })) === 5);
  report("A second open run of the same document is refused", await refused(prisma.$transaction((tx) => createRun(tx, { personId, documentId: doc.id, targetLanguage: "en" }))));

  const claims = await Promise.all([1, 2, 3].map(() => prisma.$transaction((tx) => claimStep(tx, runRow.id, "PAGE_SPLIT")).catch(() => null)));
  report("Three concurrent claims of a step: exactly one wins", claims.filter(Boolean).length === 1);
  const t = await prisma.$transaction((tx) => finishStep(tx, runRow.id, "PAGE_SPLIT", { status: "FAILED", error: "PROVIDER_UNAVAILABLE" }));
  report("A transient error keeps the step RUNNING for a retry", t.status === "RUNNING" && t.transient);
  report("…and a retry can claim it again", Boolean(await prisma.$transaction((tx) => claimStep(tx, runRow.id, "PAGE_SPLIT"))));
  const p = await prisma.$transaction((tx) => finishStep(tx, runRow.id, "PAGE_SPLIT", { status: "FAILED", error: "UNREADABLE" }));
  report("A permanent error ends the step (FAILED)", p.status === "FAILED" && !p.transient);
  report("…and a FAILED step can't be claimed or finished again",
    (await prisma.$transaction((tx) => claimStep(tx, runRow.id, "PAGE_SPLIT"))) === null && await refused(prisma.$transaction((tx) => finishStep(tx, runRow.id, "PAGE_SPLIT", { status: "DONE" }))));
  await prisma.$transaction((tx) => moveRun(tx, runRow.id, "RUNNING"));
  await prisma.$transaction((tx) => moveRun(tx, runRow.id, "FAILED"));
  report("A run moves QUEUED → RUNNING → FAILED, with its completion time", Boolean((await prisma.documentProcessing.findUniqueOrThrow({ where: { id: runRow.id } })).completedAt));
  report("…and a terminal run never moves", await refused(prisma.$transaction((tx) => moveRun(tx, runRow.id, "RUNNING"))));

  const fact = (data: Record<string, unknown>) => prisma.extractedFact.create({ data: {
    processingId: runRow.id, personId, factType: "LAB_VALUE", value: { analyte: "Hb" }, confidence: 0.9, confidenceBand: "HIGH", pageNo: 1, sourceText: "Hb 13", exactCopyCheck: "PASSED", ...data,
  } as never });
  report("CHECK: a decided fact needs who and when", await refused(fact({ reviewStatus: "CONFIRMED" })));
  report("CHECK: a corrected fact needs the correction", await refused(fact({ reviewStatus: "CORRECTED", reviewedAt: new Date(), reviewedByUserId: a.userId })));
  report("CHECK: only a confirmed or corrected fact becomes a record", await refused(fact({ recordEntryId: `rec-${run}` })));
  report("CHECK: a confidence outside 0..1 is refused", await refused(fact({ confidence: 1.5 })));
  report("CHECK: a printed fact has no per-field confirmations", await refused(fact({ confirmedFields: ["value"] })));
  report("CHECK: a patient-provided record says PATIENT_PROVIDED",
    await refused(prisma.patientProvidedRecord.create({ data: { personId, kind: "LAB_RESULT", value: {}, source: "CLINICIAN", factId: `f-${run}`, documentId: doc.id, pageNo: 1 } })));
  const patient = await prisma.patient.findUniqueOrThrow({ where: { id: a.patientId } });
  report("CHECK: a patient-provided allergy needs its record, and only it has one",
    await refused(prisma.allergy.create({ data: { patientId: patient.id, substance: "x", severity: "MILD", source: "PATIENT_PROVIDED" } }))
      && await refused(prisma.allergy.create({ data: { patientId: patient.id, substance: "x", severity: "MILD", patientProvidedRecordId: `r-${run}` } })));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
