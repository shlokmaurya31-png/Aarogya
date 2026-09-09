/**
 * Phase B1 manual verification: proves the ICU Foundation invariants against
 * a real PostgreSQL instance — ICU bed admission race (reuses the guarded
 * admitPatient bed CAS), device status-change race, ICU bed-capability
 * matching (resource matching, not a clinical decision), and cross-facility
 * isolation. Reuses the real ICU service (no mocks). ICU transfer rides the
 * same guarded transferPatient covered by verify-postgres-bed-concurrency.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-icu-concurrency.ts
 */
import { PrismaClient } from "@prisma/client";
import { createIcuUnit, admitToIcu, recordDevice, updateDeviceStatus, IcuBedCapabilityError } from "../src/lib/hospital/icu";

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
  const ward = await prisma.ward.create({ data: { facilityId: facility.id, name: `ICU Verify Ward ${runId}`, wardType: "ICU" } });

  const unit = await createIcuUnit({ facilityId: facility.id, name: `MICU ${runId}`, icuType: "MICU", ventilatorCapable: true, byUserId: staff.userId });

  async function icuBed(label: string, opts: { vent?: boolean; neg?: boolean; icu?: boolean } = {}) {
    return prisma.bed.create({
      data: { facilityId: facility.id, wardId: ward.id, label: `${label}-${runId}`, icuCapable: opts.icu ?? true, ventilatorCapable: opts.vent ?? false, negativePressure: opts.neg ?? false, icuUnitId: unit.id },
    });
  }
  async function encounter() {
    return prisma.encounter.create({ data: { facilityId: facility.id, patientId: patient.id, type: "IPD", accessSource: "WALK_IN" } });
  }

  // ── A: two concurrent ICU admissions for the SAME bed — exactly one wins ──
  {
    const bed = await icuBed("ICU-A");
    const e1 = await encounter();
    const e2 = await encounter();
    const attempt = (encounterId: string) =>
      admitToIcu({ encounterId, bedId: bed.id, facilityId: facility.id, admittingStaffId: staff.id, reason: "icu-race", byUserId: staff.userId }).then(
        () => ({ ok: true as const }), (err) => ({ ok: false as const, err })
      );
    const [r1, r2] = await Promise.all([attempt(e1.id), attempt(e2.id)]);
    const succeeded = [r1, r2].filter((r) => r.ok).length;
    const finalBed = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
    report("A: two concurrent ICU admissions for the same bed — exactly one succeeds, bed OCCUPIED once", succeeded === 1 && finalBed.status === "OCCUPIED", `succeeded=${succeeded}, bed=${finalBed.status}`);
  }

  // ── B: ICU capability matching — a non-ICU bed is rejected; a ventilator requirement needs a ventilator bed ──
  {
    const plainBed = await prisma.bed.create({ data: { facilityId: facility.id, wardId: ward.id, label: `PLAIN-${runId}`, icuCapable: false } });
    const e = await encounter();
    const r1 = await admitToIcu({ encounterId: e.id, bedId: plainBed.id, facilityId: facility.id, admittingStaffId: staff.id, reason: "x", byUserId: staff.userId }).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));
    const nonVentBed = await icuBed("ICU-NOVENT", { vent: false });
    const e2 = await encounter();
    const r2 = await admitToIcu({ encounterId: e2.id, bedId: nonVentBed.id, facilityId: facility.id, admittingStaffId: staff.id, reason: "x", requireVentilator: true, byUserId: staff.userId }).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));
    report(
      "B: capability matching — non-ICU bed rejected, ventilator requirement rejects a non-ventilator ICU bed",
      !r1.ok && (r1 as { err: unknown }).err instanceof IcuBedCapabilityError && !r2.ok && (r2 as { err: unknown }).err instanceof IcuBedCapabilityError
    );
  }

  // ── C: concurrent device status change — exactly one terminal transition wins ──
  {
    const e = await encounter();
    const device = await recordDevice({ encounterId: e.id, facilityId: facility.id, deviceType: "CENTRAL_LINE", status: "ACTIVE", recordedByStaffId: staff.id, byUserId: staff.userId });
    const attempt = () => updateDeviceStatus({ deviceId: device.id, facilityId: facility.id, status: "REMOVED", byUserId: staff.userId }).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const succeeded = [r1, r2].filter((r) => r.ok).length;
    const finalDevice = await prisma.icuDevice.findUniqueOrThrow({ where: { id: device.id } });
    report("C: concurrent device removal — exactly one wins, device REMOVED once", succeeded === 1 && finalDevice.status === "REMOVED", `succeeded=${succeeded}, status=${finalDevice.status}`);
  }

  // ── D: cross-facility ICU admission is blocked (facility isolation) ──
  {
    const otherFacility = await prisma.facility.findFirst({ where: { id: { not: facility.id } } });
    if (otherFacility) {
      const bed = await icuBed("ICU-XF");
      const otherPatient = await prisma.patient.create({ data: { uhid: `UHID-ICUXF-${runId}`, facilityId: otherFacility.id, fullName: `ICU XF ${runId}`, sex: "male" } });
      const otherEnc = await prisma.encounter.create({ data: { facilityId: otherFacility.id, patientId: otherPatient.id, type: "IPD", accessSource: "WALK_IN" } });
      // admitToIcu resolves facility from the caller; a Facility-A caller admitting a Facility-B encounter must fail the encounter facility check.
      const r = await admitToIcu({ encounterId: otherEnc.id, bedId: bed.id, facilityId: facility.id, admittingStaffId: staff.id, reason: "x", byUserId: staff.userId }).then(() => ({ ok: true as const }), (err) => ({ ok: false as const, err }));
      report("D: cross-facility ICU admission rejected (encounter facility mismatch)", !r.ok);
    } else {
      report("D: cross-facility ICU admission (skipped — one facility)", true);
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
