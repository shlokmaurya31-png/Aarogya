/**
 * Phase 5.5 manual verification: proves the appointment double-booking
 * invariant ("a doctor may not hold more overlapping active appointments
 * than maxConcurrentAppointments allows") holds against a real PostgreSQL
 * instance under genuine concurrent races — not sequential requests.
 * Exercises the pg_advisory_xact_lock serialization added to
 * src/lib/hospital/appointment.ts#bookAppointment (see that function's
 * docstring for why a GiST exclusion constraint was rejected in favor of
 * this mechanism: maxConcurrentAppointments can legitimately exceed 1).
 * Mirrors scripts/verify-postgres-scheduling.ts's structure.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-appointment-concurrency.ts
 */
import { PrismaClient } from "@prisma/client";
import { bookAppointment, SlotConflictError } from "../src/lib/hospital/appointment";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;

function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

/** An unexpected loser's error, so an unclean round says why (class, code, last message line). */
function describe(err: unknown): string {
  const e = err as { constructor?: { name?: string }; code?: string; message?: string };
  const last = String(e?.message ?? err).split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return `${e?.constructor?.name ?? typeof err}${e?.code ? `[${e.code}]` : ""}: ${last.slice(0, 240)}`;
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const patient1 = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id } });
  const patient2 = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id }, skip: 1 });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { ...staffAtFacilityWhere(facility.id) } });
  // D7: only times inside a clinic session are bookable, so this gate's two
  // doctors get an all-day session every day (one booking per slot).
  const run = Date.now().toString(36);
  const gateDoctor = async (tag: string) => {
    const user = await prisma.user.create({ data: { email: `appt-race-${tag}-${run}@verify.aarogya`, passwordHash: "x", role: "DOCTOR", displayName: `Race ${tag}` } });
    const profile = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, displayRole: "Physician", status: "ACTIVE" } });
    await ensurePrimaryMembership(prisma, user.id, facility.id);
    await prisma.doctorScheduleBlock.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ staffId: profile.id, facilityId: facility.id, dayOfWeek, startMinute: 0, endMinute: 1440, maxConcurrentAppointments: 1 })),
    });
    return profile;
  };
  const doctor = await gateDoctor("a");
  const otherDoctor = await gateDoctor("b");

  const base = new Date("2027-02-01T09:00:00.000Z"); // fixed, far-future-enough anchor for deterministic re-runs
  const at = (hh: number, mm: number) => new Date(base.getTime() + (hh * 60 + mm) * 60_000);

  const book = (doctorStaffId: string, patientId: string, scheduledStart: Date, scheduledEnd: Date) =>
    bookAppointment({ facilityId: facility.id, doctorStaffId, patientId, scheduledStart, scheduledEnd, createdByStaffId: staff.id, byUserId: staff.userId }).then(
      (appointment) => ({ ok: true as const, appointment }),
      (err) => ({ ok: false as const, err })
    );

  // 1. Exact duplicate slot, sequential — must reject the second.
  {
    const r1 = await book(doctor.id, patient1.id, at(0, 0), at(0, 30));
    const r2 = await book(doctor.id, patient2.id, at(0, 0), at(0, 30));
    report("Exact duplicate slot rejects the second booking", r1.ok && !r2.ok && r2.err instanceof SlotConflictError);
  }

  // 2. Partial overlap, sequential — must reject the second.
  {
    const r1 = await book(doctor.id, patient1.id, at(1, 0), at(1, 30));
    const r2 = await book(doctor.id, patient2.id, at(1, 15), at(1, 45));
    report("Partial overlap (09:00-09:30 vs 09:15-09:45) rejects the second booking", r1.ok && !r2.ok && r2.err instanceof SlotConflictError);
  }

  // 3. Adjacent slots — both allowed (half-open interval).
  {
    const r1 = await book(doctor.id, patient1.id, at(2, 0), at(2, 30));
    const r2 = await book(doctor.id, patient2.id, at(2, 30), at(3, 0));
    report("Adjacent slots (09:00-09:30 vs 09:30-10:00) both allowed", r1.ok && r2.ok);
  }

  // 4. Different doctor, same time — both allowed.
  {
    const r1 = await book(doctor.id, patient1.id, at(4, 0), at(4, 30));
    const r2 = await book(otherDoctor.id, patient2.id, at(4, 0), at(4, 30));
    report("Different doctor, same time, both allowed", r1.ok && r2.ok);
  }

  // 5. Cancelled appointment frees the slot for reuse.
  {
    const r1 = await book(doctor.id, patient1.id, at(5, 0), at(5, 30));
    if (r1.ok) await prisma.appointment.update({ where: { id: r1.appointment.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledReason: "verify-script" } });
    const r2 = await book(doctor.id, patient2.id, at(5, 0), at(5, 30));
    report("Cancelled appointment frees the slot for reuse", r1.ok && r2.ok);
  }

  // 6. Genuine parallel race: 10 rounds of 5 truly concurrent bookings for
  // the same doctor and slot — exactly one must win each round. (A single
  // two-way race was too weak: with the advisory lock removed it still
  // passed, while 5-way rounds double-book every time without the lock.)
  {
    const contenders = await prisma.patient.findMany({ where: { facilityId: facility.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 5 });
    const rounds = 10;
    let cleanRounds = 0;
    let maxWinners = 0;
    const unexpected: string[] = [];
    for (let round = 0; round < rounds; round++) {
      const start = at(6, round * 30);
      const end = at(6, round * 30 + 30);
      const results = await Promise.all(contenders.map((p) => book(doctor.id, p.id, start, end)));
      const winners = results.filter((r) => r.ok).length;
      const conflicts = results.filter((r) => !r.ok && r.err instanceof SlotConflictError).length;
      maxWinners = Math.max(maxWinners, winners);
      if (winners === 1 && conflicts === contenders.length - 1) cleanRounds += 1;
      else unexpected.push(`round ${round}: winners=${winners} conflicts=${conflicts} ${results.filter((r) => !r.ok && !(r.err instanceof SlotConflictError)).map((r) => (r.ok ? "" : describe(r.err))).join(" | ")}`);
    }
    report(
      `Genuine parallel race: exactly one of ${contenders.length} concurrent overlapping bookings commits, in every one of ${rounds} rounds`,
      contenders.length === 5 && cleanRounds === rounds,
      `cleanRounds=${cleanRounds}/${rounds} maxWinners=${maxWinners}${unexpected.length ? `; ${unexpected.join("; ")}` : ""}`
    );
  }

  // 7. Genuine parallel race, different doctors — both must succeed (the advisory lock is keyed per-doctor, so it must not serialize unrelated doctors into a false conflict).
  {
    const [r1, r2] = await Promise.all([book(doctor.id, patient1.id, at(12, 0), at(12, 30)), book(otherDoctor.id, patient2.id, at(12, 0), at(12, 30))]);
    report("Genuine parallel race, different doctors: both commit (no false cross-doctor conflict)", r1.ok && r2.ok);
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
