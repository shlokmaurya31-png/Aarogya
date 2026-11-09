import type { AppointmentStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { isValidTimeZone } from "@/lib/time/zone";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";
import { notifyPersonAndProxiesTx } from "@/lib/insurance/claimDocuments";

/**
 * Flagship 3b — changing a facility's time zone (docs/PRE_LAUNCH_CHECKLIST.md
 * item 25, decided 2026-11-08).
 *
 *   Request    the hospital admin asks in writing (the zone, and why);
 *              audited, FacilityTimeZoneChangeRequested. One open request per
 *              facility.
 *   Decision   platform staff only (AAROGYA_ADMIN): approve or reject, with a
 *              note; audited, its own event. Approval is refused while the
 *              facility has future bookings unless the approver confirms
 *              them; then the zone changes (FacilityTimeZoneChanged) and every
 *              affected booking is told: the patient (and their proxies who
 *              book) in the app, and the booking's doctor.
 *
 * A booking keeps its instant: nothing is moved, only how the facility's
 * clock reads it changes (moving bookings would be guessing what each patient
 * was told).
 */

export interface HospitalAdminActor { userId: string; facilityId: string }
export interface PlatformActor { userId: string }

/** Bookings still to happen. */
const LIVE_BOOKINGS: AppointmentStatus[] = ["REQUESTED", "CONFIRMED", "RESCHEDULED", "ARRIVED", "CHECKED_IN", "WAITING"];
const MIN_REQUEST_CHARS = 20;

/** The approval needs `confirmFutureAppointments: true` (409, with the count). */
export class FutureAppointmentsError extends ConflictError {
  constructor(readonly futureAppointments: number) {
    super(`${futureAppointments} future booking(s) at this facility would be read in the new time zone. Confirm them to approve; each will be notified.`);
  }
}

const futureBookingsWhere = (facilityId: string, now: Date) => ({ facilityId, status: { in: LIVE_BOOKINGS }, scheduledStart: { gt: now } });

export async function requestTimeZoneChange(admin: HospitalAdminActor, body: { timeZone?: unknown; writtenRequest?: unknown }) {
  const toTimeZone = typeof body.timeZone === "string" ? body.timeZone.trim() : "";
  if (!isValidTimeZone(toTimeZone)) throw new BadRequestError("timeZone must be an IANA time zone, e.g. \"Asia/Kolkata\".");
  const writtenRequest = typeof body.writtenRequest === "string" ? body.writtenRequest.trim().slice(0, 2000) : "";
  if (writtenRequest.length < MIN_REQUEST_CHARS) throw new BadRequestError(`The written request (why, and who asked) needs at least ${MIN_REQUEST_CHARS} characters.`);
  const facility = await prisma.facility.findUniqueOrThrow({ where: { id: admin.facilityId }, select: { timeZone: true } });
  if (facility.timeZone === toTimeZone) throw new BadRequestError("The facility already uses this time zone.");
  try {
    const r = await prisma.$transaction(async (tx) => {
      const r = await tx.facilityTimeZoneChange.create({ data: { facilityId: admin.facilityId, fromTimeZone: facility.timeZone, toTimeZone, writtenRequest, requestedByUserId: admin.userId } });
      await emitFacilityEvent(tx, { type: "FacilityTimeZoneChangeRequested", aggregateId: r.id, facilityId: admin.facilityId, actorUserId: admin.userId, payload: { requestId: r.id, facilityId: admin.facilityId, fromTimeZone: r.fromTimeZone, toTimeZone } });
      return r;
    });
    await recordAuditEvent("hospital.facility.time-zone.requested", admin.userId, { requestId: r.id, fromTimeZone: r.fromTimeZone, toTimeZone, writtenRequest }, { facilityId: admin.facilityId });
    return r;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new ConflictError("This facility already has a time-zone change waiting for a decision.");
    throw e;
  }
}

/** The facility's own requests (the hospital admin), newest first. */
export async function listFacilityTimeZoneChanges(facilityId: string) {
  return prisma.facilityTimeZoneChange.findMany({ where: { facilityId }, orderBy: { requestedAt: "desc" }, take: 50 });
}

/** Every facility's open requests (platform staff), oldest first, with each facility's future bookings now. */
export async function listOpenTimeZoneChanges(now = new Date()) {
  const rows = await prisma.facilityTimeZoneChange.findMany({ where: { status: "REQUESTED" }, orderBy: { requestedAt: "asc" }, take: 200 });
  return Promise.all(rows.map(async (r) => ({ ...r, futureAppointmentsNow: await prisma.appointment.count({ where: futureBookingsWhere(r.facilityId, now) }) })));
}

export async function decideTimeZoneChange(
  platform: PlatformActor, requestId: string,
  body: { decision?: unknown; note?: unknown; confirmFutureAppointments?: unknown },
  opts: { now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const decision = body.decision === "APPROVE" || body.decision === "REJECT" ? body.decision : null;
  if (!decision) throw new BadRequestError("decision must be APPROVE or REJECT.");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
  if (!note) throw new BadRequestError("A note on the decision is required.");
  const r = await prisma.facilityTimeZoneChange.findUnique({ where: { id: requestId } });
  if (!r) throw new NotFoundError("Request not found.");
  if (r.status !== "REQUESTED") throw new ConflictError("This request has already been decided.");

  if (decision === "REJECT") {
    const done = await prisma.$transaction(async (tx) => {
      const u = await tx.facilityTimeZoneChange.updateMany({ where: { id: r.id, status: "REQUESTED" }, data: { status: "REJECTED", decidedByUserId: platform.userId, decidedAt: now, decisionNote: note } });
      if (u.count !== 1) throw new ConflictError("This request has already been decided.");
      await emitFacilityEvent(tx, { type: "FacilityTimeZoneChangeRejected", aggregateId: r.id, facilityId: r.facilityId, actorUserId: platform.userId, payload: { requestId: r.id, facilityId: r.facilityId } });
      return tx.facilityTimeZoneChange.findUniqueOrThrow({ where: { id: r.id } });
    });
    await recordAuditEvent("platform.facility.time-zone.rejected", platform.userId, { requestId: r.id, note }, { facilityId: r.facilityId });
    return { request: done, notified: { bookings: 0, patients: 0, doctors: 0 } };
  }

  const confirm = body.confirmFutureAppointments === true;
  const bookings = await prisma.appointment.findMany({ where: futureBookingsWhere(r.facilityId, now), select: { id: true, patientId: true, doctorStaffId: true } });
  if (bookings.length > 0 && !confirm) throw new FutureAppointmentsError(bookings.length);
  // Each booking's patient's Person (merged patients resolve to the surviving record's link).
  const personOf = new Map<string, string | null>();
  for (const b of bookings) {
    if (personOf.has(b.patientId)) continue;
    const link = await prisma.personPatientLink.findFirst({ where: { patientId: { in: await resolvePatientIdsForRead(b.patientId) }, status: "ACTIVE" }, select: { personId: true } });
    personOf.set(b.patientId, link?.personId ?? null);
  }

  const result = await prisma.$transaction(async (tx) => {
    const u = await tx.facilityTimeZoneChange.updateMany({
      where: { id: r.id, status: "REQUESTED" },
      data: { status: "APPROVED", decidedByUserId: platform.userId, decidedAt: now, decisionNote: note, futureAppointments: bookings.length, confirmedFutureAppointments: confirm },
    });
    if (u.count !== 1) throw new ConflictError("This request has already been decided.");
    // The zone changes only from the one it was requested against.
    const f = await tx.facility.updateMany({ where: { id: r.facilityId, timeZone: r.fromTimeZone }, data: { timeZone: r.toTimeZone } });
    if (f.count !== 1) throw new ConflictError("The facility's time zone changed since the request; ask for a new request.");
    // A booking made in the meantime would be missed by the count above.
    const now2 = await tx.appointment.count({ where: futureBookingsWhere(r.facilityId, now) });
    if (now2 !== bookings.length) throw new ConflictError("Bookings changed while approving; try again.");
    await emitFacilityEvent(tx, {
      type: "FacilityTimeZoneChangeApproved", aggregateId: r.id, facilityId: r.facilityId, actorUserId: platform.userId,
      payload: { requestId: r.id, facilityId: r.facilityId, futureAppointments: bookings.length, confirmedFutureAppointments: confirm },
    });
    await emitFacilityEvent(tx, {
      type: "FacilityTimeZoneChanged", aggregateId: r.facilityId, facilityId: r.facilityId, actorUserId: platform.userId,
      payload: { facilityId: r.facilityId, requestId: r.id, fromTimeZone: r.fromTimeZone, toTimeZone: r.toTimeZone },
    });
    let patients = 0;
    for (const b of bookings) {
      const personId = personOf.get(b.patientId);
      if (personId) {
        await notifyPersonAndProxiesTx(tx, personId, "APPOINTMENT_TIME_ZONE_CHANGED", `APPOINTMENT_TIME_ZONE_CHANGED:${b.id}:${r.id}`, "BOOK");
        patients += 1;
      }
      // The doctor is told of every booking, so a patient who can't be reached in the app is called.
      await tx.notification.create({
        data: {
          facilityId: r.facilityId, recipientStaffId: b.doctorStaffId, type: "APPOINTMENT_TIME_ZONE_CHANGED", category: "ADMINISTRATIVE", priority: personId ? "ROUTINE" : "URGENT",
          title: personId ? "A booking is now read in the facility's new time zone" : "A booking is now read in the new time zone: tell the patient",
          body: `The facility's time zone changed from ${r.fromTimeZone} to ${r.toTimeZone}. The booking keeps its time; check it with the patient${personId ? "" : " (not reachable in the app)"}.`,
          linkHref: "/hospital-os/appointments", patientId: b.patientId, sourceType: "FacilityTimeZoneChange", sourceId: r.id,
        },
      });
    }
    return { request: await tx.facilityTimeZoneChange.findUniqueOrThrow({ where: { id: r.id } }), notified: { bookings: bookings.length, patients, doctors: bookings.length } };
  }, { timeout: 60_000 });
  await recordAuditEvent("platform.facility.time-zone.approved", platform.userId, { requestId: r.id, fromTimeZone: r.fromTimeZone, toTimeZone: r.toTimeZone, futureAppointments: bookings.length, confirmed: confirm, note }, { facilityId: r.facilityId });
  return result;
}
