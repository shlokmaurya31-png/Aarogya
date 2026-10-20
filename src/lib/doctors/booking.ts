import type { ConsultMode } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { bookAppointmentTx, cancelAppointment } from "@/lib/hospital/appointment";
import { requireOwnedPerson } from "@/lib/person/access";
import { connectFacilityRecord } from "@/lib/patient/selfRegistration";
import { DEFAULT_SHARE_CATEGORIES, parseShareChoice } from "@/lib/sharing/categories";
import { activeLinkedPatients, createShareTx, endShareTx } from "@/lib/sharing/shares";
import { locationSlots } from "./directory";
import { isSameHuman } from "./self";

/**
 * Week 5a — booking through the directory (docs/DOCTOR_NETWORK_DESIGN.md §7).
 *   1. The patient (their own login) picks a location, a mode and a slot the
 *      engine offers live. Only a VERIFIED, listed doctor at an active location.
 *   2. If they have no record at that facility, one is created from their
 *      Person (connectFacilityRecord: SELF_CREATED, their own action). If a
 *      record there might already be theirs, the booking waits for that link
 *      to be verified: no guessing.
 *   3. bookAppointmentTx books under the doctor's lock (the double-booking
 *      guard), in one transaction with the DirectoryBooking and, if the patient
 *      chose to, a BOOKING share for that doctor: their categories (default:
 *      every non-sensitive one, uploads included, not clinical notes),
 *      sensitive opt-ins and period; valid from 24 hours before the slot to
 *      24 hours after it, and ended if the appointment is cancelled.
 * A doctor can't be booked by their own patient login (the same human).
 */
export const SHARE_WINDOW_MS = 24 * 3_600_000;

export async function bookThroughDirectory(userId: string, body: Record<string, unknown> | null) {
  const b = body ?? {};
  const personId = await requireOwnedPerson(userId);
  const loc = await prisma.practiceLocation.findUnique({ where: { id: String(b.locationId ?? "") }, include: { doctor: true } });
  if (!loc || !loc.active || loc.doctor.verificationStatus !== "VERIFIED" || !loc.doctor.listed) throw new NotFoundError();
  const mode = (b.mode ?? "IN_PERSON") as ConsultMode;
  if (!loc.modes.includes(mode)) throw new BadRequestError("This doctor doesn't offer that kind of visit here.");
  if (await isSameHuman(loc.doctor, personId)) throw new BadRequestError("You can't book an appointment with yourself.");
  const start = new Date(String(b.start ?? ""));
  if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) throw new BadRequestError("Choose a time in the future.");
  const slot = (await locationSlots(loc.id, start)).find((s) => Date.parse(s.start) === start.getTime());
  if (!slot) throw new ConflictError("That time is no longer free. Choose another.");
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 280) || undefined : undefined;
  const wantsShare = b.share !== undefined && b.share !== null && b.share !== false;
  const choice = wantsShare ? parseShareChoice(typeof b.share === "object" ? (b.share as Record<string, unknown>) : {}, { categories: DEFAULT_SHARE_CATEGORIES }) : null;

  // The person's record at that facility: an ACTIVE link, or a new one from their Person.
  let link = await prisma.personPatientLink.findFirst({ where: { personId, facilityId: loc.facilityId, status: "ACTIVE" }, select: { patientId: true } });
  if (!link) {
    const person = await prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { displayName: true, sex: true, dateOfBirth: true } });
    const connected = await connectFacilityRecord(userId, { facilityId: loc.facilityId, fullName: person.displayName, sex: person.sex ?? "U", dob: person.dateOfBirth ?? undefined });
    if (connected.status !== "LINKED_NEW") throw new ConflictError("You may already have a record at this hospital. Verify it from your profile first, then book.");
    link = { patientId: connected.patientId };
  }
  const end = new Date(slot.end);
  const result = await prisma.$transaction(async (tx) => {
    const appt = await bookAppointmentTx(tx, {
      facilityId: loc.facilityId, doctorStaffId: loc.staffId, patientId: link!.patientId, type: mode === "VIDEO" ? "TELEMEDICINE" : "NEW", source: "APPOINTMENT",
      scheduledStart: start, scheduledEnd: end, reason, createdByStaffId: `patient:${userId}`, byUserId: userId, requireFacilityId: loc.facilityId,
    });
    let shareId: string | null = null;
    if (choice) {
      const share = await createShareTx(tx, {
        personId, kind: "BOOKING", status: "ACTIVE", choice, patientIds: await activeLinkedPatients(personId, tx), validFrom: new Date(start.getTime() - SHARE_WINDOW_MS),
        expiresAt: new Date(end.getTime() + SHARE_WINDOW_MS), createdByUserId: userId, recipientUserId: loc.doctor.userId, recipientFacilityId: loc.facilityId,
      });
      shareId = share.id;
    }
    const booking = await tx.directoryBooking.create({ data: { appointmentId: appt.id, personId, practiceLocationId: loc.id, doctorId: loc.doctorId, mode, shareId, createdByUserId: userId } });
    await emitDomainEvent(tx, {
      type: "DirectoryBookingCreated", aggregateId: booking.id, personId, actorUserId: userId,
      payload: { bookingId: booking.id, personId, appointmentId: appt.id, doctorId: loc.doctorId, locationId: loc.id, mode, ...(shareId ? { shareId } : {}) },
    });
    return { appointmentId: appt.id, bookingId: booking.id, shareId, start: start.toISOString(), end: end.toISOString(), mode };
  });
  await recordAuditEvent("doctor.directory.booked", userId, { bookingId: result.bookingId, locationId: loc.id, shared: !!result.shareId });
  return result;
}

/** The patient's own directory bookings. */
export async function listOwnDirectoryBookings(userId: string) {
  const personId = await requireOwnedPerson(userId);
  const rows = await prisma.directoryBooking.findMany({ where: { personId }, orderBy: { createdAt: "desc" }, take: 50 });
  const appts = await prisma.appointment.findMany({ where: { id: { in: rows.map((r) => r.appointmentId) } }, select: { id: true, scheduledStart: true, status: true } });
  const doctors = await prisma.doctorProfile.findMany({ where: { id: { in: rows.map((r) => r.doctorId) } }, select: { id: true, displayName: true } });
  return rows.map((r) => {
    const a = appts.find((x) => x.id === r.appointmentId);
    return { id: r.id, appointmentId: r.appointmentId, doctorName: doctors.find((d) => d.id === r.doctorId)?.displayName ?? "Doctor", mode: r.mode, shareId: r.shareId, start: a?.scheduledStart.toISOString() ?? null, status: a?.status ?? null };
  });
}

/** The patient cancels a directory booking (the share ends through share-lifecycle). */
export async function cancelOwnDirectoryBooking(userId: string, bookingId: string) {
  const personId = await requireOwnedPerson(userId);
  const b = await prisma.directoryBooking.findUnique({ where: { id: bookingId } });
  if (!b || b.personId !== personId) throw new NotFoundError();
  await cancelAppointment(b.appointmentId, "Cancelled by patient", `patient:${userId}`, userId);
  return { status: "CANCELLED" as const };
}

/** The doctor's directory bookings that carry a share, for the visit brief. */
export async function doctorSharedBookings(doctorUserId: string, facilityId: string) {
  const d = await prisma.doctorProfile.findUnique({ where: { userId: doctorUserId }, select: { id: true } });
  if (!d) return [];
  const rows = await prisma.directoryBooking.findMany({ where: { doctorId: d.id, shareId: { not: null } }, orderBy: { createdAt: "desc" }, take: 50 });
  const appts = await prisma.appointment.findMany({ where: { id: { in: rows.map((r) => r.appointmentId) }, facilityId }, select: { id: true, scheduledStart: true, status: true, patient: { select: { fullName: true } } } });
  return rows.flatMap((r) => {
    const a = appts.find((x) => x.id === r.appointmentId);
    return a ? [{ bookingId: r.id, shareId: r.shareId!, appointmentId: a.id, start: a.scheduledStart.toISOString(), status: a.status, patientName: a.patient.fullName, mode: r.mode }] : [];
  });
}

/** share-lifecycle: a booking's share ends when its appointment is cancelled. */
export const shareLifecycle: DomainEventConsumer = {
  name: "share-lifecycle",
  handles: ["AppointmentCancelled"],
  async handle(event) {
    const appointmentId = String((event.payload as { appointmentId?: string }).appointmentId ?? "");
    const b = await prisma.directoryBooking.findUnique({ where: { appointmentId }, select: { shareId: true } });
    if (!b?.shareId) return;
    await prisma.$transaction((tx) => endShareTx(tx, b.shareId!, "REVOKED", "APPOINTMENT_CANCELLED", event.actorUserId));
  },
};
