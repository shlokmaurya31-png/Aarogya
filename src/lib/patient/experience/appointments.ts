import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { bookAppointment, cancelAppointment } from "@/lib/hospital/appointment";
import { patientLanguage as L } from "./language";
import { assertClass, type PatientAccessScope } from "../context";

/**
 * Phase D11 — patient-facing appointments. A projection over the canonical
 * Appointment model + a thin, ownership-checked wrapper over the canonical
 * booking/cancellation services (never a second appointment store, brief §9).
 * All concurrency/overlap protection lives in bookAppointment; this layer only
 * establishes WHO may act and translates to patient language.
 */

const ACTIVE_STATUSES = ["REQUESTED", "CONFIRMED", "RESCHEDULED", "ARRIVED", "CHECKED_IN", "WAITING", "IN_CONSULTATION"];
const CANCELLABLE = ["REQUESTED", "CONFIRMED", "RESCHEDULED"];
const DEFAULT_SLOT_MINUTES = 15;

export interface AppointmentDTO {
  id: string;
  doctorName: string;
  department: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  statusLabel: string;
  typeLabel: string;
  reason: string | null;
  roomLabel: string | null;
  isForSelf: boolean;
  canCancel: boolean;
}

function toDTO(a: {
  id: string; scheduledStart: Date; scheduledEnd: Date; status: string; type: string;
  reason: string | null; roomLabel: string | null; patientId: string;
  doctor?: { user?: { displayName: string } | null } | null;
  department?: { name: string } | null;
}, scope: PatientAccessScope): AppointmentDTO {
  return {
    id: a.id,
    doctorName: a.doctor?.user?.displayName ?? "Care team",
    department: a.department?.name ?? null,
    scheduledStart: a.scheduledStart.toISOString(),
    scheduledEnd: a.scheduledEnd.toISOString(),
    statusLabel: L.appointmentStatus(a.status),
    typeLabel: L.appointmentType(a.type),
    reason: a.reason,
    roomLabel: a.roomLabel,
    isForSelf: scope.isSelf,
    // A delegate is read-only; only the patient themselves may cancel.
    canCancel: scope.isSelf && CANCELLABLE.includes(a.status),
  };
}

export async function listAppointments(scope: PatientAccessScope) {
  assertClass(scope, "APPOINTMENTS");
  const rows = await prisma.appointment.findMany({
    where: { patientId: { in: scope.patientIds } },
    orderBy: { scheduledStart: "desc" },
    take: 100,
    include: { doctor: { include: { user: { select: { displayName: true } } } }, department: { select: { name: true } } },
  });
  const now = Date.now();
  const upcoming: AppointmentDTO[] = [];
  const past: AppointmentDTO[] = [];
  for (const r of rows) {
    const dto = toDTO(r, scope);
    if (r.scheduledStart.getTime() >= now && ACTIVE_STATUSES.includes(r.status)) upcoming.push(dto);
    else past.push(dto);
  }
  upcoming.sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
  return { upcoming, past };
}

/** Next upcoming appointment only — for the home dashboard. */
export async function nextAppointment(scope: PatientAccessScope): Promise<AppointmentDTO | null> {
  const { upcoming } = await listAppointments(scope);
  return upcoming[0] ?? null;
}

/** Doctors a patient may request an appointment with (those running clinic sessions in their facility). */
export async function listBookableDoctors(scope: PatientAccessScope) {
  const blocks = await prisma.doctorScheduleBlock.findMany({
    where: { facilityId: scope.facilityId, type: "CLINIC_SESSION" },
    include: { staff: { include: { user: { select: { displayName: true } }, department: { select: { name: true } } } } },
  });
  const seen = new Map<string, { staffId: string; name: string; role: string; department: string | null; slotMinutes: number }>();
  for (const b of blocks) {
    if (b.staff.status !== "ACTIVE") continue;
    if (!seen.has(b.staffId)) {
      seen.set(b.staffId, {
        staffId: b.staffId,
        name: b.staff.user?.displayName ?? "Doctor",
        role: b.staff.displayRole,
        department: b.staff.department?.name ?? null,
        slotMinutes: b.slotDurationMinutes ?? DEFAULT_SLOT_MINUTES,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Patient-initiated booking. Only the patient themselves may book (resolveActScope
 * guarantees scope.isSelf). The doctor MUST belong to the patient's own facility —
 * a client-supplied doctor from another facility is rejected, never trusted. Slot
 * length is derived from the doctor's clinic session, not from the client. The
 * canonical bookAppointment enforces the overlap/double-booking guard.
 */
export async function requestAppointment(
  scope: PatientAccessScope,
  actorUserId: string,
  input: { doctorStaffId: string; scheduledStart: string; reason?: string; type?: "NEW" | "FOLLOW_UP" },
) {
  if (!scope.isSelf) throw new NotFoundError();
  const start = new Date(input.scheduledStart);
  if (Number.isNaN(start.getTime())) throw new BadRequestError("A valid appointment time is required.");
  if (start.getTime() < Date.now()) throw new BadRequestError("Appointment time must be in the future.");

  const staff = await prisma.hospitalStaffProfile.findUnique({
    where: { id: input.doctorStaffId },
    include: { scheduleBlocks: { where: { type: "CLINIC_SESSION" }, take: 1 } },
  });
  // 404-shaped: don't reveal whether the id exists in another facility.
  if (!staff || staff.facilityId !== scope.facilityId || staff.status !== "ACTIVE") throw new NotFoundError();

  const slotMinutes = staff.scheduleBlocks[0]?.slotDurationMinutes ?? DEFAULT_SLOT_MINUTES;
  const end = new Date(start.getTime() + slotMinutes * 60_000);

  return bookAppointment({
    facilityId: scope.facilityId,
    departmentId: staff.departmentId ?? undefined,
    doctorStaffId: staff.id,
    patientId: scope.patientId,
    type: input.type ?? "NEW",
    source: "APPOINTMENT",
    scheduledStart: start,
    scheduledEnd: end,
    reason: input.reason,
    // Free-text provenance marker: a patient self-booking has no staff creator.
    createdByStaffId: `patient:${actorUserId}`,
    byUserId: actorUserId,
  });
}

/** Ownership-checked cancellation. Verifies the appointment belongs to the caller BEFORE mutating. */
export async function cancelPatientAppointment(
  scope: PatientAccessScope,
  actorUserId: string,
  appointmentId: string,
  reason: string,
) {
  if (!scope.isSelf) throw new NotFoundError();
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, select: { patientId: true, status: true } });
  // Not ours (or nonexistent) => 404-shaped, indistinguishable.
  if (!appt || !scope.patientIds.includes(appt.patientId)) throw new NotFoundError();
  if (!CANCELLABLE.includes(appt.status)) throw new BadRequestError("This appointment can no longer be cancelled.");
  return cancelAppointment(appointmentId, reason || "Cancelled by patient", `patient:${actorUserId}`, actorUserId);
}

/**
 * Reschedule = book the new slot (with full conflict protection) THEN release the
 * old one. Ordered so a booking conflict never leaves the patient with no
 * appointment at all. Both steps are ownership-checked.
 */
export async function reschedulePatientAppointment(
  scope: PatientAccessScope,
  actorUserId: string,
  appointmentId: string,
  newStart: string,
) {
  if (!scope.isSelf) throw new NotFoundError();
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt || !scope.patientIds.includes(appt.patientId)) throw new NotFoundError();
  if (!CANCELLABLE.includes(appt.status)) throw new BadRequestError("This appointment can no longer be rescheduled.");

  const created = await requestAppointment(scope, actorUserId, {
    doctorStaffId: appt.doctorStaffId,
    scheduledStart: newStart,
    reason: appt.reason ?? undefined,
    type: appt.type === "FOLLOW_UP" ? "FOLLOW_UP" : "NEW",
  });
  await cancelAppointment(appointmentId, "Rescheduled by patient", `patient:${actorUserId}`, actorUserId);
  return created;
}
