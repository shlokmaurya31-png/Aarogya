/**
 * Phase 5.5 manual verification: proves callNext() cannot call the same
 * WAITING queue entry twice under genuine concurrent races (two front-desk
 * staff / two doctor workstations calling "next patient" at the same
 * instant must not both receive the same patient). Mirrors
 * scripts/verify-postgres-scheduling.ts's structure.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-queue-concurrency.ts
 */
import { PrismaClient } from "@prisma/client";
import { callNext } from "../src/lib/hospital/queue";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;

function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id } });
  const encounter = await prisma.encounter.findFirstOrThrow({ where: { facilityId: facility.id, patientId: patient.id } });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id } });
  const queueType = `VERIFY_SCRIPT_${Date.now()}`;

  // Exactly one WAITING entry; two concurrent callNext() calls race for it.
  const entry = await prisma.queueEntry.create({
    data: { facilityId: facility.id, queueType, patientId: patient.id, encounterId: encounter.id, status: "WAITING", createdByStaffId: staff.id },
  });

  const [r1, r2] = await Promise.all([
    callNext(facility.id, queueType, undefined, staff.userId),
    callNext(facility.id, queueType, undefined, staff.userId),
  ]);

  const called = [r1, r2].filter((r) => r !== null);
  report(
    "Genuine parallel race: exactly one of two concurrent callNext() calls receives the sole WAITING entry",
    called.length === 1 && called[0]?.id === entry.id,
    `calledCount=${called.length}`
  );

  const finalEntry = await prisma.queueEntry.findUniqueOrThrow({ where: { id: entry.id } });
  report("Entry ends up CALLED exactly once, not corrupted", finalEntry.status === "CALLED");

  // Filtered in JS rather than a JSON-path where-clause: Prisma's generated
  // JSON-filter type differs between the SQLite and Postgres connectors,
  // and this script must type-check against whichever connector's client
  // is currently generated locally, even though it only ever runs against
  // Postgres.
  const recentCalledEvents = await prisma.auditEvent.findMany({ where: { type: "hospital.queue.called" }, orderBy: { createdAt: "desc" }, take: 20 });
  const auditCount = recentCalledEvents.filter((e) => (e.detail as { queueEntryId?: string } | null)?.queueEntryId === entry.id).length;
  report("Exactly one 'called' audit event was recorded, not two", auditCount === 1, `auditCount=${auditCount}`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
