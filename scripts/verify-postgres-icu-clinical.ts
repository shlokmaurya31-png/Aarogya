/**
 * Phase B2 manual verification: ICU clinical depth against real PostgreSQL —
 * timeline composition, transparent I/O totals, infusion lifecycle race,
 * step-down transfer-out to a non-ICU ward, and cross-facility IDOR on ICU
 * observation recording. Device/admission bed races are already covered by
 * verify-postgres-icu-concurrency.ts (B1).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-icu-clinical.ts
 */
import { PrismaClient } from "@prisma/client";
import { createIcuUnit, admitToIcu, recordObservation, recordInfusion, updateInfusionStatus, recordDevice, buildIcuRounding, buildIcuTimeline } from "../src/lib/hospital/icu";
import { transferPatient } from "../src/lib/hospital/admission";
import { NotFoundError } from "../src/lib/auth/rbac";

const prisma = new PrismaClient();
const runId = Date.now();
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "DOCTOR" } } });
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id } });
  const icuWard = await prisma.ward.create({ data: { facilityId: facility.id, name: `ICU Clin Ward ${runId}`, wardType: "ICU" } });
  const generalWard = await prisma.ward.create({ data: { facilityId: facility.id, name: `Stepdown Ward ${runId}`, wardType: "GENERAL" } });
  const unit = await createIcuUnit({ facilityId: facility.id, name: `ICU-Clin ${runId}`, byUserId: staff.userId });

  const icuBed = await prisma.bed.create({ data: { facilityId: facility.id, wardId: icuWard.id, label: `ICU-C1-${runId}`, icuCapable: true, ventilatorCapable: true, icuUnitId: unit.id } });
  const wardBed = await prisma.bed.create({ data: { facilityId: facility.id, wardId: generalWard.id, label: `WARD-${runId}`, icuCapable: false } });
  const enc = await prisma.encounter.create({ data: { facilityId: facility.id, patientId: patient.id, type: "IPD", accessSource: "WALK_IN" } });
  const admission = await admitToIcu({ encounterId: enc.id, bedId: icuBed.id, facilityId: facility.id, admittingStaffId: staff.id, reason: "b2", byUserId: staff.userId });

  // Seed some clinical data.
  await prisma.vital.create({ data: { encounterId: enc.id, recordedByStaffId: staff.id, hr: 96, sbp: 118, dbp: 70, rr: 22, spo2: 94, tempC: 38.1 } });
  await recordObservation({ encounterId: enc.id, facilityId: facility.id, type: "VENTILATOR", values: { mode: "SIMV", fio2: "0.5", peep: "8" }, recordedByStaffId: staff.id, byUserId: staff.userId });
  await recordObservation({ encounterId: enc.id, facilityId: facility.id, type: "ABG", values: { ph: "7.32", pao2: "78", paco2: "48" }, recordedByStaffId: staff.id, byUserId: staff.userId });
  await recordDevice({ encounterId: enc.id, facilityId: facility.id, deviceType: "CENTRAL_LINE", status: "ACTIVE", recordedByStaffId: staff.id, byUserId: staff.userId });
  await prisma.intakeOutputRecord.create({ data: { encounterId: enc.id, facilityId: facility.id, ioType: "INPUT", category: "IV", quantityMl: 500, recordedByStaffId: staff.id } });
  await prisma.intakeOutputRecord.create({ data: { encounterId: enc.id, facilityId: facility.id, ioType: "INPUT", category: "ORAL", quantityMl: 200, recordedByStaffId: staff.id } });
  await prisma.intakeOutputRecord.create({ data: { encounterId: enc.id, facilityId: facility.id, ioType: "OUTPUT", category: "URINE", quantityMl: 450, recordedByStaffId: staff.id } });

  // ── A: I/O totals arithmetic is transparent and correct ──
  {
    const rounding = await buildIcuRounding(enc.id);
    const t = rounding.ioTotals;
    report("A: I/O totals — In 700 − Out 450 = Net 250 (mL only)", t.totalInputMl === 700 && t.totalOutputMl === 450 && t.netMl === 250, `in=${t.totalInputMl}, out=${t.totalOutputMl}, net=${t.netMl}`);
  }

  // ── B: ICU timeline composes canonical events (admission, vital, observations, device, I/O) ──
  {
    const tl = await buildIcuTimeline(enc.id);
    const types = new Set(tl.map((e) => e.type.split(":")[0]));
    const ok = types.has("Admission") && types.has("Vital") && types.has("Observation") && types.has("Device") && types.has("I/O");
    report("B: ICU timeline composes admission + vital + observation + device + I/O", ok, `distinctTypes=${[...types].join(",")}`);
  }

  // ── C: infusion lifecycle race — two concurrent stops, exactly one wins ──
  {
    const inf = await recordInfusion({ encounterId: enc.id, facilityId: facility.id, drugName: `Noradrenaline ${runId}`, rate: 5, rateUnit: "mcg/min", recordedByStaffId: staff.id, byUserId: staff.userId });
    const attempt = () => updateInfusionStatus({ infusionId: inf.id, facilityId: facility.id, status: "STOPPED", byUserId: staff.userId }).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const succeeded = [r1, r2].filter((r) => r.ok).length;
    const finalInf = await prisma.icuInfusion.findUniqueOrThrow({ where: { id: inf.id } });
    report("C: concurrent infusion stop — exactly one wins, STOPPED once, stoppedAt set", succeeded === 1 && finalInf.status === "STOPPED" && finalInf.stoppedAt !== null, `succeeded=${succeeded}, status=${finalInf.status}`);
  }

  // ── D: step-down transfer-out to a non-ICU ward via canonical ADT ──
  {
    const transfer = await transferPatient({ admissionId: admission.id, toBedId: wardBed.id, reason: "step-down", byUserId: staff.userId }).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));
    const finalIcuBed = await prisma.bed.findUniqueOrThrow({ where: { id: icuBed.id } });
    const finalWardBed = await prisma.bed.findUniqueOrThrow({ where: { id: wardBed.id } });
    // ICU devices/infusions are NOT auto-discontinued on transfer (explicit clinical workflow).
    const stillActiveDevice = await prisma.icuDevice.count({ where: { encounterId: enc.id, status: "ACTIVE" } });
    report(
      "D: step-down transfer-out to a ward — succeeds, ICU bed released, ward bed occupied, devices preserved (not auto-discontinued)",
      transfer.ok && finalIcuBed.status === "CLEANING" && finalWardBed.status === "OCCUPIED" && stillActiveDevice === 1,
      `icuBed=${finalIcuBed.status}, wardBed=${finalWardBed.status}, activeDevices=${stillActiveDevice}`
    );
  }

  // ── E: cross-facility IDOR — recording an observation for a Facility-B encounter under a Facility-A scope fails ──
  {
    const otherFacility = await prisma.facility.findFirst({ where: { id: { not: facility.id } } });
    if (otherFacility) {
      const otherPatient = await prisma.patient.create({ data: { uhid: `UHID-ICUCLIN-${runId}`, facilityId: otherFacility.id, fullName: `XF ${runId}`, sex: "male" } });
      const otherEnc = await prisma.encounter.create({ data: { facilityId: otherFacility.id, patientId: otherPatient.id, type: "IPD", accessSource: "WALK_IN" } });
      const r = await recordObservation({ encounterId: otherEnc.id, facilityId: facility.id, type: "NEURO", values: { gcsTotal: "15" }, recordedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));
      report("E: cross-facility ICU observation recording rejected (encounter facility mismatch)", !r.ok && (r as { err: unknown }).err instanceof NotFoundError);
    } else {
      report("E: cross-facility ICU observation (skipped — one facility)", true);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
