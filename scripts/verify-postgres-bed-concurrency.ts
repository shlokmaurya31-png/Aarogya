/**
 * Phase 5.5 manual verification: proves the bed-occupancy invariant ("a bed
 * can only be held by one patient/reservation at a time") holds against a
 * real PostgreSQL instance under genuine concurrent races — not sequential
 * requests. Exercises the three independent code paths that mutate bed
 * status (src/lib/hospital/admission.ts's admitPatient/transferPatient,
 * and src/lib/hospital/admissionRequest.ts's allocateBed, which composes
 * the shared src/lib/hospital/bed.ts#transitionBed()) to prove the fix
 * propagated to all of them. Mirrors scripts/verify-postgres-scheduling.ts's
 * structure.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-bed-concurrency.ts
 */
import { PrismaClient } from "@prisma/client";
import { admitPatient, transferPatient, BedNotAvailableError } from "../src/lib/hospital/admission";
import { allocateBed, AdmissionRequestNotPendingError } from "../src/lib/hospital/admissionRequest";
import { BedConcurrencyError, InvalidBedTransitionError } from "../src/lib/hospital/bed";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;

function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function freshEncounter(facilityId: string, patientId: string) {
  return prisma.encounter.create({ data: { facilityId, patientId, type: "OPD", accessSource: "WALK_IN" } });
}

const runId = Date.now();
async function freshBed(facilityId: string, wardId: string, label: string) {
  return prisma.bed.create({ data: { facilityId, wardId, label: `${label}-${runId}` } });
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id } });
  const admittingStaff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "DOCTOR" } } });
  const ward = await prisma.ward.create({ data: { facilityId: facility.id, name: `Verify-Script Ward ${Date.now()}`, wardType: "GENERAL" } });

  // 1. Genuine parallel race: two concurrent admitPatient calls for the SAME bed — exactly one must win.
  {
    const bed = await freshBed(facility.id, ward.id, "V-Bed-1");
    const enc1 = await freshEncounter(facility.id, patient.id);
    const enc2 = await freshEncounter(facility.id, patient.id);
    const attempt = (encounterId: string) =>
      admitPatient({ encounterId, bedId: bed.id, admittingStaffId: admittingStaff.id, reason: "verify-script", byUserId: admittingStaff.userId }).then(
        (admission) => ({ ok: true as const, admission }),
        (err) => ({ ok: false as const, err })
      );
    const [r1, r2] = await Promise.all([attempt(enc1.id), attempt(enc2.id)]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    const conflicts = [r1, r2].filter((r) => !r.ok && (r.err instanceof BedNotAvailableError || r.err instanceof BedConcurrencyError)).length;
    report(
      "Genuine parallel race: exactly one of two concurrent admitPatient calls for the same bed commits",
      successes === 1 && conflicts === 1,
      `successes=${successes} conflicts=${conflicts}`
    );
    const finalBed = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
    report("Bed ends up OCCUPIED exactly once, not corrupted", finalBed.status === "OCCUPIED");
  }

  // 2. Genuine parallel race: two already-admitted patients concurrently transferred INTO the same destination bed — exactly one must win.
  {
    const sourceBedA = await freshBed(facility.id, ward.id, "V-Bed-2a");
    const sourceBedB = await freshBed(facility.id, ward.id, "V-Bed-2b");
    const destBed = await freshBed(facility.id, ward.id, "V-Bed-2-dest");
    const encA = await freshEncounter(facility.id, patient.id);
    const encB = await freshEncounter(facility.id, patient.id);
    const admissionA = await admitPatient({ encounterId: encA.id, bedId: sourceBedA.id, admittingStaffId: admittingStaff.id, reason: "verify-script", byUserId: admittingStaff.userId });
    const admissionB = await admitPatient({ encounterId: encB.id, bedId: sourceBedB.id, admittingStaffId: admittingStaff.id, reason: "verify-script", byUserId: admittingStaff.userId });
    const attempt = (admissionId: string) =>
      transferPatient({ admissionId, toBedId: destBed.id, reason: "verify-script", byUserId: admittingStaff.userId }).then(
        (transfer) => ({ ok: true as const, transfer }),
        (err) => ({ ok: false as const, err })
      );
    const [r1, r2] = await Promise.all([attempt(admissionA.id), attempt(admissionB.id)]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    const conflicts = [r1, r2].filter((r) => !r.ok && (r.err instanceof BedNotAvailableError || r.err instanceof BedConcurrencyError)).length;
    report(
      "Genuine parallel race: exactly one of two concurrent transferPatient calls into the same destination bed commits",
      successes === 1 && conflicts === 1,
      `successes=${successes} conflicts=${conflicts}`
    );
    const finalDest = await prisma.bed.findUniqueOrThrow({ where: { id: destBed.id } });
    report("Destination bed ends up OCCUPIED exactly once, not corrupted", finalDest.status === "OCCUPIED");
  }

  // 3. Genuine parallel race: two concurrent allocateBed calls (Phase 2 admission-request layer, composes the shared transitionBed()) for the SAME bed — exactly one must win.
  {
    const bed = await freshBed(facility.id, ward.id, "V-Bed-3");
    const enc1 = await freshEncounter(facility.id, patient.id);
    const enc2 = await freshEncounter(facility.id, patient.id);
    const req1 = await prisma.admissionRequest.create({ data: { patientId: patient.id, encounterId: enc1.id, facilityId: facility.id, requestedByStaffId: admittingStaff.id, reason: "verify-script" } });
    const req2 = await prisma.admissionRequest.create({ data: { patientId: patient.id, encounterId: enc2.id, facilityId: facility.id, requestedByStaffId: admittingStaff.id, reason: "verify-script" } });
    const attempt = (requestId: string) =>
      allocateBed(requestId, bed.id, admittingStaff.id, admittingStaff.userId).then(
        (updated) => ({ ok: true as const, updated }),
        (err) => ({ ok: false as const, err })
      );
    const [r1, r2] = await Promise.all([attempt(req1.id), attempt(req2.id)]);
    const successes = [r1, r2].filter((r) => r.ok).length;
    const conflicts = [r1, r2].filter(
      (r) => !r.ok && (r.err instanceof BedConcurrencyError || r.err instanceof InvalidBedTransitionError || r.err instanceof AdmissionRequestNotPendingError)
    ).length;
    report(
      "Genuine parallel race: exactly one of two concurrent allocateBed calls for the same bed commits",
      successes === 1 && conflicts === 1,
      `successes=${successes} conflicts=${conflicts}`
    );
    const finalBed = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
    report("Bed ends up RESERVED exactly once, not corrupted", finalBed.status === "RESERVED");
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
