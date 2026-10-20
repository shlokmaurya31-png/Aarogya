/**
 * Workflow spine §9 step 8: operating theatre and blood bank events, and the
 * charge-capture and stock-movement consumers (new charges only, §5.2).
 *
 *   1. OT: SurgeryRequested, SurgeryStatusChanged (review, approve, recovery
 *      phase, schedule cancelled), SurgeryScheduled, ProcedureStarted,
 *      PerioperativeRecordRecorded (anesthesia, checklist), SurgeryItemUsed,
 *      ProcedureCompleted (with its duration), SpecimenCollected (SURGICAL).
 *   2. stock-movement: a usage with a location is issued once (ledger keyed
 *      by the usage), redelivery issues nothing more; a usage the stock can't
 *      cover stays recorded, dead-letters and raises one inventory exception.
 *   3. charge-capture: the procedure, the consumable, the blood component and
 *      the ICU admission are each charged once ("needs pricing" at 0 when
 *      there is no tariff); an OPD consultation is charged where tariffed; an
 *      ED triage without a tariff is not; redelivery charges nothing more; a
 *      charge for an already-invoiced encounter dead-letters.
 *   4. Blood: BloodUnitStatusChanged for every unit move (from the real
 *      state), BloodRequestStatusChanged, BloodCompatibilityRecorded (typing,
 *      verified crossmatch), EmergencyBloodReleaseAuthorized, BloodIssued,
 *      TransfusionStarted, ObservationRecorded (TRANSFUSION),
 *      TransfusionStatusChanged, TransfusionReactionReported and
 *      TransfusionReactionStatusChanged (both SENSITIVE, no symptoms).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-ot-blood-events.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import {
  createOperatingTheatre, createProcedure, requestSurgery, transitionSurgery, scheduleSurgery, cancelSchedule, startProcedure,
  completeProcedure, recordItemUsage, recordAnesthesia, ensureChecklist, updateChecklistItem, collectSpecimen, updateRecovery,
} from "../src/lib/hospital/surgery";
import {
  createBloodProduct, registerBloodUnit, releaseUnit, recordPatientTyping, requestBlood, transitionRequest, recordCompatibility,
  verifyCompatibility, authorizeEmergencyRelease, issueUnit, startTransfusion, recordTransfusionObservation, transitionTransfusion,
  reportReaction, transitionReaction,
} from "../src/lib/hospital/blood";
import { admitToIcu } from "../src/lib/hospital/icu";
import { recordTriage } from "../src/lib/hospital/triage";
import { registerEdArrival } from "../src/lib/hospital/emergency";
import { createAdjustment } from "../src/lib/hospital/inventory/adjustment";
import { getEventContract } from "../src/lib/events/catalogue";
import { runTick } from "../src/lib/runner/tick";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const drain = async () => { for (let i = 0; i < 5; i++) if (!(await runTick({ budgetMs: 20_000 })).moreWork) break; };

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const by = doctor.userId;
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `OT Blood ${run}`, sex: "F", ageYears: 52 });
  const enc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Elective surgery", byUserId: by });
  const payloads = async (aggregateId: string, type: string) =>
    (await prisma.domainEventOutbox.findMany({ where: { aggregateId, eventType: type }, orderBy: { seq: "asc" }, select: { payload: true } })).map((e) => e.payload as Record<string, unknown>);
  const chargesFor = (sourceType: string, sourceId: string) => prisma.charge.findMany({ where: { sourceType, sourceId } });

  // ── 1. OT ─────────────────────────────────────────────────────────────────
  const proc = await createProcedure({ facilityId, code: `CHOLE-${run}`, name: "Cholecystectomy", byUserId: by });
  const ot = await createOperatingTheatre({ facilityId, name: `OT ${run}`, byUserId: by });
  const surgery = await requestSurgery({ facilityId, patientId: patient.id, encounterId: enc.id, procedureId: proc.id, urgency: "URGENT", requestedByStaffId: doctor.id, byUserId: by });
  await transitionSurgery({ surgeryId: surgery.id, facilityId, to: "REVIEWED", actorStaffId: doctor.id, byUserId: by });
  await transitionSurgery({ surgeryId: surgery.id, facilityId, to: "APPROVED", actorStaffId: doctor.id, byUserId: by });
  const start = new Date(Date.now() + 86_400_000 + Math.floor(Math.random() * 3_600_000) * 24);
  await scheduleSurgery({ surgeryId: surgery.id, facilityId, operatingTheatreId: ot.id, startAt: start, endAt: new Date(start.getTime() + 3_600_000), schedulerStaffId: doctor.id, byUserId: by });
  await cancelSchedule({ surgeryId: surgery.id, facilityId, byUserId: by });
  await scheduleSurgery({ surgeryId: surgery.id, facilityId, operatingTheatreId: ot.id, startAt: start, endAt: new Date(start.getTime() + 3_600_000), schedulerStaffId: doctor.id, byUserId: by });
  const requested = (await payloads(surgery.id, "SurgeryRequested"))[0];
  report("SurgeryRequested with the urgency and procedure", requested?.urgency === "URGENT" && requested.procedureId === proc.id);
  const changes = await payloads(surgery.id, "SurgeryStatusChanged");
  report("SurgeryStatusChanged: review, approve, then the slot cancelled (the case stays SCHEDULED)",
    changes.map((c) => `${c.change}:${c.from}>${c.to}`).join() === "STATUS:REQUESTED>REVIEWED,STATUS:REVIEWED>APPROVED,SCHEDULE_CANCELLED:SCHEDULED>SCHEDULED");
  report("SurgeryScheduled each time a slot is booked", (await payloads(surgery.id, "SurgeryScheduled")).length === 2);
  await recordAnesthesia({ surgeryId: surgery.id, facilityId, type: "GENERAL", anesthetistStaffId: doctor.id, status: "IN_PROGRESS", intraOpNotes: `secret note ${run}`, byUserId: by });
  await ensureChecklist(surgery.id, facilityId);
  await updateChecklistItem({ surgeryId: surgery.id, facilityId, itemKey: "identity", checked: true, checkedByStaffId: doctor.id, byUserId: by });
  const periop = await payloads(surgery.id, "PerioperativeRecordRecorded");
  report("PerioperativeRecordRecorded: anesthesia (status only) and a checklist item (phase, checked)",
    periop.map((p) => `${p.kind}:${p.anesthesiaStatus ?? p.checklistPhase}`).join() === "ANESTHESIA:IN_PROGRESS,SAFETY_CHECKLIST:BEFORE_INDUCTION" && !JSON.stringify(periop).includes("secret"));
  await startProcedure({ surgeryId: surgery.id, facilityId, surgeonStaffId: doctor.id, byUserId: by });
  report("ProcedureStarted", (await payloads(surgery.id, "ProcedureStarted")).length === 1);

  const pharmacy = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId, name: "Central Pharmacy" } });
  const item = await prisma.item.create({ data: { facilityId, sku: `MESH-${run}`, name: `Mesh ${run}`, category: "CONSUMABLE", baseUnit: "PIECE" } });
  const lot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId, lotNumber: `MESH-LOT-${run}`, status: "ACTIVE", expiresAt: new Date("2030-01-01") } });
  await prisma.$transaction((tx) => createAdjustment(tx, { facilityId, itemId: item.id, lotId: lot.id, locationId: pharmacy.id, quantityDelta: 2, reason: "FOUND", requestedByStaffId: doctor.id, actorUserId: by, idempotencyKey: `mesh-${run}` }));
  const recordUse = (qty: number) => recordItemUsage({ surgeryId: surgery.id, facilityId, usageType: "CONSUMABLE", itemId: item.id, itemLotId: lot.id, quantity: qty, locationId: pharmacy.id, recordedByStaffId: doctor.id, actorUserId: by, byUserId: by });
  const u1 = await recordUse(2);
  const u2 = await recordUse(1); // the lot holds only 2
  await completeProcedure({ surgeryId: surgery.id, facilityId, recoveryDestination: "PACU", operativeFindings: `findings ${run}`, byUserId: by });
  const completed = (await payloads(surgery.id, "ProcedureCompleted"))[0];
  report("ProcedureCompleted with its duration, no findings", typeof completed?.durationMinutes === "number" && completed.procedureId === proc.id && !JSON.stringify(completed).includes("findings"));
  report("SurgeryItemUsed for each usage, naming the issuing location", (await payloads(surgery.id, "SurgeryItemUsed")).map((p) => p.locationId).join() === `${pharmacy.id},${pharmacy.id}`);
  await updateRecovery({ surgeryId: surgery.id, facilityId, status: "IN_RECOVERY", byUserId: by });
  const rec = (await payloads(surgery.id, "SurgeryStatusChanged")).filter((c) => c.change === "RECOVERY");
  report("…and the recovery phase as SurgeryStatusChanged (RECOVERY, PENDING → IN_RECOVERY)", rec.map((c) => `${c.from}>${c.to}`).join() === "PENDING>IN_RECOVERY");
  const spec = await collectSpecimen({ surgeryId: surgery.id, facilityId, specimenType: "Gallbladder", collectedByStaffId: doctor.id, byUserId: by });
  report("A surgical specimen → SpecimenCollected (SURGICAL)", (await payloads(spec.id, "SpecimenCollected"))[0]?.specimenSource === "SURGICAL");
  await drain();

  // ── 2. stock-movement ─────────────────────────────────────────────────────
  const [usage1, usage2] = [await prisma.surgeryItemUsage.findUniqueOrThrow({ where: { id: u1.id } }), await prisma.surgeryItemUsage.findUniqueOrThrow({ where: { id: u2.id } })];
  const ledger = () => prisma.stockLedgerEntry.count({ where: { sourceType: "SurgeryItemUsage", sourceId: { in: [u1.id, u2.id] } } });
  const balance = await prisma.stockBalance.findFirst({ where: { itemId: item.id, lotId: lot.id, locationId: pharmacy.id } });
  report("stock-movement issues the covered usage once (on-hand 0)", usage1.stockConsumed && (await ledger()) === 1 && balance?.onHandQty === 0);
  const ex = await prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `INVENTORY_EXCEPTION:${u2.id}` } } });
  const u2Event = await prisma.domainEventOutbox.findFirstOrThrow({ where: { eventType: "SurgeryItemUsed", payload: { path: ["usageId"], equals: u2.id } } });
  const u2Delivery = await prisma.domainEventDelivery.findUnique({ where: { eventId_consumerName: { eventId: u2Event.eventId, consumerName: "stock-movement" } } });
  report("…the uncovered usage stays recorded, dead-letters (STOCK_UNAVAILABLE) and raises one inventory exception",
    !usage2.stockConsumed && u2Delivery?.status === "DEAD_LETTER" && u2Delivery.lastErrorCode === "STOCK_UNAVAILABLE" && ex?.status === "OPEN");

  // ── 3. charge-capture ─────────────────────────────────────────────────────
  const procCharges = await chargesFor("Surgery", surgery.id);
  report("The procedure is charged once, at the seeded PROCEDURE:GENERIC tariff",
    procCharges.length === 1 && procCharges[0].chargeCode === "PROCEDURE:GENERIC" && procCharges[0].netAmountMinor > 0 && procCharges[0].pricingStatus === "PRICED" && procCharges[0].category === "PROCEDURE");
  const meshCharge = (await chargesFor("SurgeryItemUsage", u1.id))[0];
  report("…an item with no tariff (not seeded) is charged as NEEDS_PRICING at 0",
    meshCharge?.pricingStatus === "NEEDS_PRICING" && meshCharge.netAmountMinor === 0 && meshCharge.description.includes("needs pricing"));
  report("…each consumable usage is charged once (even the one stock could not cover: it was used)",
    (await chargesFor("SurgeryItemUsage", u1.id)).length === 1 && (await chargesFor("SurgeryItemUsage", u2.id)).length === 1);
  const icuWard = await prisma.ward.create({ data: { facilityId, name: `OTB ICU ${run}`, wardType: "ICU" } });
  const icuBed = await prisma.bed.create({ data: { facilityId, wardId: icuWard.id, label: `OTB-I-${run}`, icuCapable: true } });
  const icuEnc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Post-op ICU", byUserId: by });
  const icuAdm = await admitToIcu({ encounterId: icuEnc.id, bedId: icuBed.id, facilityId, admittingStaffId: doctor.id, reason: "post-op", byUserId: by });
  const opd = await openEncounter({ facilityId, patientId: patient.id, type: "OPD", chiefComplaint: "Review", byUserId: by });
  const ed = await registerEdArrival({ facilityId, patientId: patient.id, chiefComplaint: "Fall", byUserId: by });
  const triage = await recordTriage({ encounterId: ed.id, recordedByStaffId: doctor.id, acuity: 3, byUserId: by });
  await drain();
  report("The ICU admission is charged once", (await chargesFor("IcuAdmission", (icuAdm as { id: string }).id)).length === 1);
  const consult = await chargesFor("Encounter", opd.id);
  report("An OPD consultation is charged where tariffed (CONSULT_OPD)", consult.length === 1 && consult[0].chargeCode === "CONSULT_OPD" && consult[0].netAmountMinor > 0);
  report("An ED triage with no tariff is not charged (only where tariffed)", (await chargesFor("TriageAssessment", (triage as { id: string }).id)).length === 0);

  // ── 4. Blood ──────────────────────────────────────────────────────────────
  const product = await createBloodProduct({ facilityId, code: `PRBC-${run}`, name: "Packed red cells", componentType: "PRBC", byUserId: by });
  const unit = await registerBloodUnit({ facilityId, productId: product.id, unitNumber: `U-${run}`, expiresAt: new Date(Date.now() + 20 * 86_400_000), registeredByStaffId: doctor.id, byUserId: by });
  await releaseUnit({ unitId: unit.id, facilityId, byUserId: by });
  const typing = await recordPatientTyping({ facilityId, patientId: patient.id, encounterId: enc.id, aboGroup: "O", rhStatus: "POSITIVE", performedByStaffId: doctor.id, byUserId: by });
  const breq = await requestBlood({ facilityId, patientId: patient.id, encounterId: enc.id, productId: product.id, priority: "URGENT", requestedByStaffId: doctor.id, byUserId: by });
  await transitionRequest({ requestId: breq.id, facilityId, to: "REVIEWED", actorStaffId: doctor.id, byUserId: by });
  await transitionRequest({ requestId: breq.id, facilityId, to: "APPROVED", actorStaffId: doctor.id, byUserId: by });
  const test = await recordCompatibility({ requestId: breq.id, facilityId, unitId: unit.id, status: "COMPATIBLE", testedByStaffId: doctor.id, byUserId: by });
  await verifyCompatibility({ testId: test.id, facilityId, verifiedByStaffId: doctor.id, byUserId: by });
  await authorizeEmergencyRelease({ requestId: breq.id, facilityId, reason: "bleeding", authorizedByStaffId: doctor.id, byUserId: by });
  const issue = await issueUnit({ requestId: breq.id, facilityId, unitId: unit.id, compatibilityTestId: test.id, issuedByStaffId: doctor.id, byUserId: by });
  const tf = await startTransfusion({ requestId: breq.id, facilityId, unitId: unit.id, administeredByStaffId: doctor.id, patientIdentityVerified: true, unitIdentityVerified: true, productVerified: true, bloodGroupReviewed: true, compatibilityReviewed: true, expiryReviewed: true, byUserId: by });
  const obs = await recordTransfusionObservation({ transfusionId: tf.id, facilityId, observationType: "TEMP", value: "38.9", recordedByStaffId: doctor.id, byUserId: by });
  const reaction = await reportReaction({ transfusionId: tf.id, facilityId, reportedByStaffId: doctor.id, symptoms: `rigors ${run}`, byUserId: by });
  await transitionReaction({ reactionId: reaction.id, facilityId, to: "UNDER_REVIEW", actorStaffId: doctor.id, byUserId: by });
  await transitionTransfusion({ transfusionId: tf.id, facilityId, to: "STOPPED", reason: "reaction", byUserId: by });

  const unitMoves = (await payloads(unit.id, "BloodUnitStatusChanged")).map((p) => `${p.from}>${p.to}`).join();
  report("BloodUnitStatusChanged follows the unit from its real state: registered, released, issued, transfusing, quarantined on the reaction",
    unitMoves === "null>QUARANTINED,QUARANTINED>AVAILABLE,AVAILABLE>ISSUED,ISSUED>TRANSFUSING,TRANSFUSING>QUARANTINED", unitMoves);
  report("BloodRequestStatusChanged: requested, reviewed, approved, issued",
    (await payloads(breq.id, "BloodRequestStatusChanged")).map((p) => `${p.from}>${p.to}`).join() === "null>REQUESTED,REQUESTED>REVIEWED,REVIEWED>APPROVED,APPROVED>ISSUED");
  report("BloodCompatibilityRecorded: the patient's typing (no group) and the verified crossmatch (COMPATIBLE)",
    (await payloads(typing.id, "BloodCompatibilityRecorded"))[0]?.kind === "PATIENT_TYPING" && !JSON.stringify(await payloads(typing.id, "BloodCompatibilityRecorded")).includes("POSITIVE")
      && (await payloads(test.id, "BloodCompatibilityRecorded"))[0]?.result === "COMPATIBLE");
  report("EmergencyBloodReleaseAuthorized", (await payloads(breq.id, "EmergencyBloodReleaseAuthorized")).length === 1);
  report("BloodIssued and TransfusionStarted", (await payloads(issue.id, "BloodIssued"))[0]?.productId === product.id && (await payloads(tf.id, "TransfusionStarted")).length === 1);
  report("ObservationRecorded TRANSFUSION, without the value", (await payloads(obs.id, "ObservationRecorded"))[0]?.observationKind === "TRANSFUSION" && !JSON.stringify(await payloads(obs.id, "ObservationRecorded")).includes("38.9"));
  const tfEvents = await prisma.domainEventOutbox.findMany({ where: { aggregateId: tf.id }, orderBy: { seq: "asc" }, select: { eventType: true, eventVersion: true, payload: true } });
  report("On the transfusion's aggregate, in order: started, reaction reported, under review, stopped",
    tfEvents.map((e) => e.eventType).join() === "TransfusionStarted,TransfusionReactionReported,TransfusionReactionStatusChanged,TransfusionStatusChanged");
  report("Reaction events are SENSITIVE and carry no symptoms",
    tfEvents.filter((e) => e.eventType.startsWith("TransfusionReaction")).every((e) => getEventContract(e.eventType, e.eventVersion)?.sensitivity === "SENSITIVE" && !JSON.stringify(e.payload).includes("rigors")));
  await drain();
  report("The issued blood component is charged once", (await chargesFor("BloodIssue", issue.id)).length === 1);

  // ── Redelivery, and an already-invoiced encounter ──────────────────────────
  const consumerEvents = await prisma.domainEventOutbox.findMany({ where: { eventType: { in: ["ProcedureCompleted", "SurgeryItemUsed", "BloodIssued", "IcuAdmitted", "EncounterOpened"] }, correlationId: { in: [enc.id, icuEnc.id, opd.id] } }, select: { eventId: true } });
  const ids = consumerEvents.map((e) => e.eventId);
  const counts = async () => `${await prisma.charge.count({ where: { encounterId: { in: [enc.id, icuEnc.id, opd.id] } } })}/${await ledger()}`;
  const before = await counts();
  await prisma.domainEventDelivery.updateMany({ where: { eventId: { in: ids }, consumerName: { in: ["charge-capture", "stock-movement"] }, status: "PROCESSED" }, data: { status: "PENDING" } });
  await prisma.domainEventOutbox.updateMany({ where: { eventId: { in: ids }, status: "PROCESSED" }, data: { status: "PENDING", processedAt: null } });
  await drain();
  report("Redelivering charges and stock events changes nothing (charges/ledger)", (await counts()) === before, `${before} → ${await counts()}`);

  // An already-invoiced encounter: the charge is recorded late (batch 5, decision 2; it used to dead-letter).
  const late = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Invoiced", byUserId: by });
  const acct = await prisma.billingAccount.create({ data: { facilityId, patientId: patient.id, encounterId: late.id } });
  await prisma.invoice.create({ data: { facilityId, billingAccountId: acct.id, encounterId: late.id, patientId: patient.id, status: "ISSUED", generatedByUserId: by } });
  const lateSurgery = await requestSurgery({ facilityId, patientId: patient.id, encounterId: late.id, procedureName: "Late", requestedByStaffId: doctor.id, byUserId: by });
  await transitionSurgery({ surgeryId: lateSurgery.id, facilityId, to: "REVIEWED", actorStaffId: doctor.id, byUserId: by });
  await transitionSurgery({ surgeryId: lateSurgery.id, facilityId, to: "APPROVED", actorStaffId: doctor.id, byUserId: by });
  const s2 = new Date(start.getTime() + 7 * 86_400_000);
  await scheduleSurgery({ surgeryId: lateSurgery.id, facilityId, operatingTheatreId: ot.id, startAt: s2, endAt: new Date(s2.getTime() + 3_600_000), schedulerStaffId: doctor.id, byUserId: by });
  await startProcedure({ surgeryId: lateSurgery.id, facilityId, byUserId: by });
  await completeProcedure({ surgeryId: lateSurgery.id, facilityId, byUserId: by });
  await drain();
  const lateCharges = await chargesFor("Surgery", lateSurgery.id);
  report("A charge for an already-invoiced encounter is recorded once, marked late (no dead letter)", lateCharges.length === 1 && lateCharges[0].isLate);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
