/**
 * Batch 7, item 5: every route-level write moved into a service; the route
 * allowlist is empty. This gate covers what the move changed or fixed.
 *
 *   1. Lot expiry sweep: each lapsed lot EXPIRED with StockLotStatusChanged v2
 *      (EXPIRY); a second sweep does nothing.
 *   2. Staff patient edits: PatientDemographicsUpdated v2 names the changed
 *      fields (FULL_NAME, BLOOD_GROUP, DECEASED, …) and an added emergency
 *      contact, never the values.
 *   3. Foreign references refused: another facility's bed for an encounter
 *      location, another facility's staff member as attending.
 *   4. A patient cancels an unredeemed access code: CANCELLED, no event.
 *   5. Scholar: two concurrent submissions of one attempt are scored once and
 *      add XP once; an action after submission is refused.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-route-services.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { expireLapsedLots } from "../src/lib/hospital/inventory/lots";
import { updatePatientRecord, addEmergencyContact } from "../src/lib/patient/demographics";
import { assignEncounterLocation, updateEncounterDetails } from "../src/lib/hospital/encounterRecords";
import { issueAccessCode, endOwnAccessSession } from "../src/lib/patient/accessSession";
import { openCaseAttempt, submitCaseAttempt, recordCaseAction } from "../src/lib/student/cases";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
type Payload = Record<string, unknown>;
const rejects = <T>(p: Promise<T>) => p.then(() => false, () => true);

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const noidaDoctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere("fac-amc-noida"), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const by = doctor.userId;

  // 1. Lot expiry.
  const item = await prisma.item.create({ data: { facilityId, sku: `RS-${run}`, name: `Route services ${run}`, category: "CONSUMABLE", baseUnit: "PIECE" } });
  const lapsed = await prisma.itemLot.create({ data: { itemId: item.id, facilityId, lotNumber: `RS-OLD-${run}`, status: "ACTIVE", expiresAt: new Date(Date.now() - 86_400_000) } });
  const fresh = await prisma.itemLot.create({ data: { itemId: item.id, facilityId, lotNumber: `RS-NEW-${run}`, status: "ACTIVE", expiresAt: new Date(Date.now() + 86_400_000) } });
  await expireLapsedLots(facilityId, by);
  const ev = await prisma.domainEventOutbox.findMany({ where: { eventType: "StockLotStatusChanged", aggregateId: lapsed.id } });
  report("The expiry sweep expires a lapsed lot with StockLotStatusChanged v2 (EXPIRY), not a fresh one",
    (await prisma.itemLot.findUniqueOrThrow({ where: { id: lapsed.id } })).status === "EXPIRED" && (await prisma.itemLot.findUniqueOrThrow({ where: { id: fresh.id } })).status === "ACTIVE"
      && ev.length === 1 && ev[0].eventVersion === 2 && (ev[0].payload as Payload).cause === "EXPIRY");
  await expireLapsedLots(facilityId, by);
  report("…a second sweep emits nothing more for it", (await prisma.domainEventOutbox.count({ where: { eventType: "StockLotStatusChanged", aggregateId: lapsed.id } })) === 1);

  // 2. Staff patient edits.
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Route Services ${run}`, sex: "M", ageYears: 50 });
  await updatePatientRecord({ patientId: patient.id, facilityId, byUserId: by, changes: { fullName: `Renamed secret ${run}`, bloodGroup: "B+", language: patient.language ?? undefined } });
  await updatePatientRecord({ patientId: patient.id, facilityId, byUserId: by, changes: { deceasedAt: new Date() } });
  await addEmergencyContact({ patientId: patient.id, facilityId, name: `Contact secret ${run}`, relation: "spouse", phone: "9000000000", byUserId: by });
  const demo = (await prisma.domainEventOutbox.findMany({ where: { eventType: "PatientDemographicsUpdated", aggregateId: patient.id }, orderBy: { seq: "asc" } })).map((e) => e.payload as Payload);
  report("Staff edits: PROFILE [FULL_NAME, BLOOD_GROUP] (an unchanged field is not listed), PROFILE [DECEASED], EMERGENCY_CONTACT_ADDED; never the values",
    demo.map((p) => `${p.changeKind}:${((p.fields as string[] | undefined) ?? []).join("+")}`).join() === "PROFILE:FULL_NAME+BLOOD_GROUP,PROFILE:DECEASED,EMERGENCY_CONTACT_ADDED:"
      && !JSON.stringify(demo).includes("secret"), demo.map((p) => `${p.changeKind}:${((p.fields as string[] | undefined) ?? []).join("+")}`).join());

  // 3. Foreign references.
  const enc = await openEncounter({ facilityId, patientId: patient.id, type: "OPD", chiefComplaint: "Route services", byUserId: by });
  const noidaBed = await prisma.bed.findFirstOrThrow({ where: { facilityId: "fac-amc-noida" }, orderBy: { id: "asc" } });
  report("An encounter location naming another facility's bed is refused", await rejects(assignEncounterLocation({ encounterId: enc.id, facilityId, bedId: noidaBed.id })));
  report("…as is another facility's staff member as attending", await rejects(updateEncounterDetails({ encounterId: enc.id, facilityId, attendingStaffId: noidaDoctor.id })));
  await updateEncounterDetails({ encounterId: enc.id, facilityId, attendingStaffId: doctor.id, triageLevel: 3 });
  report("…while this facility's are accepted", (await prisma.encounter.findUniqueOrThrow({ where: { id: enc.id } })).attendingStaffId === doctor.id);

  // 4. Cancel an unredeemed code.
  const portalUser = await prisma.user.create({ data: { email: `rs-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "RS" } });
  const code = await issueAccessCode(patient.id, portalUser.id, "visit");
  const cancelled = await endOwnAccessSession(code.session.id, patient.id, portalUser.id);
  report("A patient cancels an unredeemed code: CANCELLED, no event (no access occurred)",
    cancelled?.status === "CANCELLED" && (await prisma.domainEventOutbox.count({ where: { eventType: "PatientAccessSessionStatusChanged", aggregateId: code.session.id } })) === 0);
  report("…another patient's session is not theirs to end", (await endOwnAccessSession(code.session.id, "someone-else", portalUser.id)) === null);

  // 5. Scholar submission race.
  const student = await prisma.user.findFirstOrThrow({ where: { email: "student@demo.aarogya" }, include: { studentProfile: true } });
  const kase = await prisma.clinicalCase.findFirstOrThrow({ orderBy: { id: "asc" } });
  const { attempt } = await openCaseAttempt({ caseId: kase.id, studentId: student.id, mode: "PRACTICE", restart: true });
  const xpBefore = student.studentProfile!.clinicalXp;
  const results = await Promise.allSettled([1, 2].map(() => submitCaseAttempt({ attemptId: attempt.id, studentId: student.id, score: { total: 10 }, xpGain: 40, consecutiveDay: false })));
  const xpAfter = (await prisma.studentProfile.findUniqueOrThrow({ where: { userId: student.id } })).clinicalXp;
  report("Two concurrent submissions: one wins, XP added once", results.filter((r) => r.status === "fulfilled").length === 1 && xpAfter - xpBefore === 40, `+${xpAfter - xpBefore}`);
  report("An action after submission is refused",
    await rejects(recordCaseAction({ attemptId: attempt.id, data: { hintsUsed: 1 }, action: { stage: "TRIAGE", type: "hint", payload: {} } })));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
