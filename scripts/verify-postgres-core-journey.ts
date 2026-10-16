/**
 * Workflow spine §7: the core-journey replay test. Grows a step at a time
 * (§9); this version covers steps 1–8a of the §7 journey, the medication
 * round that step 6 wired, step 9 (OT, with the charge-capture and
 * stock-movement consumers, spine step 8), the portal upload (8b), and
 * pre-authorization, discharge, invoice → claim draft, a late charge and its
 * supplementary invoice (10–14, spine step 9).
 *
 * Drives the real service functions, drains the runner after each step and
 * asserts, by correlationId = the encounter:
 *   - each step's events (producer and consumer output, compared as a set per
 *     step), and the producers' events in emission order across the journey;
 *   - every payload passes its contract and the sensitive-data guard;
 *   - every delivery PROCESSED, zero dead letters;
 *   - the critical-result task opened at step 8 is completed by step 8a, and
 *     minutesToAcknowledge matches the stored timestamps;
 *   - replay: every event of the journey is replayed (replay.ts) and the runner
 *     run again → no new task, notification, dose or charge;
 *   - tenancy: a parallel journey in another facility writes only its own rows.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-core-journey.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { registerEdArrival } from "../src/lib/hospital/emergency";
import { recordTriage } from "../src/lib/hospital/triage";
import { createAdmissionRequest, allocateBed, confirmAdmissionRequest } from "../src/lib/hospital/admissionRequest";
import { transferWithinIcu } from "../src/lib/hospital/icu";
import { placeLabOrder } from "../src/lib/hospital/labOrder";
import { collectSpecimen, receiveSpecimen, acceptSpecimen } from "../src/lib/hospital/specimenLifecycle";
import { enterResult, verifyResult, acknowledgeResult } from "../src/lib/hospital/labResultLifecycle";
import { createMedicationOrder, verifyMedicationOrder, dispenseMedication, administerMedication } from "../src/lib/hospital/medicationLifecycle";
import { linkMedicationToItem, SYSTEM_ACTOR } from "../src/lib/hospital/inventory/itemMedicationLink";
import { createAdjustment } from "../src/lib/hospital/inventory/adjustment";
import { createOperatingTheatre, requestSurgery, transitionSurgery, scheduleSurgery, startProcedure, recordItemUsage, completeProcedure } from "../src/lib/hospital/surgery";
import { getEventContract } from "../src/lib/events/catalogue";
import { assertNoSensitiveData } from "../src/lib/events/sensitiveGuard";
import { replayEvent } from "../src/lib/events/replay";
import { loadActorMemberships } from "../src/lib/auth/tenantContext";
import { runTick } from "../src/lib/runner/tick";
import { PDFDocument } from "pdf-lib";
import { uploadPatientDocument } from "../src/lib/patient/experience/documents";
import type { PatientAccessScope } from "../src/lib/patient/context";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";
import { implantSku } from "../prisma/seedData/clinicalCatalogue";
import { registerBloodUnit, releaseUnit, recordPatientTyping, requestBlood, transitionRequest, recordCompatibility, verifyCompatibility, issueUnit } from "../src/lib/hospital/blood";
import { createPayer, addPatientCoverage } from "../src/lib/hospital/billing/coverage";
import { requestPreAuth, decidePreAuth } from "../src/lib/hospital/billing/preauth";
import { initiateDischarge, updateDischargeReadiness, finalizeDischarge } from "../src/lib/hospital/admission";
import { generateAndStoreDocument } from "../src/lib/documents/service";
import { draftInvoiceForAccount, addChargeToInvoice, issueInvoice, draftSupplementaryInvoice } from "../src/lib/hospital/billing/invoices";
import { createCharge } from "../src/lib/hospital/billing/chargeCapture";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const drain = async () => { for (let i = 0; i < 5; i++) if (!(await runTick({ budgetMs: 20_000 })).moreWork) break; };
const sorted = (xs: string[]) => [...xs].sort().join(",");
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
const tx = <T>(fn: (t: Tx) => Promise<T>) => prisma.$transaction(fn);

/** One journey through the services in a facility; returns the encounter and what it created. */
async function journey(facilityId: string, label: string, opts: { full: boolean }) {
  const run = `${label}-${Date.now().toString(36)}`;
  const staffOf = (role: "DOCTOR" | "NURSE" | "PHARMACIST") =>
    prisma.hospitalStaffProfile.findFirst({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role } }] }, orderBy: { id: "asc" } });
  const doctor = (await staffOf("DOCTOR"))!;
  const nurse = (await staffOf("NURSE")) ?? doctor;
  const by = doctor.userId;
  const steps: { name: string; expected: string[]; got: string[] }[] = [];
  let mark = BigInt(0);
  let encounterId = "";
  /** Run a step, drain the runner, and record the encounter's new events. */
  const step = async (name: string, expected: string[], fn: () => Promise<unknown>) => {
    await fn();
    await drain();
    const evs = await prisma.domainEventOutbox.findMany({ where: { correlationId: encounterId, seq: { gt: mark } }, orderBy: { seq: "asc" }, select: { seq: true, eventType: true } });
    if (evs.length) mark = evs[evs.length - 1].seq;
    steps.push({ name, expected, got: evs.map((e) => e.eventType) });
  };

  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Core Journey ${run}`, sex: "M", ageYears: 64 });
  const registered = await prisma.domainEventOutbox.count({ where: { eventType: "PatientRegistered", aggregateId: patient.id } });
  const ward = await prisma.ward.create({ data: { facilityId, name: `CJ ward ${run}`, wardType: "GENERAL" } });
  const icu = await prisma.ward.create({ data: { facilityId, name: `CJ ICU ${run}`, wardType: "ICU" } });
  const wardBed = await prisma.bed.create({ data: { facilityId, wardId: ward.id, label: `CJW-${run}` } });
  const icuBed = await prisma.bed.create({ data: { facilityId, wardId: icu.id, label: `CJI-${run}`, icuCapable: true } });

  // 2. ED arrival (sets the correlation for everything after).
  const enc = await registerEdArrival({ facilityId, patientId: patient.id, chiefComplaint: "Chest pain", arrivalMode: "AMBULANCE", registeredByStaffId: doctor.id, byUserId: by });
  encounterId = enc.id;
  await drain();
  const arrival = await prisma.domainEventOutbox.findMany({ where: { correlationId: enc.id }, orderBy: { seq: "asc" }, select: { seq: true, eventType: true } });
  mark = arrival.at(-1)?.seq ?? BigInt(0);
  steps.push({ name: "2 ED arrival", expected: ["EdArrivalRegistered"], got: arrival.map((e) => e.eventType) });

  await step("3 Triage", ["PatientTriaged"], () => recordTriage({ encounterId: enc.id, recordedByStaffId: doctor.id, acuity: 2, byUserId: by }));
  let reqId = "";
  await step("4 Admission request", ["AdmissionRequested", "TaskCreated"], async () => {
    reqId = (await createAdmissionRequest({ facilityId, patientId: patient.id, encounterId: enc.id, requestedByStaffId: doctor.id, reason: "ACS", priority: "URGENT", byUserId: by })).id;
  });
  await step("5 Bed", ["BedReserved", "TaskCompleted"], () => allocateBed(reqId, wardBed.id, doctor.id, by));
  let admissionId = "";
  // The seeded admission-checklist workflow (D7, prisma/seed.ts) adds its task.
  await step("6 Admit", ["AdmissionCreated", "TaskCreated"], async () => { admissionId = (await confirmAdmissionRequest(reqId, by)).admission.id; });
  await step("7 ICU", ["IcuAdmitted", "PatientTransferred", "ChargePosted"], () => transferWithinIcu({ admissionId, toBedId: icuBed.id, facilityId, reason: "deterioration", byUserId: by }));

  let resultId = "";
  // 8. Labs: the order (with its in-transaction collection task), collection,
  // and a critical result (→ critical-result task; notification, not an event).
  // Receipt in the lab is SpecimenStatusChanged (batch 4: found by the extended emit rule).
  await step("8 Labs", ["ChargePosted", "LabOrderPlaced", "TaskCreated", "SpecimenCollected", "SpecimenStatusChanged", "LabResultReleased", "TaskCreated"], async () => {
    const lab = await placeLabOrder({ facilityId, staffId: doctor.id, byUserId: by, encounterId: enc.id, patientId: patient.id, testName: `Troponin ${run}`, category: "Biochemistry", priority: "STAT" });
    const sp = lab.specimen!;
    await tx((t) => collectSpecimen(t, sp.id, nurse.id, undefined, nurse.userId));
    await tx((t) => receiveSpecimen(t, sp.id, nurse.id));
    await tx((t) => acceptSpecimen(t, sp.id, nurse.id));
    const r = await tx((t) => enterResult(t, { labOrderId: lab.order.id, specimenId: sp.id, value: "2.1", isCritical: true }));
    await tx((t) => verifyResult(t, r.id, doctor.id, by));
    resultId = r.id;
  });
  const critTask = () => prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `CRITICAL_RESULT_FOLLOW_UP:${resultId}` } } });
  const openAfter8 = (await critTask())?.status;
  await step("8a Critical acknowledgement", ["CriticalResultAcknowledged", "TaskCompleted"], () => tx((t) => acknowledgeResult(t, resultId, doctor.id, by)));

  // 8b. Outside report through the patient portal (not encounter-scoped: checked directly below).
  let uploadedDocumentId = "";
  if (opts.full) {
    const portalUser = await prisma.user.create({ data: { email: `cj-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "Journey patient" } });
    await prisma.patient.update({ where: { id: patient.id }, data: { userId: portalUser.id } });
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 100]).drawText(`outside ${run}`, { x: 10, y: 50, size: 8 });
    const scope: PatientAccessScope = { patientId: patient.id, patientIds: [patient.id], facilityId, isSelf: true, allowedClasses: new Set(["RECORDS", "REPORTS"]) };
    uploadedDocumentId = (await uploadPatientDocument(scope, portalUser.id, { bytes: Buffer.from(await pdf.save()), contentType: "application/pdf", originalName: "outside.pdf", title: "Outside echo", type: "REPORT" })).id;
    await drain();
  }

  let orderId = "";
  if (opts.full) {
    // 8c. A medication round: order, verify (→ mar-scheduler doses), dispense, administer.
    const pharmacist = (await staffOf("PHARMACIST"))!;
    const pharmacy = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId, name: "Central Pharmacy" } });
    const drugName = `CoreJourneyDrug${run}`;
    const item = await prisma.item.create({ data: { facilityId, sku: `CJ-${run}`, name: drugName, category: "MEDICATION", baseUnit: "TABLET" } });
    await tx((t) => linkMedicationToItem(t, SYSTEM_ACTOR, { target: { scope: "FACILITY", facilityId }, drugName, itemId: item.id }));
    const lot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId, lotNumber: `CJ-LOT-${run}`, status: "ACTIVE", expiresAt: new Date("2029-01-01") } });
    await tx((t) => createAdjustment(t, { facilityId, itemId: item.id, lotId: lot.id, locationId: pharmacy.id, quantityDelta: 10, reason: "FOUND", requestedByStaffId: pharmacist.id, actorUserId: pharmacist.userId, idempotencyKey: `cj-${run}` }));
    await step("8c Medication", ["MedicationOrdered", "MedicationVerified", "StockMoved", "MedicationDispensed", "ChargePosted", "MedicationAdministered"], async () => {
      const o = await createMedicationOrder({ facilityId, encounterId: enc.id, patientId: patient.id, orderingStaffId: doctor.id, drugName, dose: "1 tab", route: "PO", frequency: "BD", overrideReason: "journey", byUserId: by });
      if (o.blocked) throw new Error("unexpected safety block");
      orderId = o.order.id;
      await verifyMedicationOrder(orderId, pharmacist.id, pharmacist.userId);
      await drain(); // mar-scheduler writes the doses
      await dispenseMedication({ medicationOrderId: orderId, pharmacistStaffId: pharmacist.id, quantity: 2, quantityUnit: "TABLET", dispensingLocationId: pharmacy.id, byUserId: pharmacist.userId });
      const first = await prisma.medicationAdministration.findFirstOrThrow({ where: { medicationOrderId: orderId, status: "DUE" }, orderBy: { scheduledAt: "asc" } });
      await administerMedication({ administrationId: first.id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId });
    });
  }
  let surgeryId = "";
  let usageId = "";
  let bloodIssueId = "";
  if (opts.full) {
    // 9. OT (batch 6, fix 5: the seeded catalogue): PTCA, scheduled for its
    // typical duration, a drug-eluting stent from stock, completion
    // (→ charge-capture at the specific tariffs, stock-movement).
    const pharmacy = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId, name: "Central Pharmacy" } });
    const proc = await prisma.procedure.findUniqueOrThrow({ where: { facilityId_code: { facilityId, code: "PTCA" } } });
    const ot = await createOperatingTheatre({ facilityId, name: `CJ OT ${run}`, byUserId: by });
    const stent = await prisma.item.findUniqueOrThrow({ where: { sku: implantSku("DES", facilityId) } });
    const stentLot = await prisma.itemLot.create({ data: { itemId: stent.id, facilityId, lotNumber: `CJ-DES-LOT-${run}`, status: "ACTIVE", expiresAt: new Date("2030-01-01") } });
    await tx((t) => createAdjustment(t, { facilityId, itemId: stent.id, lotId: stentLot.id, locationId: pharmacy.id, quantityDelta: 1, reason: "FOUND", requestedByStaffId: doctor.id, actorUserId: by, idempotencyKey: `cj-des-${run}` }));
    await step("9 OT", ["SurgeryRequested", "SurgeryStatusChanged", "SurgeryStatusChanged", "SurgeryScheduled", "ProcedureStarted", "SurgeryItemUsed", "ProcedureCompleted", "ChargePosted", "StockMoved", "ChargePosted"], async () => {
      const s = await requestSurgery({ facilityId, patientId: patient.id, encounterId: enc.id, procedureId: proc.id, urgency: "URGENT", requestedByStaffId: doctor.id, byUserId: by });
      surgeryId = s.id;
      await transitionSurgery({ surgeryId, facilityId, to: "REVIEWED", actorStaffId: doctor.id, byUserId: by });
      await transitionSurgery({ surgeryId, facilityId, to: "APPROVED", actorStaffId: doctor.id, byUserId: by });
      const at = new Date(Date.now() + 2 * 86_400_000 + Math.floor(Math.random() * 1000) * 60_000);
      await scheduleSurgery({ surgeryId, facilityId, operatingTheatreId: ot.id, startAt: at, endAt: new Date(at.getTime() + proc.typicalDurationMinutes! * 60_000), schedulerStaffId: doctor.id, byUserId: by });
      await startProcedure({ surgeryId, facilityId, surgeonStaffId: doctor.id, byUserId: by });
      usageId = (await recordItemUsage({ surgeryId, facilityId, usageType: "IMPLANT", itemId: stent.id, itemLotId: stentLot.id, quantity: 1, locationId: pharmacy.id, recordedByStaffId: doctor.id, actorUserId: by, byUserId: by })).id;
      await completeProcedure({ surgeryId, facilityId, byUserId: by });
    });
    // 9b. Blood (the seeded PRBC component): a unit, the patient's typing, the
    // request, a verified crossmatch, the issue (→ charge-capture at BLOOD:PRBC).
    const prbc = await prisma.bloodProduct.findUniqueOrThrow({ where: { facilityId_code: { facilityId, code: "PRBC" } } });
    const unit = await registerBloodUnit({ facilityId, productId: prbc.id, unitNumber: `CJ-U-${run}`, expiresAt: new Date(Date.now() + 20 * 86_400_000), registeredByStaffId: doctor.id, byUserId: by });
    await releaseUnit({ unitId: unit.id, facilityId, byUserId: by });
    await drain();
    mark = (await prisma.domainEventOutbox.findFirst({ where: { correlationId: enc.id }, orderBy: { seq: "desc" }, select: { seq: true } }))?.seq ?? mark;
    // The verified crossmatch makes the request READY (its fourth status change).
    await step("9b Blood", ["BloodCompatibilityRecorded", "BloodRequestStatusChanged", "BloodRequestStatusChanged", "BloodRequestStatusChanged", "BloodCompatibilityRecorded", "BloodRequestStatusChanged", "BloodIssued", "ChargePosted"], async () => {
      await recordPatientTyping({ facilityId, patientId: patient.id, encounterId: enc.id, aboGroup: "O", rhStatus: "POSITIVE", performedByStaffId: doctor.id, byUserId: by });
      const breq = await requestBlood({ facilityId, patientId: patient.id, encounterId: enc.id, productId: prbc.id, priority: "URGENT", requestedByStaffId: doctor.id, byUserId: by });
      await transitionRequest({ requestId: breq.id, facilityId, to: "REVIEWED", actorStaffId: doctor.id, byUserId: by });
      await transitionRequest({ requestId: breq.id, facilityId, to: "APPROVED", actorStaffId: doctor.id, byUserId: by });
      const test = await recordCompatibility({ requestId: breq.id, facilityId, unitId: unit.id, status: "COMPATIBLE", testedByStaffId: doctor.id, byUserId: by });
      await verifyCompatibility({ testId: test.id, facilityId, verifiedByStaffId: doctor.id, byUserId: by });
      bloodIssueId = (await issueUnit({ requestId: breq.id, facilityId, unitId: unit.id, compatibilityTestId: test.id, issuedByStaffId: doctor.id, byUserId: by })).id;
    });
  }
  // 10–14 (batch 5 (d)): pre-authorization, discharge, invoice → claim draft,
  // a late charge and its supplementary invoice.
  const billing = { preAuthId: "", dischargeId: "", invoiceId: "", supplementaryId: "", lateChargeId: "", readinessBeforeFinalize: "" };
  if (opts.full) {
    const payer = await tx((t) => createPayer(t, { name: `CJ Insurer ${run}`, type: "INSURANCE" }));
    const coverage = await tx((t) => addPatientCoverage(t, { patientId: patient.id, payerId: payer.id, memberId: `CJ-${run}`, validFrom: new Date(Date.now() - 86_400_000), addedByUserId: by }));
    await step("10 Pre-authorization", ["PreauthStatusChanged", "PreauthDecided"], async () => {
      billing.preAuthId = (await tx((t) => requestPreAuth(t, { coverageId: coverage.id, encounterId: enc.id, requestedAmountMinor: 500_000, requestedByUserId: by }))).id;
      await tx((t) => decidePreAuth(t, billing.preAuthId, { status: "APPROVED", approvedAmountMinor: 400_000, byUserId: by }));
    });
    // 11. Discharge: initiation (→ prep task), the summary (→ documentationReady,
    // and insuranceReady from the approved pre-authorization), the human flags,
    // finalize (bed-days charged in-transaction).
    await step("11 Discharge", ["DischargeInitiated", "TaskCreated", "DocumentGenerated", "ChargePosted", "PatientDischarged", "EncounterClosed", "TaskCompleted"], async () => {
      billing.dischargeId = (await initiateDischarge(admissionId, by, doctor.id)).id;
      await generateAndStoreDocument({ type: "discharge-summary", patient: { name: patient.fullName }, diagnoses: ["NSTEMI"] },
        { facilityId, letterhead: { facilityName: "Aarogya Medical Centre", authorName: "Dr Verify", authorRegistration: "MMC-0000" }, issuedByUserId: by, patientId: patient.id, encounterId: enc.id });
      await drain();
      const d = await prisma.discharge.findUniqueOrThrow({ where: { id: billing.dischargeId } });
      billing.readinessBeforeFinalize = `${d.documentationReady}/${d.insuranceReady}/${d.billingReady}`;
      await updateDischargeReadiness(billing.dischargeId, { clinicallyReady: true, billingReady: true, pharmacyReady: true, transportReady: true });
      await finalizeDischarge(billing.dischargeId, by, { summary: "core journey" });
    });
    // 12–13. The final bill (every charge priced from the catalogue): draft
    // every charge, issue (→ claim-drafting drafts the claim with the pre-authorization).
    await step("12 Invoice → 13 claim draft", ["HospitalInvoiceIssued", "ClaimDrafted"], async () => {
      const inv = await tx(async (t) => {
        const draft = await draftInvoiceForAccount(t, { encounterId: enc.id, patientId: patient.id, facilityId, generatedByUserId: by });
        for (const c of await t.charge.findMany({ where: { encounterId: enc.id, status: "POSTED", invoiceLine: null }, select: { id: true } })) await addChargeToInvoice(t, draft.id, c.id);
        return issueInvoice(t, draft.id, { byUserId: by });
      });
      billing.invoiceId = inv.id;
    });
    await step("14a Late charge", ["ChargePosted", "TaskCreated"], async () => {
      billing.lateChargeId = (await tx((t) => createCharge(t, { encounterId: enc.id, patientId: patient.id, facilityId, description: "Discharge medication pack", category: "PHARMACY", unitPriceMinor: 12_000, postedByUserId: by }))).charge.id;
    });
    // The supplementary invoice closes the late-charge task and gets its own
    // draft claim (the pre-authorization is on the first claim → blocker task).
    await step("14b Supplementary invoice", ["HospitalInvoiceIssued", "TaskCompleted", "ClaimDrafted", "TaskCreated"], async () => {
      billing.supplementaryId = (await tx(async (t) => issueInvoice(t, (await draftSupplementaryInvoice(t, { originalInvoiceId: billing.invoiceId, generatedByUserId: by })).id, { byUserId: by }))).id;
    });
  }
  return { facilityId, patientId: patient.id, encounterId: enc.id, orderId, resultId, surgeryId, usageId, bloodIssueId, uploadedDocumentId, steps, registered, openAfter8, critTask, billing };
}

async function main() {
  const a = await journey("fac-amc-pune", "A", { full: true });
  const b = await journey("fac-amc-noida", "B", { full: false });

  report("1 Register: PatientRegistered once", a.registered === 1);
  for (const s of a.steps) report(`${s.name}: ${sorted(s.expected)}`, sorted(s.got) === sorted(s.expected), s.got.join(" → "));

  const all = await prisma.domainEventOutbox.findMany({ where: { correlationId: a.encounterId }, orderBy: { seq: "asc" } });
  const producers = all.map((e) => e.eventType).filter((t) => !t.startsWith("Task"));
  // IcuAdmitted is emitted before PatientTransferred inside the transfer (as the ADT gate asserts).
  // ChargePosted (step 9): the ICU fee and the theatre charges come from charge-capture after
  // their event; the lab and dispensing charges are posted in their own transaction.
  // StockMoved (step 9a): the dispense (in its transaction) and the stent (stock-movement).
  const expectedProducers = ["EdArrivalRegistered", "PatientTriaged", "AdmissionRequested", "BedReserved", "AdmissionCreated", "IcuAdmitted", "PatientTransferred", "ChargePosted",
    "ChargePosted", "LabOrderPlaced", "SpecimenCollected", "SpecimenStatusChanged", "LabResultReleased", "CriticalResultAcknowledged", "MedicationOrdered", "MedicationVerified", "StockMoved", "MedicationDispensed", "ChargePosted", "MedicationAdministered",
    "SurgeryRequested", "SurgeryStatusChanged", "SurgeryStatusChanged", "SurgeryScheduled", "ProcedureStarted", "SurgeryItemUsed", "ProcedureCompleted", "ChargePosted", "StockMoved", "ChargePosted",
    "BloodCompatibilityRecorded", "BloodRequestStatusChanged", "BloodRequestStatusChanged", "BloodRequestStatusChanged", "BloodCompatibilityRecorded", "BloodRequestStatusChanged", "BloodIssued", "ChargePosted",
    // 9b: blood. 10–14: pre-authorization, discharge (bed-days in finalize), invoice → claim, late charge → supplementary → its claim.
    "PreauthStatusChanged", "PreauthDecided", "DischargeInitiated", "DocumentGenerated", "ChargePosted", "PatientDischarged", "EncounterClosed",
    "HospitalInvoiceIssued", "ClaimDrafted", "ChargePosted", "HospitalInvoiceIssued", "ClaimDrafted"];
  report("The producers' events, in emission order", producers.join() === expectedProducers.join(), producers.join(" → "));

  const bad = all.flatMap((e) => {
    const c = getEventContract(e.eventType, e.eventVersion);
    if (!c) return [`${e.eventType}: no contract`];
    if (!c.payload.safeParse(e.payload).success) return [`${e.eventType}: payload fails its contract`];
    try { assertNoSensitiveData(e.payload as Record<string, unknown>); } catch { return [`${e.eventType}: sensitive data`]; }
    return [];
  });
  report(`Every payload (${all.length}) passes its contract and the sensitive-data guard`, bad.length === 0, bad.join("; "));

  const ids = all.map((e) => e.eventId);
  const notProcessed = await prisma.domainEventDelivery.count({ where: { eventId: { in: ids }, status: { not: "PROCESSED" } } });
  const dead = await prisma.domainEventOutbox.count({ where: { eventId: { in: ids }, status: "DEAD_LETTER" } });
  report("Every delivery PROCESSED; zero dead letters", notProcessed === 0 && dead === 0, `${notProcessed} unprocessed, ${dead} dead`);

  const crit = await a.critTask();
  const ack = all.find((e) => e.eventType === "CriticalResultAcknowledged")!;
  const result = await prisma.labResult.findUniqueOrThrow({ where: { id: a.resultId } });
  report("The critical-result task opened at 8 is completed by 8a", a.openAfter8 === "OPEN" && crit?.status === "COMPLETED");
  report("minutesToAcknowledge matches the stored timestamps",
    (ack.payload as { minutesToAcknowledge: number }).minutesToAcknowledge === Math.floor((result.acknowledgedAt!.getTime() - result.verifiedAt!.getTime()) / 60_000));
  const uploadedEvents = await prisma.domainEventOutbox.count({ where: { eventType: "PatientDocumentUploaded", aggregateId: a.uploadedDocumentId } });
  const listed = await prisma.clinicalDocument.count({ where: { id: a.uploadedDocumentId, facilityId: a.facilityId, patientId: a.patientId } });
  const reviewTasks = await prisma.task.count({ where: { facilityId: a.facilityId, idempotencyKey: `DOCUMENT_REVIEW:${a.uploadedDocumentId}` } });
  report("8b Outside report: PatientDocumentUploaded once, in the facility's document list, exactly one review task", uploadedEvents === 1 && listed === 1 && reviewTasks === 1, `${uploadedEvents}/${listed}/${reviewTasks}`);
  const doses = await prisma.medicationAdministration.count({ where: { medicationOrderId: a.orderId } });
  report("mar-scheduler scheduled the BD doses once", doses === 3, String(doses));
  const otCharges = await prisma.charge.count({ where: { OR: [{ sourceType: "Surgery", sourceId: a.surgeryId }, { sourceType: "SurgeryItemUsage", sourceId: a.usageId }, { sourceType: "IcuAdmission" }], encounterId: a.encounterId } });
  const kitIssued = await prisma.stockLedgerEntry.count({ where: { sourceType: "SurgeryItemUsage", sourceId: a.usageId } });
  report("9 OT: charge-capture charged the procedure, the implant and the ICU admission once each; stock-movement issued the stent once", otCharges === 3 && kitIssued === 1, `${otCharges} charges, ${kitIssued} ledger`);
  const catalogueCharges = await prisma.charge.findMany({ where: { encounterId: a.encounterId, OR: [{ sourceType: "Surgery", sourceId: a.surgeryId }, { sourceType: "SurgeryItemUsage", sourceId: a.usageId }, { sourceType: "BloodIssue", sourceId: a.bloodIssueId }] } });
  const codes = catalogueCharges.map((c) => `${c.chargeCode}:${c.pricingStatus}`).sort().join();
  report("9/9b: the seeded catalogue's specific tariffs priced PTCA, the stent and the PRBC unit (no generic, nothing needing a price)",
    codes === [`BLOOD:PRBC:PRICED`, `ITEM:${implantSku("DES", a.facilityId)}:PRICED`, "PROCEDURE:PTCA:PRICED"].sort().join(), codes);

  // 10–14: discharge, billing and claims.
  const bl = a.billing;
  report("11 Discharge: discharge-readiness raised documentation and insurance (approved pre-authorization), not billing (charges unbilled)",
    bl.readinessBeforeFinalize === "true/true/false", bl.readinessBeforeFinalize);
  const claim = await prisma.claim.findUnique({ where: { invoiceId: bl.invoiceId } });
  report("13 Claim draft: claim-drafting drafted one DRAFT claim with the pre-authorization, never submitted",
    claim?.status === "DRAFT" && claim.preAuthorizationId === bl.preAuthId && claim.submittedAt === null);
  const late = await prisma.charge.findUniqueOrThrow({ where: { id: bl.lateChargeId }, include: { invoiceLine: true } });
  const sup = await prisma.invoice.findUniqueOrThrow({ where: { id: bl.supplementaryId } });
  const lateTask = await prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId: a.facilityId, idempotencyKey: `LATE_CHARGE:${late.id}` } } });
  report("14 Late charge: marked late, collected on a SUPPLEMENTARY_INVOICE linked to the invoice, its task completed",
    late.isLate && late.invoiceLine?.invoiceId === sup.id && sup.documentType === "SUPPLEMENTARY_INVOICE" && sup.supplementsInvoiceId === bl.invoiceId && lateTask?.status === "COMPLETED");
  const supClaim = await prisma.claim.findUnique({ where: { invoiceId: sup.id } });
  const blocker = supClaim ? await prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId: a.facilityId, idempotencyKey: `CLAIM_PREAUTH_MISSING:${supClaim.id}` } } }) : null;
  report("…the supplementary invoice has its own draft claim, with a blocker task (its pre-authorization is on the first claim)",
    supClaim?.status === "DRAFT" && supClaim.preAuthorizationId === null && blocker?.status === "OPEN");
  const posted = await prisma.charge.findMany({ where: { encounterId: a.encounterId, status: "POSTED" }, include: { invoiceLine: true } });
  const docs = await prisma.invoice.findMany({ where: { encounterId: a.encounterId, status: { not: "VOID" } } });
  const charged = posted.reduce((n, c) => n + c.netAmountMinor, 0);
  const billed = docs.reduce((n, d) => n + d.totalMinor, 0);
  report("Every charge of the journey billed exactly once (each on one line; the invoice and the supplementary add up to the charges)",
    posted.every((c) => c.invoiceLine) && docs.length === 2 && charged === billed && charged > 0, `charged ${charged}, billed ${billed}, ${posted.length} charges`);

  // Replay every event of journey A through replay.ts; nothing new may appear.
  const counts = async () => [
    await prisma.task.count({ where: { encounterId: a.encounterId } }),
    await prisma.notification.count({ where: { encounterId: a.encounterId } }),
    await prisma.medicationAdministration.count({ where: { medicationOrder: { encounterId: a.encounterId } } }),
    await prisma.charge.count({ where: { encounterId: a.encounterId } }),
    await prisma.stockLedgerEntry.count({ where: { encounterId: a.encounterId } }),
    await prisma.claim.count({ where: { invoice: { encounterId: a.encounterId } } }),
  ].join("/");
  const before = await counts();
  const admin = await prisma.user.findFirstOrThrow({ where: { role: "AAROGYA_ADMIN" }, orderBy: { id: "asc" } });
  const platform = await loadActorMemberships(admin.id, "AAROGYA_ADMIN");
  for (const id of ids) await replayEvent(platform, id, { reason: "core-journey replay gate" });
  await drain();
  const after = await counts();
  report("Replay: re-running every event creates no task, notification, dose, charge, stock movement or claim (tasks/notifications/doses/charges/ledger/claims)", after === before, `${before} → ${after}`);
  const replayDead = await prisma.domainEventOutbox.count({ where: { eventId: { in: ids }, status: { not: "PROCESSED" } } });
  report("…and every replayed event is PROCESSED again", replayDead === 0, String(replayDead));

  // Tenancy: each journey's rows stay in its own facility.
  const leak = await Promise.all([
    prisma.task.count({ where: { encounterId: a.encounterId, facilityId: { not: a.facilityId } } }),
    prisma.task.count({ where: { encounterId: b.encounterId, facilityId: { not: b.facilityId } } }),
    prisma.notification.count({ where: { encounterId: a.encounterId, facilityId: { not: a.facilityId } } }),
    prisma.notification.count({ where: { encounterId: b.encounterId, facilityId: { not: b.facilityId } } }),
    prisma.domainEventOutbox.count({ where: { correlationId: b.encounterId, facilityId: { not: b.facilityId } } }),
  ]);
  report("Tenancy: the parallel journey in another facility writes only its own rows", leak.every((n) => n === 0), leak.join(","));
  report("…and it ran the same chain there (steps 2–8a)", b.steps.every((s) => sorted(s.got) === sorted(s.expected)), b.steps.map((s) => `${s.name}:${s.got.length}`).join(" "));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
