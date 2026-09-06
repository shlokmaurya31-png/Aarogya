/**
 * Phase 4.5 manual verification: proves the ImagingStudy resource-scheduling
 * invariant ("two active bookings for the same resource may never overlap")
 * holds against a real PostgreSQL instance, including a genuine concurrent
 * race — not sequential requests. Run manually against a Postgres-backed
 * dev database (see docs/PHASE_4_5_INTEGRITY_GATE.md for setup). Mirrors
 * this codebase's existing convention of verifying concurrency claims via
 * real parallel execution rather than automated test infra (no DB-backed
 * test suite exists in this repo — see vitest.config.ts).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-scheduling.ts
 */
import { PrismaClient } from "@prisma/client";
import { createOrderEnvelope } from "../src/lib/hospital/orderEnvelope";
import { scheduleStudy, ScheduleConflictError } from "../src/lib/hospital/imagingStudyLifecycle";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;

function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function freshOrder(facilityId: string, encounterId: string, patientId: string, orderingStaffId: string) {
  const envelope = await createOrderEnvelope(prisma, { facilityId, encounterId, patientId, orderingStaffId, orderType: "IMAGING", priority: "ROUTINE" });
  const imagingOrder = await prisma.imagingOrder.create({
    data: { encounterId, patientId, modality: "USG", studyDescription: "Verify-script fixture", orderedByStaffId: orderingStaffId, status: "ORDERED", orderId: envelope.id },
  });
  return imagingOrder.id;
}

async function trySchedule(orderId: string, facilityId: string, patientId: string, encounterId: string, resourceId: string, scheduledAt: Date, durationMinutes = 30) {
  try {
    const study = await prisma.$transaction((tx) =>
      scheduleStudy(tx, { imagingOrderId: orderId, facilityId, patientId, encounterId, modality: "USG", resourceId, scheduledAt, durationMinutes })
    );
    return { ok: true as const, study };
  } catch (err) {
    return { ok: false as const, err };
  }
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id } });
  const encounter = await prisma.encounter.findFirstOrThrow({ where: { facilityId: facility.id, patientId: patient.id } });
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "DOCTOR" } } });
  // Dedicated resource for this script, isolated from seed data's own bookings.
  const resource = await prisma.imagingResource.create({ data: { facilityId: facility.id, name: "Verify-Script USG", modality: "USG" } });
  const otherResource = await prisma.imagingResource.create({ data: { facilityId: facility.id, name: "Verify-Script USG #2", modality: "USG" } });

  const base = new Date("2027-01-01T10:00:00.000Z"); // fixed, far-future-enough anchor for deterministic re-runs
  const at = (hh: number, mm: number) => new Date(base.getTime() + (hh * 60 + mm) * 60_000);

  // 1. Exact collision: 10:00-10:30 vs 10:00-10:30 — must reject one.
  {
    const o1 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const o2 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const r1 = await trySchedule(o1, facility.id, patient.id, encounter.id, resource.id, at(10, 0), 30);
    const r2 = await trySchedule(o2, facility.id, patient.id, encounter.id, resource.id, at(10, 0), 30);
    report("Exact collision (10:00-10:30 vs 10:00-10:30) rejects one", r1.ok && !r2.ok && r2.err instanceof ScheduleConflictError);
  }

  // 2. Partial overlap: 10:00-10:30 vs 10:15-10:45 — must reject one.
  {
    const o1 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const o2 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const r1 = await trySchedule(o1, facility.id, patient.id, encounter.id, resource.id, at(11, 0), 30);
    const r2 = await trySchedule(o2, facility.id, patient.id, encounter.id, resource.id, at(11, 15), 30);
    report("Partial overlap (10:00-10:30 vs 10:15-10:45) rejects one", r1.ok && !r2.ok && r2.err instanceof ScheduleConflictError);
  }

  // 3. Contained overlap: 10:00-11:00 vs 10:15-10:30 — must reject one.
  {
    const o1 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const o2 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const r1 = await trySchedule(o1, facility.id, patient.id, encounter.id, resource.id, at(12, 0), 60);
    const r2 = await trySchedule(o2, facility.id, patient.id, encounter.id, resource.id, at(12, 15), 15);
    report("Contained overlap (10:00-11:00 vs 10:15-10:30) rejects one", r1.ok && !r2.ok && r2.err instanceof ScheduleConflictError);
  }

  // 4. Adjacent: 10:00-10:30 vs 10:30-11:00 — both allowed (half-open interval).
  {
    const o1 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const o2 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const r1 = await trySchedule(o1, facility.id, patient.id, encounter.id, resource.id, at(13, 0), 30);
    const r2 = await trySchedule(o2, facility.id, patient.id, encounter.id, resource.id, at(13, 30), 30);
    report("Adjacent (10:00-10:30 vs 10:30-11:00) both allowed", r1.ok && r2.ok);
  }

  // 5. Different resources: same time, different resource — both allowed.
  {
    const o1 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const o2 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const r1 = await trySchedule(o1, facility.id, patient.id, encounter.id, resource.id, at(14, 0), 30);
    const r2 = await trySchedule(o2, facility.id, patient.id, encounter.id, otherResource.id, at(14, 0), 30);
    report("Different resources, same time, both allowed", r1.ok && r2.ok);
  }

  // 6. Different facilities: resources are facility-scoped, so a resource from facility B never collides with facility A's schedule regardless of time.
  {
    const facilityB = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Noida Hospital" } });
    const patientB = await prisma.patient.findFirstOrThrow({ where: { facilityId: facilityB.id } });
    const encounterB = await prisma.encounter.findFirstOrThrow({ where: { facilityId: facilityB.id, patientId: patientB.id } });
    const doctorB = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facilityB.id, user: { role: "DOCTOR" } } });
    const resourceB = await prisma.imagingResource.create({ data: { facilityId: facilityB.id, name: "Verify-Script USG (Noida)", modality: "USG" } });
    const o1 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const o2 = await freshOrder(facilityB.id, encounterB.id, patientB.id, doctorB.id);
    const r1 = await trySchedule(o1, facility.id, patient.id, encounter.id, resource.id, at(15, 0), 30);
    const r2 = await trySchedule(o2, facilityB.id, patientB.id, encounterB.id, resourceB.id, at(15, 0), 30);
    report("Different facilities (tenant-scoped resources) both allowed", r1.ok && r2.ok);
  }

  // 7. Cancelled booking frees the resource for reuse at the same slot.
  {
    const o1 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const o2 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const r1 = await trySchedule(o1, facility.id, patient.id, encounter.id, resource.id, at(16, 0), 30);
    if (r1.ok) await prisma.imagingStudy.update({ where: { id: r1.study.id }, data: { status: "CANCELLED", cancelledReason: "verify-script" } });
    const r2 = await trySchedule(o2, facility.id, patient.id, encounter.id, resource.id, at(16, 0), 30);
    report("Cancelled booking frees the resource for reuse", r1.ok && r2.ok);
  }

  // 8. Genuine parallel race: two truly concurrent scheduling attempts for the same resource+overlapping window — exactly one must win.
  {
    const o1 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const o2 = await freshOrder(facility.id, encounter.id, patient.id, doctor.id);
    const [r1, r2] = await Promise.all([
      trySchedule(o1, facility.id, patient.id, encounter.id, resource.id, at(17, 0), 30),
      trySchedule(o2, facility.id, patient.id, encounter.id, resource.id, at(17, 0), 30),
    ]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    const conflictRejections = [r1, r2].filter((r) => !r.ok && r.err instanceof ScheduleConflictError).length;
    report(
      "Genuine parallel race: exactly one of two truly concurrent overlapping bookings commits",
      successes === 1 && conflictRejections === 1,
      `successes=${successes} conflictRejections=${conflictRejections}`
    );
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
