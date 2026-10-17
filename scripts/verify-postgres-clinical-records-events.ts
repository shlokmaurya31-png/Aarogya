/**
 * Batch 7, item 1: the clinical writes that lived in routes now go through
 * services that emit in the same transaction, with IDs and codes only.
 *
 *   1. Vitals → ObservationRecorded v2 (VITALS; abnormal flag from the
 *      facility's thresholds, never the values).
 *   2. Intake and output → ObservationRecorded v2 (INTAKE, OUTPUT; never the
 *      volume or notes).
 *   3. Diagnoses → DiagnosisRecorded (ADDED, UPDATED, RESOLVED; never the text
 *      or the code); a resolved diagnosis can't be changed.
 *   4. Allergies → AllergyListUpdated (ADDED, UPDATED, INACTIVATED; never the
 *      substance or reaction).
 *   5. Referrals → ReferralStatusChanged (PLACED, then each response); a final
 *      outcome (completed, cancelled, rejected) can't be changed, so two
 *      responders racing to close it: exactly one wins.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-clinical-records-events.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { recordVitals, recordIntakeOutput, recordDiagnosis, updateDiagnosis, recordAllergy, updateAllergy } from "../src/lib/hospital/clinicalRecords";
import { createReferral, respondToReferral } from "../src/lib/hospital/referral";
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
  const by = doctor.userId;
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Clinical Records ${run}`, sex: "F", ageYears: 45 });
  const enc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Records", byUserId: by });
  const events = async (type: string, aggregateId: string) => (await prisma.domainEventOutbox.findMany({ where: { eventType: type, aggregateId }, orderBy: { seq: "asc" } }));
  const payloads = async (type: string, aggregateId: string) => (await events(type, aggregateId)).map((e) => e.payload as Payload);
  const all: Payload[] = [];

  // 1. Vitals (a threshold for HR > 120 makes 150 abnormal).
  const key = { facilityId_metric: { facilityId, metric: "hr" } };
  const previous = await prisma.vitalThreshold.findUnique({ where: key });
  await prisma.vitalThreshold.upsert({ where: key, create: { facilityId, metric: "hr", maxValue: 120 }, update: { minValue: null, maxValue: 120 } });
  const normal = await recordVitals({ encounterId: enc.id, facilityId, staffId: doctor.id, vitals: { hr: 80, sbp: 120, dbp: 80, spo2: 98 }, byUserId: by });
  const high = await recordVitals({ encounterId: enc.id, facilityId, staffId: doctor.id, vitals: { hr: 150 }, byUserId: by });
  const vN = await events("ObservationRecorded", normal.vital.id);
  const vH = await payloads("ObservationRecorded", high.vital.id);
  all.push(...vN.map((e) => e.payload as Payload), ...vH);
  report("Vitals → ObservationRecorded v2 (VITALS), correlated by the encounter, no values",
    vN.length === 1 && vN[0].eventVersion === 2 && (vN[0].payload as Payload).observationKind === "VITALS" && (vN[0].payload as Payload).abnormal === false
      && vN[0].correlationId === enc.id && !JSON.stringify(vN[0].payload).includes("98"));
  report("…an abnormal set carries abnormal: true (facility threshold), never which value or the value",
    vH[0]?.abnormal === true && high.abnormal.length === 1 && !JSON.stringify(vH[0]).includes("150") && !JSON.stringify(vH[0]).includes("hr"), JSON.stringify(vH[0]));
  if (previous) await prisma.vitalThreshold.update({ where: key, data: { minValue: previous.minValue, maxValue: previous.maxValue } });
  else await prisma.vitalThreshold.delete({ where: key });

  // 2. Intake and output.
  const intake = await recordIntakeOutput({ encounterId: enc.id, facilityId, staffId: doctor.id, ioType: "INPUT", category: "IV", quantityMl: 500, notes: `secret ${run}`, byUserId: by });
  const output = await recordIntakeOutput({ encounterId: enc.id, facilityId, staffId: doctor.id, ioType: "OUTPUT", category: "URINE", quantityMl: 350, byUserId: by });
  const io = [...await payloads("ObservationRecorded", intake.id), ...await payloads("ObservationRecorded", output.id)];
  all.push(...io);
  report("Intake and output → ObservationRecorded INTAKE and OUTPUT, never the volume or notes",
    io.map((p) => p.observationKind).join() === "INTAKE,OUTPUT" && !JSON.stringify(io).includes("500") && !JSON.stringify(io).includes("secret"));

  // 3. Diagnoses.
  const dx = await recordDiagnosis({ encounterId: enc.id, facilityId, staffId: doctor.id, diagnosis: `Secret diagnosis ${run}`, type: "PROVISIONAL", codeSystem: "ICD-10", code: "I21.4", codeDisplay: "NSTEMI", byUserId: by });
  await updateDiagnosis({ diagnosisId: dx.id, facilityId, type: "FINAL", byUserId: by });
  await updateDiagnosis({ diagnosisId: dx.id, facilityId, status: "RESOLVED", byUserId: by });
  const dxE = await payloads("DiagnosisRecorded", dx.id);
  all.push(...dxE);
  report("Diagnosis: ADDED (PROVISIONAL, coded) → UPDATED (FINAL) → RESOLVED; never the text or the code",
    dxE.map((p) => `${p.action}:${p.diagnosisType}:${p.status}`).join() === "ADDED:PROVISIONAL:ACTIVE,UPDATED:FINAL:ACTIVE,RESOLVED:FINAL:RESOLVED"
      && dxE[0].coded === true && !JSON.stringify(dxE).includes("I21") && !JSON.stringify(dxE).includes("Secret"), dxE.map((p) => `${p.action}:${p.diagnosisType}:${p.status}`).join());
  report("…a resolved diagnosis can't be changed, and an unknown type is refused",
    await rejects(updateDiagnosis({ diagnosisId: dx.id, facilityId, type: "PRIMARY", byUserId: by }))
      && await rejects(recordDiagnosis({ encounterId: enc.id, facilityId, staffId: doctor.id, diagnosis: "x", type: "GUESS", byUserId: by })));

  // 4. Allergies.
  const allergy = await recordAllergy({ patientId: patient.id, facilityId, substance: `Secretcillin ${run}`, reaction: "rash", severity: "moderate", byUserId: by });
  await updateAllergy({ allergyId: allergy.id, facilityId, verification: "CONFIRMED", criticality: "HIGH", byUserId: by });
  await updateAllergy({ allergyId: allergy.id, facilityId, status: "INACTIVE", byUserId: by });
  const alE = await payloads("AllergyListUpdated", allergy.id);
  all.push(...alE);
  report("Allergy: ADDED (MODERATE, UNCONFIRMED) → UPDATED (CONFIRMED, HIGH) → INACTIVATED; never the substance or reaction",
    alE.map((p) => `${p.action}:${p.verification}:${p.status}`).join() === "ADDED:UNCONFIRMED:ACTIVE,UPDATED:CONFIRMED:ACTIVE,INACTIVATED:CONFIRMED:INACTIVE"
      && alE[1].criticality === "HIGH" && !JSON.stringify(alE).includes("Secretcillin") && !JSON.stringify(alE).includes("rash"));
  report("…an inactive allergy can't be changed", await rejects(updateAllergy({ allergyId: allergy.id, facilityId, severity: "severe", byUserId: by })));

  // 5. Referrals.
  const referral = await createReferral({ encounterId: enc.id, facilityId, fromStaffId: doctor.id, reason: `Secret reason ${run}`, priority: "URGENT", byUserId: by });
  await respondToReferral({ referralId: referral.id, facilityId, status: "ACKNOWLEDGED", notes: `Secret notes ${run}`, staffId: doctor.id, byUserId: by });
  const results = await Promise.allSettled([
    respondToReferral({ referralId: referral.id, facilityId, status: "COMPLETED", byUserId: by }),
    respondToReferral({ referralId: referral.id, facilityId, status: "CANCELLED", byUserId: by }),
  ]);
  const rE = await payloads("ReferralStatusChanged", referral.id);
  all.push(...rE);
  report("Referral: null>PLACED (URGENT), PLACED>ACKNOWLEDGED, correlated by the encounter; never the reason or notes",
    rE[0]?.from === null && rE[0].to === "PLACED" && rE[0].priority === "URGENT" && rE[1]?.to === "ACKNOWLEDGED"
      && (await events("ReferralStatusChanged", referral.id))[0].correlationId === enc.id && !JSON.stringify(rE).includes("Secret"));
  report("…two responders racing: exactly one wins, with one event", results.filter((r) => r.status === "fulfilled").length === 1 && rE.length === 3, `${rE.length} events`);

  report("No payload carries free text from any of these calls", all.length >= 10 && !JSON.stringify(all).includes(run), `${all.length} payloads`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
