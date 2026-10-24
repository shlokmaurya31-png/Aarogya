import type { PreArrivalCheckIn, PreArrivalStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { personAccess, ownedPersonId } from "@/lib/person/access";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";
import { maskPhone } from "@/lib/messaging/sms";
import { parseShareChoice, DEFAULT_SHARE_CATEGORIES } from "@/lib/sharing/categories";
import { activeLinkedPatients, createShareTx, endShareTx } from "@/lib/sharing/shares";
import { checkInAppointment } from "@/lib/hospital/appointment";
import { enterQueue } from "@/lib/hospital/queue";
import { istDay } from "@/lib/person/notifications";
import { createCardShareTx, endCardSharesTx } from "./cardShares";
import { cardView } from "./cards";
import { CARD_SHARE_DAYS_AFTER, CHECKIN_CLOSES_HOURS, CHECKIN_OPENS_HOURS, CHECKIN_SHARE_DAYS_AFTER, ELIGIBILITY_TEXT, NEEDS_DESK_REASONS, NEEDS_DESK_TEXT } from "./vocab";

/**
 * Week 5c — pre-arrival check-in (docs/PATIENT_INSURANCE_DESIGN.md §3, §4, §14).
 *
 *   When   a booked visit (REQUESTED, CONFIRMED or RESCHEDULED) or a planned
 *          admission (an admission request with plannedAdmissionAt, PENDING
 *          or BED_RESERVED): from 24 hours before until 1 hour before.
 *   Who    the patient (their Person's ACTIVE link to the record), or a
 *          household proxy with BOOK (and INSURANCE to attach a card).
 *   What   confirm the details (read-only; a mismatch goes to the desk),
 *          optionally a record share for the visit's doctor (a booking's
 *          share is reused) and an insurance card (a card share for this
 *          facility, for this visit), or "I'll pay myself"; then a token.
 *   Never  waits for the insurer: eligibility is PENDING until staff verify
 *          the card (cardShares.ts verifyCheckInCard).
 * The desk sees pre-registered patients with their token; arrival runs the
 * existing check-in and puts a READY patient straight in the doctor's queue
 * (NEEDS_DESK: the registration queue first). A visit cancelled or missed
 * lapses the check-in, ending its shares. Every transition emits its event.
 */
type Tx = Prisma.TransactionClient;
const HOUR = 3_600_000;
const OPEN_STATUSES: PreArrivalStatus[] = ["SUBMITTED", "READY", "NEEDS_DESK"];
const BOOKABLE_APPOINTMENT = ["REQUESTED", "CONFIRMED", "RESCHEDULED"];
const PLANNED_ADMISSION = ["PENDING", "BED_RESERVED"];

export function checkInWindow(start: Date) {
  return { opensAt: new Date(start.getTime() - CHECKIN_OPENS_HOURS * HOUR), closesAt: new Date(start.getTime() - CHECKIN_CLOSES_HOURS * HOUR) };
}
export function windowOpen(start: Date, at = new Date()) {
  const w = checkInWindow(start);
  return at >= w.opensAt && at < w.closesAt;
}

export interface CheckInActorRef { userId: string; memberPersonId?: string }

/** The Person checking in: the caller's own, or a member they hold BOOK for. */
async function subject(a: CheckInActorRef): Promise<{ personId: string; actorPersonId: string; via: "OWNER" | "PROXY"; canInsurance: boolean }> {
  if (a.memberPersonId) {
    const g = await personAccess({ kind: "PROXY", userId: a.userId, permission: "BOOK" }, a.memberPersonId, "PROFILE");
    if (!g?.proxy) throw new NotFoundError();
    const ins = await personAccess({ kind: "PROXY", userId: a.userId, permission: "INSURANCE" }, a.memberPersonId, "INSURANCE");
    return { personId: a.memberPersonId, actorPersonId: g.proxy.proxyPersonId, via: "PROXY", canInsurance: !!ins };
  }
  const personId = await ownedPersonId(a.userId);
  if (!personId || !(await personAccess({ kind: "OWNER", userId: a.userId }, personId, "PROFILE"))) throw new NotFoundError();
  return { personId, actorPersonId: personId, via: "OWNER", canInsurance: true };
}

/** The Person's facility records (merge-aware). */
async function personPatientIds(personId: string) {
  const links = await activeLinkedPatients(personId);
  return [...new Set((await Promise.all(links.map((p) => resolvePatientIdsForRead(p)))).flat())];
}

interface Visit {
  kind: "APPOINTMENT" | "ADMISSION"; id: string; facilityId: string; patientId: string; start: Date; end: Date;
  /** Who a check-in share is for: the visit's doctor, or the doctor who asked for the admission. */
  recipientUserId: string; doctorStaffId: string | null; departmentId: string | null; open: boolean; label: string;
}

async function visitOf(body: { appointmentId?: unknown; admissionRequestId?: unknown }): Promise<Visit> {
  if (typeof body.appointmentId === "string") {
    const a = await prisma.appointment.findUnique({ where: { id: body.appointmentId }, include: { doctor: { select: { userId: true, user: { select: { displayName: true } } } }, facility: { select: { name: true } } } });
    if (!a) throw new NotFoundError();
    return { kind: "APPOINTMENT", id: a.id, facilityId: a.facilityId, patientId: a.patientId, start: a.scheduledStart, end: a.scheduledEnd, recipientUserId: a.doctor.userId, doctorStaffId: a.doctorStaffId, departmentId: a.departmentId, open: BOOKABLE_APPOINTMENT.includes(a.status), label: `${a.doctor.user.displayName} · ${a.facility.name}` };
  }
  if (typeof body.admissionRequestId === "string") {
    const r = await prisma.admissionRequest.findUnique({ where: { id: body.admissionRequestId }, include: { requestedBy: { select: { userId: true } }, facility: { select: { name: true } } } });
    if (!r || !r.plannedAdmissionAt) throw new NotFoundError();
    return { kind: "ADMISSION", id: r.id, facilityId: r.facilityId, patientId: r.patientId, start: r.plannedAdmissionAt, end: r.plannedAdmissionAt, recipientUserId: r.requestedBy.userId, doctorStaffId: r.requestedByStaffId, departmentId: r.departmentId, open: PLANNED_ADMISSION.includes(r.status), label: `Planned admission · ${r.facility.name}` };
  }
  throw new BadRequestError("appointmentId or admissionRequestId is required.");
}

async function ownVisit(a: CheckInActorRef, body: { appointmentId?: unknown; admissionRequestId?: unknown }) {
  const s = await subject(a);
  const v = await visitOf(body);
  if (!(await personPatientIds(s.personId)).includes(v.patientId)) throw new NotFoundError();
  return { s, v };
}

async function existingCheckIn(v: Visit) {
  return prisma.preArrivalCheckIn.findFirst({ where: v.kind === "APPOINTMENT" ? { appointmentId: v.id } : { admissionRequestId: v.id } });
}

/** What the check-in screen shows: the facility's details to confirm (read-only), the window, the cards, any existing check-in. */
export async function checkInOptions(a: CheckInActorRef, body: { appointmentId?: unknown; admissionRequestId?: unknown }) {
  const { s, v } = await ownVisit(a, body);
  const p = await prisma.patient.findUniqueOrThrow({ where: { id: v.patientId }, select: { fullName: true, dob: true, phone: true, uhid: true } });
  const booking = v.kind === "APPOINTMENT" ? await prisma.directoryBooking.findUnique({ where: { appointmentId: v.id }, select: { shareId: true } }) : null;
  const cards = s.canInsurance ? (await prisma.insuranceCard.findMany({ where: { personId: s.personId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } })).map(cardView) : [];
  const ci = await existingCheckIn(v);
  return {
    visit: { kind: v.kind, id: v.id, start: v.start.toISOString(), label: v.label, ...checkInWindow(v.start), open: v.open && windowOpen(v.start) },
    details: { name: p.fullName, dateOfBirth: p.dob?.toISOString().slice(0, 10) ?? null, phone: p.phone ? maskPhone(p.phone) : null, uhid: p.uhid },
    bookingShare: !!booking?.shareId, cards, canAttachCard: s.canInsurance,
    checkIn: ci ? checkInView(ci) : null,
  };
}

export function checkInView(ci: PreArrivalCheckIn) {
  return {
    id: ci.id, status: ci.status, token: ci.token, eligibility: ci.eligibility, eligibilityText: ELIGIBILITY_TEXT[ci.eligibility],
    needsDesk: ci.needsDeskReason ? NEEDS_DESK_TEXT[ci.needsDeskReason as (typeof NEEDS_DESK_REASONS)[number]] ?? null : null,
    hasShare: !!ci.shareId, hasCard: !!ci.cardShareId, submittedAt: ci.submittedAt.toISOString(), arrivedAt: ci.arrivedAt?.toISOString() ?? null,
  };
}

async function nextToken(tx: Tx, facilityId: string, tokenDay: string) {
  const n = await tx.preArrivalCheckIn.count({ where: { facilityId, tokenDay } });
  return `P-${String(n + 1).padStart(3, "0")}`;
}

/**
 * Submits the check-in: the details confirmed (or a mismatch flagged), the
 * share and the card as chosen, a token. One per visit.
 */
export async function submitPreArrival(a: CheckInActorRef, body: Record<string, unknown>) {
  const { s, v } = await ownVisit(a, body);
  if (!v.open || !windowOpen(v.start)) throw new ConflictError(`Check-in opens ${CHECKIN_OPENS_HOURS} hours before and closes ${CHECKIN_CLOSES_HOURS} hour before the visit.`);
  if (body.detailsConfirmed !== true && body.detailsMismatch !== true) throw new BadRequestError("Confirm your details, or tell us something is wrong.");
  const cardId = typeof body.cardId === "string" ? body.cardId : null;
  if (cardId && !s.canInsurance) throw new NotFoundError();
  if (!cardId && body.selfPay !== true) throw new BadRequestError("Choose an insurance card, or that you'll pay yourself.");
  const wantsShare = body.share !== undefined && body.share !== null && body.share !== false;
  if (wantsShare && s.via === "PROXY") {
    const sh = await personAccess({ kind: "PROXY", userId: a.userId, permission: "SHARE" }, s.personId, "PROFILE");
    if (!sh?.proxy) throw new NotFoundError();
  }
  const choice = wantsShare ? parseShareChoice(typeof body.share === "object" ? (body.share as Record<string, unknown>) : {}, { categories: DEFAULT_SHARE_CATEGORIES }) : null;
  const booking = v.kind === "APPOINTMENT" ? await prisma.directoryBooking.findUnique({ where: { appointmentId: v.id }, select: { shareId: true } }) : null;
  const tokenDay = istDay(v.start).day;
  for (let attempt = 0; ; attempt++) {
    try {
      const ci = await prisma.$transaction(async (tx) => {
        if (await tx.preArrivalCheckIn.findFirst({ where: v.kind === "APPOINTMENT" ? { appointmentId: v.id } : { admissionRequestId: v.id }, select: { id: true } })) throw new ConflictError("You've already checked in for this visit.");
        let shareId: string | null = null;
        if (choice && !booking?.shareId) {
          const share = await createShareTx(tx, {
            personId: s.personId, kind: "CHECKIN", status: "ACTIVE", choice, patientIds: await activeLinkedPatients(s.personId, tx), createdByUserId: a.userId,
            recipientUserId: v.recipientUserId, recipientFacilityId: v.facilityId, expiresAt: new Date(v.end.getTime() + CHECKIN_SHARE_DAYS_AFTER * 24 * HOUR),
          });
          shareId = share.id;
        }
        const mismatch = body.detailsConfirmed !== true;
        const created = await tx.preArrivalCheckIn.create({
          data: {
            facilityId: v.facilityId, kind: v.kind, appointmentId: v.kind === "APPOINTMENT" ? v.id : null, admissionRequestId: v.kind === "ADMISSION" ? v.id : null,
            patientId: v.patientId, personId: s.personId, status: mismatch ? "NEEDS_DESK" : "SUBMITTED", needsDeskReason: mismatch ? "DETAILS_MISMATCH" : null,
            eligibility: cardId ? "PENDING" : "SELF_PAY", token: await nextToken(tx, v.facilityId, tokenDay), tokenDay, shareId, submittedByPersonId: s.actorPersonId,
          },
        });
        let cardShareId: string | null = null;
        if (cardId) {
          const cs = await createCardShareTx(tx, { cardId, personId: s.personId, facilityId: v.facilityId, expiresAt: new Date(v.end.getTime() + CARD_SHARE_DAYS_AFTER * 24 * HOUR), createdByPersonId: s.actorPersonId, userId: a.userId });
          await tx.cardShare.update({ where: { id: cs.id }, data: { checkInId: created.id } });
          cardShareId = cs.id;
        }
        const ci = cardShareId ? await tx.preArrivalCheckIn.update({ where: { id: created.id }, data: { cardShareId } }) : created;
        await emitFacilityEvent(tx, {
          type: "PreArrivalCheckInSubmitted", aggregateId: ci.id, facilityId: ci.facilityId, actorUserId: a.userId, personId: s.personId,
          payload: {
            checkInId: ci.id, kind: ci.kind, patientId: ci.patientId, ...(ci.appointmentId ? { appointmentId: ci.appointmentId } : {}), ...(ci.admissionRequestId ? { admissionRequestId: ci.admissionRequestId } : {}),
            status: ci.status, eligibility: ci.eligibility, hasShare: !!(shareId || booking?.shareId), hasInsurance: !!cardShareId,
          },
        });
        if (s.via === "PROXY") await tx.personAccessLogEntry.create({ data: { personId: s.personId, kind: "PROXY_ACTION", actorUserId: a.userId, detail: { via: "PROXY", proxyPersonId: s.actorPersonId, action: "PRE_ARRIVAL_CHECKIN", checkInId: ci.id } } });
        return ci;
      });
      await recordAuditEvent("patient.checkin.submitted", a.userId, { checkInId: ci.id, via: s.via }, { facilityId: ci.facilityId, patientId: ci.patientId });
      return checkInView(ci);
    } catch (err) {
      // Two check-ins at once for the same facility and day: the token is taken; try the next one.
      if ((err as { code?: string }).code === "P2002" && attempt < 5) continue;
      throw err;
    }
  }
}

/** The patient's own check-ins (or a member's, for a proxy with BOOK), with token and plain-language status. */
export async function myCheckIns(a: CheckInActorRef) {
  const s = await subject(a);
  const rows = await prisma.preArrivalCheckIn.findMany({ where: { personId: s.personId }, orderBy: { submittedAt: "desc" }, take: 20 });
  return { checkIns: rows.map(checkInView) };
}

async function moveTx(tx: Tx, ci: PreArrivalCheckIn, to: PreArrivalStatus, actorUserId: string | null, extra: Partial<PreArrivalCheckIn> = {}): Promise<boolean> {
  const r = await tx.preArrivalCheckIn.updateMany({ where: { id: ci.id, status: ci.status, version: ci.version }, data: { ...extra, status: to, version: { increment: 1 } } as never });
  if (r.count !== 1) return false;
  await emitFacilityEvent(tx, {
    type: "PreArrivalCheckInStatusChanged", aggregateId: ci.id, facilityId: ci.facilityId, actorUserId, personId: ci.personId,
    payload: { checkInId: ci.id, patientId: ci.patientId, from: ci.status, to, ...((extra.needsDeskReason ?? null) ? { needsDeskReason: extra.needsDeskReason as never } : {}) },
  });
  if (to === "LAPSED" || to === "CANCELLED") {
    if (ci.shareId) await endShareTx(tx, ci.shareId, "REVOKED", "CHECKIN_ENDED", actorUserId);
    if (ci.cardShareId) await endCardSharesTx(tx, { id: ci.cardShareId }, `CHECKIN_${to}`, actorUserId);
  }
  return true;
}

/** The patient (or their proxy) cancels their check-in: its shares end. */
export async function cancelPreArrival(a: CheckInActorRef, checkInId: string) {
  const s = await subject(a);
  const ci = await prisma.preArrivalCheckIn.findUnique({ where: { id: checkInId } });
  if (!ci || ci.personId !== s.personId) throw new NotFoundError();
  if (!OPEN_STATUSES.includes(ci.status)) throw new ConflictError("This check-in is already closed.");
  if (!(await prisma.$transaction((tx) => moveTx(tx, ci, "CANCELLED", a.userId)))) throw new ConflictError("This check-in changed in the meantime.");
  return { status: "CANCELLED" as const };
}

// ── The desk ─────────────────────────────────────────────────────────────

/** Pre-registered patients for a day (default: today, India time): the token, who, when, and what is left to do. */
export async function preRegistered(facilityId: string, day?: string) {
  const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : istDay(new Date()).day;
  const rows = await prisma.preArrivalCheckIn.findMany({ where: { facilityId, tokenDay: d }, orderBy: { token: "asc" }, take: 300 });
  const patients = await prisma.patient.findMany({ where: { id: { in: rows.map((r) => r.patientId) } }, select: { id: true, fullName: true, uhid: true } });
  const appts = await prisma.appointment.findMany({ where: { id: { in: rows.map((r) => r.appointmentId).filter((x): x is string => !!x) } }, select: { id: true, scheduledStart: true, doctor: { select: { user: { select: { displayName: true } } } } } });
  return {
    day: d,
    checkIns: rows.map((r) => {
      const p = patients.find((x) => x.id === r.patientId);
      const ap = appts.find((x) => x.id === r.appointmentId);
      return {
        id: r.id, token: r.token, status: r.status, kind: r.kind, patientName: p?.fullName ?? "", uhid: p?.uhid ?? "", at: ap?.scheduledStart.toISOString() ?? null, doctor: ap?.doctor.user.displayName ?? null,
        eligibility: r.eligibility, hasCard: !!r.cardShareId, hasShare: !!r.shareId, needsDeskReason: r.needsDeskReason, cardShareId: r.cardShareId,
      };
    }),
  };
}

/** The desk marks a check-in READY (straight to the doctor) or NEEDS_DESK (with a reason). */
export async function deskDecide(staff: { userId: string; facilityId: string }, checkInId: string, body: { status?: unknown; reason?: unknown }) {
  const ci = await prisma.preArrivalCheckIn.findUnique({ where: { id: checkInId } });
  if (!ci || ci.facilityId !== staff.facilityId) throw new NotFoundError();
  if (!OPEN_STATUSES.includes(ci.status)) throw new ConflictError("This check-in is closed.");
  if (body.status === "READY") {
    if (!(await prisma.$transaction((tx) => moveTx(tx, ci, "READY", staff.userId, { needsDeskReason: null, decidedByUserId: staff.userId, decidedAt: new Date() })))) throw new ConflictError("This check-in changed in the meantime.");
  } else if (body.status === "NEEDS_DESK") {
    if (!(NEEDS_DESK_REASONS as readonly unknown[]).includes(body.reason)) throw new BadRequestError(`reason must be one of ${NEEDS_DESK_REASONS.join(", ")}.`);
    if (!(await prisma.$transaction((tx) => moveTx(tx, ci, "NEEDS_DESK", staff.userId, { needsDeskReason: body.reason as string, decidedByUserId: staff.userId, decidedAt: new Date() })))) throw new ConflictError("This check-in changed in the meantime.");
  } else throw new BadRequestError("status must be READY or NEEDS_DESK.");
  await recordAuditEvent("hospital.checkin.decided", staff.userId, { checkInId: ci.id, status: body.status }, { facilityId: ci.facilityId, patientId: ci.patientId });
  return checkInView((await prisma.preArrivalCheckIn.findUniqueOrThrow({ where: { id: ci.id } })));
}

/**
 * The patient arrived (the desk scans or finds the token): a visit's check-in
 * runs the existing check-in (PatientCheckedIn) and enters a queue: READY
 * straight to the doctor's, otherwise registration first. A planned
 * admission continues through the admission desk.
 */
export async function markArrived(staff: { userId: string; facilityId: string; staffId?: string }, checkInId: string) {
  const ci = await prisma.preArrivalCheckIn.findUnique({ where: { id: checkInId } });
  if (!ci || ci.facilityId !== staff.facilityId) throw new NotFoundError();
  if (!OPEN_STATUSES.includes(ci.status)) throw new ConflictError("This check-in is closed.");
  let queueType: string | null = null;
  if (ci.kind === "APPOINTMENT" && ci.appointmentId) {
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: ci.appointmentId } });
    const { encounterId } = await checkInAppointment(ci.appointmentId, staff.userId);
    queueType = ci.status === "READY" ? "OPD_DOCTOR" : "REGISTRATION";
    await enterQueue({
      facilityId: ci.facilityId, departmentId: appt.departmentId ?? undefined, queueType, patientId: ci.patientId, encounterId: encounterId ?? undefined, appointmentId: appt.id,
      practitionerStaffId: queueType === "OPD_DOCTOR" ? appt.doctorStaffId : undefined, createdByStaffId: staff.staffId, byUserId: staff.userId,
    });
  }
  if (!(await prisma.$transaction((tx) => moveTx(tx, ci, "ARRIVED", staff.userId, { arrivedAt: new Date() })))) throw new ConflictError("This check-in changed in the meantime.");
  await recordAuditEvent("hospital.checkin.arrived", staff.userId, { checkInId: ci.id, queueType }, { facilityId: ci.facilityId, patientId: ci.patientId });
  return { status: "ARRIVED" as const, queueType, token: ci.token };
}

// ── Lapsing ──────────────────────────────────────────────────────────────

async function lapseFor(where: Prisma.PreArrivalCheckInWhereInput, actorUserId: string | null) {
  const rows = await prisma.preArrivalCheckIn.findMany({ where: { ...where, status: { in: OPEN_STATUSES } } });
  let n = 0;
  for (const ci of rows) if (await prisma.$transaction((tx) => moveTx(tx, ci, "LAPSED", actorUserId))) n += 1;
  return n;
}

/** checkin-lifecycle: a visit cancelled or missed, or an admission request rejected or cancelled, lapses its check-in. */
export const checkInLifecycle: DomainEventConsumer = {
  name: "checkin-lifecycle",
  handles: ["AppointmentCancelled", "AppointmentStatusChanged", "AdmissionRequestStatusChanged"],
  async handle(event) {
    const p = event.payload as { appointmentId?: string; admissionRequestId?: string; to?: string };
    if (event.eventType === "AppointmentCancelled" && p.appointmentId) await lapseFor({ appointmentId: p.appointmentId }, event.actorUserId);
    else if (event.eventType === "AppointmentStatusChanged" && p.to === "NO_SHOW" && p.appointmentId) await lapseFor({ appointmentId: p.appointmentId }, event.actorUserId);
    else if (event.eventType === "AdmissionRequestStatusChanged" && (p.to === "REJECTED" || p.to === "CANCELLED") && p.admissionRequestId) await lapseFor({ admissionRequestId: p.admissionRequestId }, event.actorUserId);
  },
};

/** Runner sweep: a check-in still open 12 hours after its visit's day began lapses (nobody arrived). */
export async function sweepStaleCheckIns(now = new Date()) {
  const yesterday = istDay(new Date(now.getTime() - 24 * HOUR)).day;
  return { lapsed: await lapseFor({ tokenDay: { lte: yesterday } }, null) };
}
