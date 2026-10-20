/**
 * Workflow spine §7: the core-journey replay test. Grows a step at a time
 * (§9); this version covers steps 1–8a of the §7 journey, the medication
 * round that step 6 wired (with a dose not given and a reorder crossing),
 * step 9 (OT, with the charge-capture and stock-movement consumers), blood,
 * waste held then rejected, the portal upload (8b), pre-authorization,
 * discharge (with a discharge hold), invoice → claim draft, a late charge and
 * its supplementary invoice, and access and identity (break-glass, an ABHA
 * link). Final for Week 3 (batch 8): every consumer takes part. Week 4b: the
 * rag-indexer indexes the journey's record, and the treating doctor asks the
 * AI about the patient (cited, logged, nothing written).
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
import "./lib/gateBootstrap";
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
import { uploadPatientDocument } from "../src/lib/patient/experience/documents";
import type { PatientAccessScope } from "../src/lib/patient/context";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";
import { recordWaste, rejectWaste } from "../src/lib/hospital/inventory/waste";
import { placeDischargeHold, clearDischargeHold, DischargeOnHoldError } from "../src/lib/hospital/dischargeHold";
import { activateBreakGlass, completeBreakGlass } from "../src/lib/auth/authorize/breakGlass";
import { linkExternalIdentifier } from "../src/lib/hospital/interoperability/externalIdentity";
import { IDENTIFIER_SYSTEMS } from "../src/lib/hospital/interoperability/shared";
import { EXPECTED_CONSUMERS } from "../src/lib/runner/consumers";
import { implantSku } from "../prisma/seedData/clinicalCatalogue";
import { registerBloodUnit, releaseUnit, recordPatientTyping, requestBlood, transitionRequest, recordCompatibility, verifyCompatibility, issueUnit } from "../src/lib/hospital/blood";
import { createPayer, addPatientCoverage } from "../src/lib/hospital/billing/coverage";
import { requestPreAuth, decidePreAuth } from "../src/lib/hospital/billing/preauth";
import { initiateDischarge, updateDischargeReadiness, finalizeDischarge } from "../src/lib/hospital/admission";
import { generateAndStoreDocument } from "../src/lib/documents/service";
import { draftInvoiceForAccount, addChargeToInvoice, issueInvoice, draftSupplementaryInvoice } from "../src/lib/hospital/billing/invoices";
import { createCharge } from "../src/lib/hospital/billing/chargeCapture";
import { linkAccountForGate } from "./lib/personFixture";
import { askAi, AskError } from "../src/lib/rag/ask";
import { issueAccessCode, redeemAccessCode } from "../src/lib/patient/accessSession";
import { DEFAULT_SHARE_CATEGORIES, parseShareChoice } from "../src/lib/sharing/categories";
import { viewSharedRecord } from "../src/lib/sharing/view";
import { indexSource } from "../src/lib/rag/indexer";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { searchDirectory, locationSlots } from "../src/lib/doctors/directory";
import { bookThroughDirectory, cancelOwnDirectoryBooking } from "../src/lib/doctors/booking";
import { facilityAdmin, networkDoctor, verifier } from "./lib/doctorFixture";
import { revokeAllAccess } from "../src/lib/sharing/revokeAll";
import { decidePersonConsent } from "../src/lib/person/consent";
import { personDocumentDownload, staffPersonDocuments, uploadPersonDocument, withdrawPersonDocument } from "../src/lib/person/documents";
import { fixtureById, fixturePdf } from "../src/lib/documents/fixtures";
import { bulkReview, listOwnFacts } from "../src/lib/documents/review";
import { buildPatientTimeline } from "../src/lib/patient/timeline";

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
  let journeyPersonId = "";
  let processingId = "";
  let secondDocumentId = "";
  let providedBeforeReview = -1;
  let timelineBeforeReview = -1;
  if (opts.full) {
    const portalUser = await prisma.user.create({ data: { email: `cj-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "Journey patient" } });
    await linkAccountForGate(prisma, portalUser.id, patient.id);
    // Phase 0: the care team sees the upload because the person chose to share
    // uploads with hospitals treating them (the open encounter is the relationship).
    await decidePersonConsent({ userId: portalUser.id, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
    // Week 4a: a gate Person is SYNTHETIC, so the document pipeline (mock providers) reads the upload:
    // a synthetic Hindi kidney-function report, translated for an English reader.
    journeyPersonId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: portalUser.id } })).personId;
    await prisma.person.update({ where: { id: journeyPersonId }, data: { dataClassification: "SYNTHETIC", preferredLanguage: "en" } });
    const scope: PatientAccessScope = { patientId: patient.id, patientIds: [patient.id], facilityId, isSelf: true, allowedClasses: new Set(["RECORDS", "REPORTS"]) };
    uploadedDocumentId = (await uploadPatientDocument(scope, portalUser.id, { bytes: await fixturePdf(fixtureById("lab-hi-kft")!), contentType: "application/pdf", originalName: "outside.pdf", title: "Outside kidney function report", type: "REPORT" })).id;
    await drain();
    processingId = (await prisma.documentProcessing.findFirst({ where: { documentId: uploadedDocumentId } }))?.id ?? "";
    // The person reviews it: the printed lab values are HIGH, so they confirm them together; doc-merge
    // makes them patient-provided entries. Before that, nothing extracted is in the record.
    providedBeforeReview = await prisma.patientProvidedRecord.count({ where: { personId: journeyPersonId } });
    timelineBeforeReview = (await buildPatientTimeline(patient.id, { kind: "STAFF", facilityId })).filter((e) => e.sourceType === "PatientProvidedRecord").length;
    const facts = await listOwnFacts(portalUser.id, { processingId });
    await bulkReview(portalUser.id, { decisions: facts.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })) });
    await drain();
    // …and withdraws a second, mistaken upload: its run and anything derived from it go too.
    const second = await uploadPatientDocument(scope, portalUser.id, { bytes: await fixturePdf(fixtureById("lab-en-cbc")!), contentType: "application/pdf", originalName: "wrong.pdf", title: "Wrong report", type: "REPORT" });
    await drain();
    await withdrawPersonDocument(portalUser.id, second.id);
    await drain();
    secondDocumentId = second.id;
  }

  let orderId = "";
  let drugItemId = "";
  if (opts.full) {
    // 8c. A medication round: order, verify (→ mar-scheduler doses), dispense, administer.
    const pharmacist = (await staffOf("PHARMACIST"))!;
    const pharmacy = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId, name: "Central Pharmacy" } });
    const drugName = `CoreJourneyDrug${run}`;
    // Reorder point 9 with 10 in stock: the dispense of 2 crosses it (→ StockBelowReorder, a reorder task).
    const item = await prisma.item.create({ data: { facilityId, sku: `CJ-${run}`, name: drugName, category: "MEDICATION", baseUnit: "TABLET", reorderPoint: 9, reorderQuantity: 50 } });
    drugItemId = item.id;
    await tx((t) => linkMedicationToItem(t, SYSTEM_ACTOR, { target: { scope: "FACILITY", facilityId }, drugName, itemId: item.id }));
    const lot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId, lotNumber: `CJ-LOT-${run}`, status: "ACTIVE", expiresAt: new Date("2029-01-01") } });
    await tx((t) => createAdjustment(t, { facilityId, itemId: item.id, lotId: lot.id, locationId: pharmacy.id, quantityDelta: 10, reason: "FOUND", requestedByStaffId: pharmacist.id, actorUserId: pharmacist.userId, idempotencyKey: `cj-${run}` }));
    await step("8c Medication", ["MedicationOrdered", "MedicationVerified", "StockMoved", "MedicationDispensed", "ChargePosted", "MedicationAdministered", "MedicationDoseNotGiven"], async () => {
      const o = await createMedicationOrder({ facilityId, encounterId: enc.id, patientId: patient.id, orderingStaffId: doctor.id, drugName, dose: "1 tab", route: "PO", frequency: "BD", overrideReason: "journey", byUserId: by });
      if (o.blocked) throw new Error("unexpected safety block");
      orderId = o.order.id;
      await verifyMedicationOrder(orderId, pharmacist.id, pharmacist.userId);
      await drain(); // mar-scheduler writes the doses
      await dispenseMedication({ medicationOrderId: orderId, pharmacistStaffId: pharmacist.id, quantity: 2, quantityUnit: "TABLET", dispensingLocationId: pharmacy.id, byUserId: pharmacist.userId });
      const first = await prisma.medicationAdministration.findFirstOrThrow({ where: { medicationOrderId: orderId, status: "DUE" }, orderBy: { scheduledAt: "asc" } });
      await administerMedication({ administrationId: first.id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId });
      // The next dose is held (nil by mouth): MedicationDoseNotGiven.
      const second = await prisma.medicationAdministration.findFirstOrThrow({ where: { medicationOrderId: orderId, status: "DUE" }, orderBy: { scheduledAt: "asc" } });
      await administerMedication({ administrationId: second.id, status: "HELD", reasonCode: "NPO", administeredByStaffId: nurse.id, byUserId: nurse.userId });
    });
  }
  let surgeryId = "";
  let identifierId = "";
  let usageId = "";
  let bloodIssueId = "";
  let wasteId = "";
  let wasteBalance = "";
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
    // 9c. Waste awaiting approval holds its stock; rejected, it returns it (approved change 4).
    const waste = await prisma.item.create({ data: { facilityId, sku: `CJ-W-${run}`, name: `Dressing ${run}`, category: "CONSUMABLE", baseUnit: "PIECE" } });
    const wasteLot = await prisma.itemLot.create({ data: { itemId: waste.id, facilityId, lotNumber: `CJ-W-LOT-${run}`, status: "ACTIVE", expiresAt: new Date("2030-01-01") } });
    for (const q of [40, 30]) await tx((t) => createAdjustment(t, { facilityId, itemId: waste.id, lotId: wasteLot.id, locationId: pharmacy.id, quantityDelta: q, reason: "FOUND", requestedByStaffId: doctor.id, actorUserId: by, idempotencyKey: `cj-w-${q}-${run}` }));
    await step("9c Waste hold → reject", ["StockMoved", "StockMoved"], async () => {
      wasteId = (await tx((t) => recordWaste(t, { facilityId, itemId: waste.id, lotId: wasteLot.id, locationId: pharmacy.id, quantity: 60, reason: "CONTAMINATED", encounterId: enc.id, patientId: patient.id, requestedByStaffId: doctor.id, actorUserId: by, idempotencyKey: `cj-waste-${run}` }))).waste.id;
      await tx((t) => rejectWaste(t, wasteId, { actorUserId: nurse.userId, rejectedByStaffId: nurse.id }));
    });
    wasteBalance = await prisma.stockBalance.findFirstOrThrow({ where: { lotId: wasteLot.id, locationId: pharmacy.id } }).then((b) => `${b.onHandQty}/${b.reservedQty}`);
  }
  // 10–14 (batch 5 (d)): pre-authorization, discharge, invoice → claim draft,
  // a late charge and its supplementary invoice.
  const billing = { preAuthId: "", dischargeId: "", invoiceId: "", supplementaryId: "", lateChargeId: "", readinessBeforeFinalize: "", finalizeRefusedOnHold: false };
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
    await step("11 Discharge", ["DischargeInitiated", "TaskCreated", "DocumentGenerated", "DischargeHoldChanged", "DischargeHoldChanged", "ChargePosted", "PatientDischarged", "EncounterClosed", "TaskCompleted"], async () => {
      billing.dischargeId = (await initiateDischarge(admissionId, by, doctor.id)).id;
      await generateAndStoreDocument({ type: "discharge-summary", patient: { name: patient.fullName }, diagnoses: ["NSTEMI"] },
        { facilityId, letterhead: { facilityName: "Aarogya Medical Centre", authorName: "Dr Verify", authorRegistration: "MMC-0000" }, issuedByUserId: by, patientId: patient.id, encounterId: enc.id });
      await drain();
      const d = await prisma.discharge.findUniqueOrThrow({ where: { id: billing.dischargeId } });
      billing.readinessBeforeFinalize = `${d.documentationReady}/${d.insuranceReady}/${d.billingReady}`;
      await updateDischargeReadiness(billing.dischargeId, { clinicallyReady: true, billingReady: true, pharmacyReady: true, transportReady: true });
      // A billing hold: finalize is refused until it is cleared.
      const hold = await placeDischargeHold({ dischargeId: billing.dischargeId, facilityId, reasonCode: "BILLING", byUserId: by });
      billing.finalizeRefusedOnHold = await finalizeDischarge(billing.dischargeId, by, { summary: "core journey" }).then(() => false, (e) => e instanceof DischargeOnHoldError);
      await clearDischargeHold({ holdId: hold.id, facilityId, byUserId: by });
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
    // 15. Access and identity: an emergency (break-glass) window on the encounter, completed; an ABHA number linked.
    await step("15 Access and identity", ["BreakGlassStatusChanged", "BreakGlassStatusChanged"], async () => {
      const w = await activateBreakGlass({ facilityId, patientId: patient.id, encounterId: enc.id, actorUserId: by, actorStaffId: doctor.id, reason: "Core journey: unconscious on readmission review", emergencyContext: "UNCONSCIOUS_PATIENT" });
      await completeBreakGlass({ facilityId, breakGlassId: w.id, actorUserId: by });
      identifierId = (await linkExternalIdentifier({ facilityId, entityType: "PATIENT", entityId: patient.id, system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: `CJ-ABHA-${run}`, byUserId: by })).id;
    });
  }
  return { doctorUserId: doctor.userId, facilityId, patientId: patient.id, encounterId: enc.id, orderId, resultId, surgeryId, usageId, bloodIssueId, uploadedDocumentId, journeyPersonId, processingId, secondDocumentId, providedBeforeReview, timelineBeforeReview, steps, registered, openAfter8, critTask, billing, drugItemId, wasteId, wasteBalance, identifierId };
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
    "ChargePosted", "LabOrderPlaced", "SpecimenCollected", "SpecimenStatusChanged", "LabResultReleased", "CriticalResultAcknowledged",
    "MedicationOrdered", "MedicationVerified", "StockMoved", "MedicationDispensed", "ChargePosted", "MedicationAdministered", "MedicationDoseNotGiven",
    "SurgeryRequested", "SurgeryStatusChanged", "SurgeryStatusChanged", "SurgeryScheduled", "ProcedureStarted", "SurgeryItemUsed", "ProcedureCompleted", "ChargePosted", "StockMoved", "ChargePosted",
    // 9b: blood; 9c: waste held then released.
    "BloodCompatibilityRecorded", "BloodRequestStatusChanged", "BloodRequestStatusChanged", "BloodRequestStatusChanged", "BloodCompatibilityRecorded", "BloodRequestStatusChanged", "BloodIssued", "ChargePosted",
    "StockMoved", "StockMoved",
    // 10–14: pre-authorization, discharge (a hold placed and cleared; bed-days in finalize), invoice → claim, late charge → supplementary → its claim.
    "PreauthStatusChanged", "PreauthDecided", "DischargeInitiated", "DocumentGenerated", "DischargeHoldChanged", "DischargeHoldChanged", "ChargePosted", "PatientDischarged", "EncounterClosed",
    "HospitalInvoiceIssued", "ClaimDrafted", "ChargePosted", "HospitalInvoiceIssued", "ClaimDrafted",
    // 15: break-glass (the identifier link is checked by aggregate: it is not correlated by the encounter).
    "BreakGlassStatusChanged", "BreakGlassStatusChanged"];
  report("The producers' events, in emission order", producers.join() === expectedProducers.join(), producers.join(" → "));

  const bad = all.flatMap((e) => {
    const c = getEventContract(e.eventType, e.eventVersion);
    if (!c) return [`${e.eventType}: no contract`];
    if (!c.payload.safeParse(e.payload).success) return [`${e.eventType}: payload fails its contract`];
    try { assertNoSensitiveData(e.payload as Record<string, unknown>); } catch { return [`${e.eventType}: sensitive data`]; }
    return [];
  });
  report(`Every payload (${all.length}) passes its contract and the sensitive-data guard`, bad.length === 0, bad.join("; "));

  // The journey's events that are not correlated by the encounter (stock, documents, identity), by aggregate.
  const side = await prisma.domainEventOutbox.findMany({
    where: { OR: [
      { eventType: "StockBelowReorder", aggregateId: a.drugItemId },
      { eventType: "StockDocumentStatusChanged", aggregateId: a.wasteId },
      { eventType: "ExternalIdentifierStatusChanged", aggregateId: a.identifierId },
      // 8b: the upload and the document pipeline's run (PERSON events).
      { eventType: "PersonDocumentUploaded", aggregateId: a.uploadedDocumentId },
      { aggregateType: "DOCUMENT_PROCESSING", aggregateId: a.processingId },
      // …the review, the entries, the sharing choice, the withdrawn second upload (and its run).
      { personId: a.journeyPersonId, eventType: { in: ["PersonConsentDecided", "PatientProvidedRecordAdded", "PersonDocumentUploaded", "PersonDocumentWithdrawn", "RecordConflictDetected"] } },
      { personId: a.journeyPersonId, aggregateType: "DOCUMENT_PROCESSING" },
    ] },
    orderBy: { seq: "asc" },
  });
  const ids = [...all, ...side].map((e) => e.eventId);
  // Week 5a: the journey's directory booking (below) joins the journey's events.
  const directoryEventIds: string[] = [];
  const notProcessed = await prisma.domainEventDelivery.count({ where: { eventId: { in: ids }, status: { not: "PROCESSED" } } });
  const dead = await prisma.domainEventOutbox.count({ where: { eventId: { in: ids }, status: "DEAD_LETTER" } });
  report("Every delivery PROCESSED; zero dead letters", notProcessed === 0 && dead === 0, `${notProcessed} unprocessed, ${dead} dead`);

  const crit = await a.critTask();
  const ack = all.find((e) => e.eventType === "CriticalResultAcknowledged")!;
  const result = await prisma.labResult.findUniqueOrThrow({ where: { id: a.resultId } });
  report("The critical-result task opened at 8 is completed by 8a", a.openAfter8 === "OPEN" && crit?.status === "COMPLETED");
  report("minutesToAcknowledge matches the stored timestamps",
    (ack.payload as { minutesToAcknowledge: number }).minutesToAcknowledge === Math.floor((result.acknowledgedAt!.getTime() - result.verifiedAt!.getTime()) / 60_000));
  // Phase 0, part 2: the upload is the person's own document (PersonDocument, PERSON event); the
  // facility sees it through the resolver because the person shared and is being treated there.
  const uploadedEvents = await prisma.domainEventOutbox.count({ where: { eventType: "PersonDocumentUploaded", aggregateId: a.uploadedDocumentId } });
  const listed = (await staffPersonDocuments(a.facilityId, [a.patientId])).filter((d) => d.id === a.uploadedDocumentId).length;
  const reviewTasks = await prisma.task.count({ where: { facilityId: a.facilityId, idempotencyKey: `DOCUMENT_REVIEW:${a.uploadedDocumentId}` } });
  report("8b Outside report (shared with treating hospitals): PersonDocumentUploaded once, visible to the treating facility, exactly one review task", uploadedEvents === 1 && listed === 1 && reviewTasks === 1, `${uploadedEvents}/${listed}/${reviewTasks}`);
  // Week 4a: the pipeline read it (synthetic Person, mock providers): pages, text, a translation for an English reader.
  const run8b = await prisma.documentProcessing.findUnique({ where: { id: a.processingId }, include: { steps: true, texts: { include: { translations: true } } } });
  const stepsDone = (run8b?.steps ?? []).filter((s) => s.status === "DONE").length;
  report("8b …the document pipeline split, read (hi), translated (exact-copy check passed) and extracted it",
    stepsDone === 5 && run8b?.texts[0]?.language === "hi" && run8b.texts[0].translations[0]?.exactCopyCheck === "PASSED", run8b?.steps.map((s) => `${s.step}:${s.status}`).join(" "));
  const provided = await prisma.patientProvidedRecord.findMany({ where: { personId: a.journeyPersonId, status: "ACTIVE" } });
  report("8b …nothing entered the record before review; once confirmed, the four lab values are patient-provided entries and the run is COMPLETED",
    a.providedBeforeReview === 0 && provided.length === 4 && provided.every((r) => r.kind === "LAB_RESULT" && r.source === "PATIENT_PROVIDED" && r.documentId === a.uploadedDocumentId) && run8b?.status === "COMPLETED");
  // …and the timeline: the confirmed entries, labelled as from the patient's document, for the treating
  // clinician (opt-in and the open encounter) and on the patient's side; none before the review.
  const staffTimeline = (await buildPatientTimeline(a.patientId, { kind: "STAFF", facilityId: a.facilityId })).filter((e) => e.sourceType === "PatientProvidedRecord");
  const ownTimeline = (await buildPatientTimeline(a.patientId, { kind: "PATIENT" })).filter((e) => e.sourceType === "PatientProvidedRecord");
  report("8b …on the timeline: the four entries for the treating clinician and the patient, labelled, values as confirmed; none before review",
    a.timelineBeforeReview === 0 && staffTimeline.length === 4 && ownTimeline.length === 4
      && staffTimeline.some((e) => e.summary === "Lab result from the patient's document: Creatinine 1.42 mg/dL") && staffTimeline.every((e) => e.type === "Patient-provided" && e.timestamp.startsWith("2026-02-05")),
    `${a.timelineBeforeReview}/${staffTimeline.length}/${ownTimeline.length}`);
  const otherFacility = a.facilityId === "fac-amc-pune" ? "fac-amc-noida" : "fac-amc-pune";
  report("8b …another facility's timeline of the record shows none of them", (await buildPatientTimeline(a.patientId, { kind: "STAFF", facilityId: otherFacility })).every((e) => e.sourceType !== "PatientProvidedRecord"));
  const run8w = await prisma.documentProcessing.findFirst({ where: { documentId: a.secondDocumentId } });
  report("8b …the withdrawn second upload: its run CANCELLED, its pending facts discarded",
    run8w?.status === "CANCELLED" && (await prisma.extractedFact.count({ where: { processingId: run8w.id } })) === 0);
  const doses = await prisma.medicationAdministration.count({ where: { medicationOrderId: a.orderId } });
  report("mar-scheduler scheduled the BD doses once", doses === 3, String(doses));
  const otCharges = await prisma.charge.count({ where: { OR: [{ sourceType: "Surgery", sourceId: a.surgeryId }, { sourceType: "SurgeryItemUsage", sourceId: a.usageId }, { sourceType: "IcuAdmission" }], encounterId: a.encounterId } });
  const kitIssued = await prisma.stockLedgerEntry.count({ where: { sourceType: "SurgeryItemUsage", sourceId: a.usageId } });
  report("9 OT: charge-capture charged the procedure, the implant and the ICU admission once each; stock-movement issued the stent once", otCharges === 3 && kitIssued === 1, `${otCharges} charges, ${kitIssued} ledger`);
  const catalogueCharges = await prisma.charge.findMany({ where: { encounterId: a.encounterId, OR: [{ sourceType: "Surgery", sourceId: a.surgeryId }, { sourceType: "SurgeryItemUsage", sourceId: a.usageId }, { sourceType: "BloodIssue", sourceId: a.bloodIssueId }] } });
  const codes = catalogueCharges.map((c) => `${c.chargeCode}:${c.pricingStatus}`).sort().join();
  report("9/9b: the seeded catalogue's specific tariffs priced PTCA, the stent and the PRBC unit (no generic, nothing needing a price)",
    codes === [`BLOOD:PRBC:PRICED`, `ITEM:${implantSku("DES", a.facilityId)}:PRICED`, "PROCEDURE:PTCA:PRICED"].sort().join(), codes);

  // Week 4b: the rag-indexer kept the AI index in step with the journey (replay included: one document each).
  const ragResult = await prisma.ragDocument.count({ where: { sourceType: "LAB_RESULT", sourceId: a.resultId, status: "ACTIVE" } });
  const ragProvided = await prisma.ragDocument.count({ where: { personId: a.journeyPersonId, ownerType: "PERSON", sourceType: "PATIENT_PROVIDED_RECORD", status: "ACTIVE" } });
  const ragDischarge = await prisma.ragDocument.count({ where: { sourceType: "DISCHARGE_SUMMARY", patientId: a.patientId, status: "ACTIVE" } });
  const ragUnconfirmed = await prisma.ragChunk.count({ where: { personId: a.journeyPersonId, sourceType: "PATIENT_DOCUMENT", text: { contains: "1.42" } } });
  report("Week 4b: the rag-indexer indexed the journey: the released result, the four confirmed entries (patient-provided), the discharge summary; no unconfirmed value",
    ragResult === 1 && ragProvided === 4 && ragDischarge === 1 && ragUnconfirmed === 0, `${ragResult}/${ragProvided}/${ragDischarge}/${ragUnconfirmed}`);
  // …and "ask the AI about this patient": the treating doctor's chart question, answered from the
  // journey's record with the critical troponin cited (verified), the interaction logged, nothing written.
  const eventsBeforeAsk = await prisma.domainEventOutbox.count();
  const askResult = await askAi({ kind: "STAFF", userId: a.doctorUserId, role: "DOCTOR", facilityId: a.facilityId }, { mode: "CHART_QA", patientId: a.patientId, question: "What was the troponin result?" });
  const askRow = await prisma.aiInteraction.findUnique({ where: { id: askResult.meta.interactionId } });
  report("Week 4b: asking the AI about the journey's patient: answered, the troponin (2.1) cited from the released result, labelled verified; logged; no event, nothing written",
    askResult.outcome === "ANSWERED" && askResult.sentences.some((x) => x.text.includes("2.1") && x.labels.includes("verified")) && askResult.citations.some((c) => c.sourceType === "LAB_RESULT" && c.sourceId === a.resultId)
      && askRow?.outcome === "ANSWERED" && askRow.patientId === a.patientId && (await prisma.domainEventOutbox.count()) === eventsBeforeAsk,
    askResult.outcome);

  // Week 4c: the patient shares labs only with a visiting doctor by code; the visit brief cites only labs
  // (and allergies); the access is in the person's log; revoke-all, and the share reads nothing.
  {
    const owner = (await prisma.personAccount.findFirstOrThrow({ where: { personId: a.journeyPersonId, role: "OWNER" } })).userId;
    const visiting = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId: otherFacility }, user: { role: "DOCTOR" } }, select: { id: true, userId: true } });
    const issued = await issueAccessCode(a.patientId, owner, "core journey", { choice: parseShareChoice({ categories: ["LABS"] }) });
    const visit = await redeemAccessCode({ code: issued.code, doctorUserId: visiting.userId, doctorStaffId: visiting.id, doctorName: "Visiting doctor", facilityId: otherFacility });
    const visitingActor = { kind: "STAFF" as const, userId: visiting.userId, role: "DOCTOR" as const, facilityId: otherFacility };
    const brief = await askAi(visitingActor, { mode: "VISIT_BRIEF", patientId: a.patientId, shareId: visit!.id });
    report("Week 4c: a LABS-only code: the visiting doctor's visit brief cites the troponin, and only lab results and allergies",
      brief.outcome === "ANSWERED" && brief.citations.some((c) => c.sourceId === a.resultId) && brief.citations.every((c) => c.sourceType === "LAB_RESULT" || c.sourceType === "ALLERGY"),
      brief.citations.map((c) => c.sourceType).join(","));
    report("Week 4c: …the person's access log shows that doctor, by their code, on the AI",
      (await prisma.personAccessLogEntry.count({ where: { personId: a.journeyPersonId, kind: "RECORD_ACCESSED", actorUserId: visiting.userId, AND: [{ detail: { path: ["via"], equals: "SHARE_CODE" } }, { detail: { path: ["surface"], equals: "AI_ASK" } }] } })) === 1);
    await revokeAllAccess(owner, "REVOKE");
    const after = await askAi(visitingActor, { mode: "VISIT_BRIEF", patientId: a.patientId, shareId: visit!.id }).then(() => "answered", (e) => (e instanceof AskError ? String(e.status) : "error"));
    report("Week 4c: …after revoke-all, the share reads nothing (404)", after === "404", after);
  }

  // 4c fix (§15), the knee: a patient with a past knee diagnosis (verified, at the hospital) uploads an
  // MRI report and shares by code with the default choice (every non-sensitive category, uploads
  // included). A visiting doctor's visit brief cites both; the doctor opens the MRI through a signed URL.
  {
    const kRun = Date.now().toString(36);
    const k = await registerPatientAccount({ facilityId: a.facilityId, fullName: `Knee patient ${kRun}`, email: `cj-knee-${kRun}@verify.aarogya`, passwordHash: "x", sex: "M", dob: new Date("1970-07-07") });
    if (k.status !== "LINKED_NEW") throw new Error(`knee fixture: ${k.status}`);
    const kPerson = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: k.userId } })).personId;
    await prisma.person.update({ where: { id: kPerson }, data: { dataClassification: "SYNTHETIC", preferredLanguage: "en" } });
    const kPatient = (await prisma.personPatientLink.findFirstOrThrow({ where: { personId: kPerson, status: "ACTIVE" } })).patientId;
    const ortho = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId: a.facilityId }, user: { role: "DOCTOR" } }, select: { id: true } });
    const pastVisit = await prisma.encounter.create({ data: { patientId: kPatient, facilityId: a.facilityId, type: "OPD", status: "CLOSED", chiefComplaint: "Right knee pain", registeredAt: new Date("2025-03-10T09:00:00Z"), closedAt: new Date("2025-03-10T10:00:00Z") } });
    const kneeDx = await prisma.diagnosis.create({ data: { patientId: kPatient, encounterId: pastVisit.id, diagnosis: "Osteoarthritis of right knee", code: "M17.11", codeSystem: "ICD-10", type: "FINAL", diagnosedByStaffId: ortho.id, createdAt: new Date("2025-03-10T09:40:00Z") } });
    await indexSource({ sourceType: "DIAGNOSIS", sourceId: kneeDx.id });
    const mri = await uploadPersonDocument(k.userId, { bytes: await fixturePdf(fixtureById("lab-en-cbc")!), contentType: "application/pdf", originalName: "mri-knee.pdf", title: "MRI right knee report", type: "REPORT" });
    await drain();
    const issued = await issueAccessCode(kPatient, k.userId, "knee visit", { choice: parseShareChoice({}, { categories: DEFAULT_SHARE_CATEGORIES }) });
    const kShare = await prisma.recordShare.findUniqueOrThrow({ where: { id: issued.session.shareId! } });
    const visiting = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId: otherFacility }, user: { role: "DOCTOR" } }, select: { id: true, userId: true } });
    const visit = await redeemAccessCode({ code: issued.code, doctorUserId: visiting.userId, doctorStaffId: visiting.id, doctorName: "Visiting doctor", facilityId: otherFacility });
    const visitingActor = { kind: "STAFF" as const, userId: visiting.userId, role: "DOCTOR" as const, facilityId: otherFacility };
    report("4c fix (knee): the default share includes uploads and conditions, not clinical notes or anything sensitive",
      kShare.categories.includes("UPLOADS") && kShare.categories.includes("CONDITIONS") && !kShare.categories.includes("CLINICAL_NOTES") && kShare.sensitiveCategories.length === 0);
    const brief = await askAi(visitingActor, { mode: "VISIT_BRIEF", patientId: kPatient, shareId: visit!.id });
    const cites = (type: string, id: string) => brief.citations.some((c) => c.sourceType === type && c.sourceId === id);
    report("4c fix (knee): the visiting doctor's visit brief cites the past knee diagnosis (verified) and the uploaded MRI report (patient-provided)",
      brief.outcome === "ANSWERED" && cites("DIAGNOSIS", kneeDx.id) && cites("PATIENT_DOCUMENT", mri.id)
        && brief.sentences.some((x) => /knee/i.test(x.text) && x.labels.includes("verified")) && brief.sentences.some((x) => /MRI right knee/.test(x.text) && x.labels.includes("patient-provided")),
      brief.citations.map((c) => c.sourceType).join(","));
    const consult = (await viewSharedRecord({ userId: visiting.userId, facilityId: otherFacility, role: "DOCTOR" }, visit!.id, "CONSULT_VIEW")).history;
    report("4c fix (knee): the consult view shows the knee diagnosis under conditions and the MRI under uploads",
      !!consult.conditions?.diagnoses.some((d) => d.id === kneeDx.id) && !!consult.uploads?.documents.some((d) => d.id === mri.id));
    const opened = await personDocumentDownload({ kind: "SHARE", userId: visiting.userId, facilityId: otherFacility, role: "DOCTOR", shareRef: visit!.id }, mri.id);
    report("4c fix (knee): the doctor opens the MRI through a 5-minute signed URL, logged for the patient",
      !!opened.url && new Date(opened.expiresAt).getTime() - Date.now() <= 300_000
        && (await prisma.personAccessLogEntry.count({ where: { personId: kPerson, actorUserId: visiting.userId, AND: [{ detail: { path: ["surface"], equals: "DOCUMENT_DOWNLOAD" } }, { detail: { path: ["documentId"], equals: mri.id } }] } })) === 1);
    await drain();

    // Week 5a: the knee patient searches the directory by symptom, books a verified orthopaedist at the
    // other facility with a LABS + CONDITIONS share, the doctor's visit brief cites only what was shared,
    // then the patient cancels and the share ends.
    const v = await verifier();
    const admin = await facilityAdmin(otherFacility);
    const netOrtho = await networkDoctor(otherFacility, v, admin, { name: `Dr Journey Ortho ${kRun}`, specialties: ["ORTHOPAEDICS"] });
    await drain();
    const found = await searchDirectory({ symptom: "KNEE_PAIN" });
    report("5a: searching by knee pain finds the verified orthopaedist", found.results.some((r) => r.doctorId === netOrtho.doctorId));
    const next = (await prisma.doctorNextSlot.findUniqueOrThrow({ where: { practiceLocationId: netOrtho.locationId! } })).nextSlotAt!;
    const slot = (await locationSlots(netOrtho.locationId!, next))[0];
    const booked = await bookThroughDirectory(k.userId, { locationId: netOrtho.locationId, start: slot.start, reason: "Right knee pain", share: { categories: ["CONDITIONS"] } });
    await prisma.recordShare.update({ where: { id: booked.shareId! }, data: { validFrom: new Date(Date.now() - 60_000) } });
    const bookedAppt = await prisma.appointment.findUniqueOrThrow({ where: { id: booked.appointmentId } });
    const orthoBrief = await askAi({ kind: "STAFF", userId: netOrtho.userId, role: "DOCTOR", facilityId: otherFacility }, { mode: "VISIT_BRIEF", patientId: bookedAppt.patientId, shareId: booked.shareId! });
    report("5a: booked with a CONDITIONS share: the visit brief cites the knee diagnosis, and nothing outside conditions and allergies (no upload)",
      orthoBrief.outcome === "ANSWERED" && orthoBrief.citations.some((c) => c.sourceType === "DIAGNOSIS" && c.sourceId === kneeDx.id) && orthoBrief.citations.every((c) => ["DIAGNOSIS", "PROBLEM", "ALLERGY", "ALLERGY_STATUS"].includes(c.sourceType)),
      orthoBrief.citations.map((c) => c.sourceType).join(","));
    await cancelOwnDirectoryBooking(k.userId, booked.bookingId);
    await drain();
    const after5a = await askAi({ kind: "STAFF", userId: netOrtho.userId, role: "DOCTOR", facilityId: otherFacility }, { mode: "VISIT_BRIEF", patientId: bookedAppt.patientId, shareId: booked.shareId! }).then(() => "answered", (e) => (e instanceof AskError ? String(e.status) : "error"));
    directoryEventIds.push(...(await prisma.domainEventOutbox.findMany({ where: { OR: [{ aggregateId: { in: [booked.appointmentId, booked.bookingId, booked.shareId!] } }, { aggregateId: netOrtho.locationId! }] }, select: { eventId: true } })).map((e) => e.eventId));
    report("5a: the patient cancels: the share ends (APPOINTMENT_CANCELLED) and the brief is refused (404)",
      (await prisma.recordShare.findUniqueOrThrow({ where: { id: booked.shareId! } })).endedReason === "APPOINTMENT_CANCELLED" && after5a === "404", after5a);
  }

  // Every consumer took part in the journey (the directory booking included).
  const consumersSeen = new Set((await prisma.domainEventDelivery.findMany({ where: { eventId: { in: [...ids, ...directoryEventIds] }, status: "PROCESSED" }, select: { consumerName: true }, distinct: ["consumerName"] })).map((d) => d.consumerName));
  const missing = EXPECTED_CONSUMERS.filter((c) => !consumersSeen.has(c));
  report(`Every registered consumer (${EXPECTED_CONSUMERS.length}) processed journey events`, missing.length === 0, missing.join(",") || [...consumersSeen].sort().join(","));

  // 8c reorder, 9c waste, 15 identity (events not correlated by the encounter).
  const reorder = side.filter((e) => e.eventType === "StockBelowReorder");
  const reorderTasks = await prisma.task.count({ where: { facilityId: a.facilityId, type: "STOCK_REORDER", idempotencyKey: { startsWith: `STOCK_REORDER:${a.drugItemId}:` } } });
  report("8c The dispense crossed the drug's reorder point: StockBelowReorder once, one reorder task", reorder.length === 1 && (reorder[0].payload as { onHandQty: number }).onHandQty === 8 && reorderTasks === 1, `${reorder.length} events, ${reorderTasks} tasks`);
  const wasteDoc = side.filter((e) => e.eventType === "StockDocumentStatusChanged").map((e) => e.payload as { documentType: string; to: string });
  report("9c Waste on hold then rejected: stock fully restored (70 on hand, 0 held), WASTE REJECTED", a.wasteBalance === "70/0" && wasteDoc.length === 1 && wasteDoc[0].documentType === "WASTE" && wasteDoc[0].to === "REJECTED", a.wasteBalance);
  const ident = side.filter((e) => e.eventType === "ExternalIdentifierStatusChanged").map((e) => e.payload as { change: string; system: string });
  report("15 An ABHA number linked: ExternalIdentifierStatusChanged LINKED (ABHA_NUMBER), never the value", ident.length === 1 && ident[0].change === "LINKED" && ident[0].system === "ABHA_NUMBER" && !JSON.stringify(ident).includes("CJ-ABHA"));
  report("11 A billing hold refused finalize until it was cleared", a.billing.finalizeRefusedOnHold);

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
    await prisma.dischargeHold.count({ where: { discharge: { admission: { encounterId: a.encounterId } } } }),
    await prisma.task.count({ where: { facilityId: a.facilityId, type: "STOCK_REORDER", idempotencyKey: { startsWith: `STOCK_REORDER:${a.drugItemId}:` } } }),
    await prisma.stockLedgerEntry.count({ where: { itemId: a.drugItemId } }),
    await prisma.stockLedgerEntry.count({ where: { sourceType: "WasteRecord", sourceId: a.wasteId } }),
  ].join("/");
  const before = await counts();
  const admin = await prisma.user.findFirstOrThrow({ where: { role: "AAROGYA_ADMIN" }, orderBy: { id: "asc" } });
  const platform = await loadActorMemberships(admin.id, "AAROGYA_ADMIN");
  for (const id of ids) await replayEvent(platform, id, { reason: "core-journey replay gate" });
  await drain();
  const after = await counts();
  report("Replay: re-running every delivery creates nothing new (tasks/notifications/doses/charges/ledger/claims/holds/reorder tasks/drug ledger/waste ledger)", after === before, `${before} → ${after}`);
  const replayDead = await prisma.domainEventOutbox.count({ where: { eventId: { in: ids }, status: { not: "PROCESSED" } } });
  report("…and every replayed event is PROCESSED again", replayDead === 0, String(replayDead));

  // Tenancy: each journey's rows stay in its own facility.
  const leak = await Promise.all([
    prisma.task.count({ where: { encounterId: a.encounterId, facilityId: { not: a.facilityId } } }),
    prisma.task.count({ where: { encounterId: b.encounterId, facilityId: { not: b.facilityId } } }),
    prisma.notification.count({ where: { encounterId: a.encounterId, facilityId: { not: a.facilityId } } }),
    prisma.notification.count({ where: { encounterId: b.encounterId, facilityId: { not: b.facilityId } } }),
    prisma.domainEventOutbox.count({ where: { correlationId: b.encounterId, facilityId: { not: b.facilityId } } }),
    prisma.domainEventOutbox.count({ where: { correlationId: a.encounterId, facilityId: { not: a.facilityId } } }),
    prisma.charge.count({ where: { OR: [{ encounterId: a.encounterId, facilityId: { not: a.facilityId } }, { encounterId: b.encounterId, facilityId: { not: b.facilityId } }] } }),
    prisma.invoice.count({ where: { OR: [{ encounterId: a.encounterId, facilityId: { not: a.facilityId } }, { encounterId: b.encounterId, facilityId: { not: b.facilityId } }] } }),
    prisma.claim.count({ where: { invoice: { encounterId: a.encounterId }, facilityId: { not: a.facilityId } } }),
    prisma.stockLedgerEntry.count({ where: { OR: [{ encounterId: a.encounterId, facilityId: { not: a.facilityId } }, { encounterId: b.encounterId, facilityId: { not: b.facilityId } }] } }),
    prisma.dischargeHold.count({ where: { discharge: { admission: { encounterId: a.encounterId } }, facilityId: { not: a.facilityId } } }),
  ]);
  report("Tenancy: zero cross-facility rows for either journey (tasks, notifications, events, charges, invoices, claims, stock, holds)", leak.every((n) => n === 0), leak.join(","));
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
