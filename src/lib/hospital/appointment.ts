import { prisma } from "@/lib/db";
import type { AppointmentType, AccessSource, RequestPriority } from "@prisma/client";

export class SlotConflictError extends Error {
  constructor() {
    super("This doctor already has an appointment at that time (slot is full).");
  }
}

/**
 * Books an appointment with a transactional conflict check (brief §61) —
 * queries for existing active appointments overlapping the requested
 * window for that doctor, inside the same `$transaction` as the create,
 * and refuses if the count already meets `maxConcurrentAppointments`
 * (default 1 = no overbooking, per any matching `DoctorScheduleBlock`).
 *
 * This is an application-level transactional check, not a database
 * constraint — SQLite serializes `$transaction` calls against its single
 * connection, which is adequate at dev/demo scale. A Postgres deployment
 * with real concurrent write traffic should additionally take a
 * `SELECT ... FOR UPDATE`-style row lock or a partial unique index; see
 * docs/PATIENT_FLOW.md's concurrency section.
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
    const block = await tx.doctorScheduleBlock.findFirst({
      where: {
        staffId: input.doctorStaffId,
        type: "CLINIC_SESSION",
        OR: [{ dayOfWeek: input.scheduledStart.getDay() }, { specificDate: input.scheduledStart }],
      },
    });
    const maxConcurrent = block?.maxConcurrentAppointments ?? 1;

    const overlapping = await tx.appointment.count({
      where: {
        doctorStaffId: input.doctorStaffId,
        scheduledStart: input.scheduledStart,
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
