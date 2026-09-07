import { prisma } from "@/lib/db";
import type { AppointmentType, AccessSource, RequestPriority } from "@prisma/client";

export class SlotConflictError extends Error {
  constructor() {
    super("This doctor already has an appointment at that time (slot is full).");
  }
}

function isSameCalendarDate(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

/**
 * Pure half-open-interval overlap predicate — the canonical definition of
 * "these two appointment windows conflict," exported so it's unit-testable
 * without a database. `bookAppointment`'s actual conflict query expresses
 * the same test as Prisma `lt`/`gt` where-clauses (a DB query can't call a
 * JS function per row); this function documents that logic precisely and
 * is what the overlap-matrix tests in appointment.test.ts exercise
 * directly. [aStart, aEnd) and [bStart, bEnd) overlap iff aStart < bEnd
 * AND aEnd > bStart — touching endpoints (one ends exactly when the other
 * starts) are NOT an overlap.
 */
export function appointmentsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

const isPostgres = () => Boolean(process.env.DATABASE_URL?.startsWith("postgres"));

/**
 * Books an appointment with a transactional conflict check (brief §61) —
 * queries for existing active appointments genuinely OVERLAPPING the
 * requested [scheduledStart, scheduledEnd) window for that doctor (the
 * resource that can't be double-booked — `roomLabel` is informational only
 * on this model, not a separately reservable resource), inside the same
 * `$transaction` as the create, and refuses if the count already meets
 * `maxConcurrentAppointments` (default 1 = no overbooking, per any
 * matching `DoctorScheduleBlock`).
 *
 * Phase 5.5 hardening: this used to compare `scheduledStart` for exact
 * equality, which missed every partial overlap (a 9:00-9:30 and a
 * 9:15-9:45 booking for the same doctor didn't conflict). Fixed to a real
 * half-open-interval overlap test, the same shape used by ImagingStudy
 * scheduling (src/lib/hospital/imagingStudyLifecycle.ts).
 *
 * Concurrency mechanism differs deliberately from ImagingStudy/Tariff's
 * GiST exclusion constraints: those invariants are always "at most ONE
 * active row," which an exclusion constraint expresses directly.
 * Appointment's invariant is "at most `maxConcurrentAppointments` (an
 * admin-configurable value up to 20, read from a joined
 * `DoctorScheduleBlock` row) overlapping active rows" — a bound that a
 * static per-table exclusion constraint cannot express, since it can't see
 * a value from another table. A hard 1-row exclusion constraint here would
 * incorrectly reject legitimate bookings for any clinic session configured
 * with `maxConcurrentAppointments > 1`.
 *
 * Instead, on Postgres, this transaction takes a `pg_advisory_xact_lock`
 * keyed on `doctorStaffId` before counting overlaps — this is the
 * brief-sanctioned "transactional serialization" mechanism: it forces any
 * two concurrent `bookAppointment` calls for the *same* doctor to run
 * their count-then-insert critical section one at a time (the second
 * blocks until the first commits or rolls back), which closes the
 * phantom-read race for any value of `maxConcurrentAppointments`, not just
 * 1. The lock is scoped to the transaction (`_xact_`) so it releases
 * automatically on commit or rollback — no separate unlock call needed.
 * SQLite doesn't need this: `$transaction` calls already serialize against
 * SQLite's single connection, so no cross-doctor lock is necessary there;
 * the advisory-lock call is skipped entirely (it doesn't exist on SQLite).
 */
export async function bookAppointment(input: {
  facilityId: string;
  departmentId?: string;
  doctorStaffId: string;
  patientId: string;
  type?: AppointmentType;
  source?: AccessSource;
  priority?: RequestPriority;
  roomLabel?: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  reason?: string;
  createdByStaffId: string;
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    if (isPostgres()) {
      // Serializes concurrent bookAppointment calls for this doctor so the
      // overlap count below and the eventual create are effectively one
      // atomic step — closes the phantom-read race for any
      // maxConcurrentAppointments value. hashtext() is a stable, built-in
      // Postgres hash; _xact_ scope means it auto-releases on commit/rollback.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.doctorStaffId}))`;
    }

    const dayStart = new Date(input.scheduledStart);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);

    // Candidate schedule blocks for the day; a specificDate override is a
    // full calendar date, not a timestamp, so it must be range-matched
    // (dayStart/dayEnd) and calendar-compared, never compared for exact
    // Date equality against a timestamp that carries a time-of-day.
    const candidateBlock = await tx.doctorScheduleBlock.findFirst({
      where: {
        staffId: input.doctorStaffId,
        type: "CLINIC_SESSION",
        OR: [{ dayOfWeek: input.scheduledStart.getDay() }, { specificDate: { gte: dayStart, lt: dayEnd } }],
      },
    });
    const block =
      candidateBlock && (!candidateBlock.specificDate || isSameCalendarDate(candidateBlock.specificDate, input.scheduledStart))
        ? candidateBlock
        : null;
    const maxConcurrent = block?.maxConcurrentAppointments ?? 1;

    // Real half-open-interval overlap: [scheduledStart, scheduledEnd) vs
    // [existing.scheduledStart, existing.scheduledEnd) for the same doctor.
    // Exact-timestamp equality would miss every partial overlap.
    const overlapping = await tx.appointment.count({
      where: {
        doctorStaffId: input.doctorStaffId,
        scheduledStart: { lt: input.scheduledEnd },
        scheduledEnd: { gt: input.scheduledStart },
        status: { notIn: ["CANCELLED", "NO_SHOW"] },
      },
    });
    if (overlapping >= maxConcurrent) throw new SlotConflictError();

    const appointment = await tx.appointment.create({
      data: {
        facilityId: input.facilityId,
        departmentId: input.departmentId,
        doctorStaffId: input.doctorStaffId,
        patientId: input.patientId,
        type: input.type ?? "NEW",
        source: input.source ?? "APPOINTMENT",
        priority: input.priority ?? "ROUTINE",
        roomLabel: input.roomLabel ?? block?.roomLabel,
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
        reason: input.reason,
        createdByStaffId: input.createdByStaffId,
      },
    });
    await tx.auditEvent.create({
      data: { type: "hospital.appointment.created", userId: input.byUserId, detail: { appointmentId: appointment.id, doctorStaffId: input.doctorStaffId } },
    });
    return appointment;
  });
}

export class AppointmentNotConfirmableError extends Error {
  constructor(status: string) {
    super(`Cannot confirm from status ${status}.`);
  }
}

/**
 * Confirms a REQUESTED/RESCHEDULED appointment — transactional, guarded,
 * and audited, matching every other lifecycle action in this file. Phase
 * 5.5: previously the API route bypassed this service layer entirely with
 * a bare, non-transactional, non-audited `prisma.appointment.update()`.
 */
export async function confirmAppointment(appointmentId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    if (!["REQUESTED", "RESCHEDULED"].includes(appt.status)) throw new AppointmentNotConfirmableError(appt.status);
    const result = await tx.appointment.updateMany({ where: { id: appointmentId, status: appt.status }, data: { status: "CONFIRMED" } });
    if (result.count !== 1) throw new AppointmentNotConfirmableError(appt.status);
    await tx.auditEvent.create({ data: { type: "hospital.appointment.confirmed", userId: byUserId, detail: { appointmentId } } });
    return { ...appt, status: "CONFIRMED" };
  });
}

export class AppointmentNotCancellableError extends Error {
  constructor(status: string) {
    super(`Appointment cannot be cancelled from status ${status}.`);
  }
}

export async function cancelAppointment(appointmentId: string, reason: string, cancelledByStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    if (["COMPLETED", "CANCELLED", "NO_SHOW"].includes(appt.status)) throw new AppointmentNotCancellableError(appt.status);
    const updated = await tx.appointment.update({
      where: { id: appointmentId },
      data: { status: "CANCELLED", cancelledReason: reason, cancelledAt: new Date(), cancelledByStaffId },
    });
    await tx.auditEvent.create({ data: { type: "hospital.appointment.cancelled", userId: byUserId, detail: { appointmentId, reason } } });
    return updated;
  });
}

export class AppointmentAlreadyResolvedError extends Error {
  constructor() {
    super("Appointment has already arrived, been cancelled, or completed.");
  }
}

/** Marks a scheduled appointment that never arrived (brief §44). */
export async function markNoShow(appointmentId: string, markedByStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    if (!["REQUESTED", "CONFIRMED", "RESCHEDULED"].includes(appt.status)) throw new AppointmentAlreadyResolvedError();
    const updated = await tx.appointment.update({ where: { id: appointmentId }, data: { status: "NO_SHOW", noShowAt: new Date() } });
    await tx.auditEvent.create({ data: { type: "hospital.appointment.noShow", userId: byUserId, detail: { appointmentId, markedByStaffId } } });
    return updated;
  });
}

/**
 * Check-in (brief §12): locates/verifies the appointment, creates the
 * encounter if one doesn't already exist for this visit (never a
 * duplicate encounter for the same appointment), and marks the
 * appointment CHECKED_IN.
 */
export async function checkInAppointment(appointmentId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    if (["CANCELLED", "NO_SHOW", "COMPLETED"].includes(appt.status)) throw new AppointmentAlreadyResolvedError();

    let encounterId = appt.encounterId;
    if (!encounterId) {
      const encounter = await tx.encounter.create({
        data: {
          patientId: appt.patientId,
          facilityId: appt.facilityId,
          departmentId: appt.departmentId,
          type: "OPD",
          chiefComplaint: appt.reason,
          accessSource: appt.source,
        },
      });
      encounterId = encounter.id;
    }

    const updated = await tx.appointment.update({
      where: { id: appointmentId },
      data: { status: "CHECKED_IN", encounterId },
    });
    await tx.auditEvent.create({ data: { type: "hospital.appointment.checkedIn", userId: byUserId, detail: { appointmentId, encounterId } } });
    return { appointment: updated, encounterId };
  });
}
