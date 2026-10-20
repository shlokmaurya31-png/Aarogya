import type { AccessRequest, AccessRequestStatus, Prisma, ShareCategory } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { requireOwnedPerson } from "@/lib/person/access";
import { parseShareChoice, SENSITIVE_CATEGORIES, type ShareChoice } from "./categories";
import { activeLinkedPatients, createShareTx } from "./shares";

/**
 * Week 4c — access requests (docs/CONSENT_SHARING_DESIGN.md §5). A doctor at a
 * facility holding an ACTIVE link to the person asks, as themselves or for the
 * facility (4c answer, §15: a facility request is readable only by the doctor
 * who asked, and only while the facility treats the person; an admin, who
 * can't read, can't ask); the person approves (as asked or narrower,
 * adding sensitive categories only by their own choice) or declines. One open
 * request per requester and person; undecided requests expire in 7 days.
 * Every transition emits its event in its transaction and is logged for the person.
 */
export const REQUEST_TTL_DAYS = 7;
export const SHARE_VALID_DAYS = { min: 1, max: 90, default: 30 } as const;

export interface RequestActor { userId: string; facilityId: string; role: string }

async function statusTx(tx: Prisma.TransactionClient, r: AccessRequest, to: AccessRequestStatus, actorUserId: string | null, shareId?: string): Promise<boolean> {
  const u = await tx.accessRequest.updateMany({ where: { id: r.id, status: "REQUESTED" }, data: { status: to, decidedAt: new Date(), decidedByUserId: actorUserId, version: { increment: 1 } } });
  if (u.count !== 1) return false;
  await tx.personAccessLogEntry.create({ data: { personId: r.personId, kind: "ACCESS_REQUEST_DECIDED", actorUserId, accessingFacilityId: r.requesterFacilityId, detail: { requestId: r.id, to, ...(shareId ? { shareId } : {}) } } });
  await emitDomainEvent(tx, { type: "AccessRequestStatusChanged", aggregateId: r.id, personId: r.personId, actorUserId, payload: { requestId: r.id, personId: r.personId, from: "REQUESTED", to, ...(shareId ? { shareId } : {}) } });
  return true;
}

export async function requestAccess(actor: RequestActor, body: Record<string, unknown> | null) {
  const b = body ?? {};
  const kind = b.requesterKind === "FACILITY" ? "FACILITY" : "DOCTOR";
  // A request is read only by the doctor who made it (a facility request too), so only a doctor can ask.
  if (actor.role !== "DOCTOR") throw new BadRequestError("Only a doctor can ask: a request is read only by the doctor who asked.");
  if (Array.isArray(b.sensitiveCategories) && b.sensitiveCategories.length) throw new BadRequestError("A request can't ask for sensitive categories; only the patient can add them.");
  const choice = parseShareChoice({ ...b, sensitiveCategories: [] });
  if (kind === "FACILITY" && choice.purpose === "OTHER") throw new BadRequestError("A facility must give a specific purpose.");
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 280) || null : null;
  const patientId = typeof b.patientId === "string" ? b.patientId : "";
  // Only about a patient the requester already knows: their own facility's record, linked to an Aarogya account.
  const patient = patientId ? await prisma.patient.findUnique({ where: { id: patientId }, select: { id: true, facilityId: true } }) : null;
  if (!patient || patient.facilityId !== actor.facilityId) throw new NotFoundError();
  const link = await prisma.personPatientLink.findFirst({ where: { patientId: patient.id, facilityId: actor.facilityId, status: "ACTIVE" }, select: { personId: true } });
  if (!link) throw new NotFoundError();
  const person = await prisma.person.findUnique({ where: { id: link.personId }, select: { status: true } });
  if (person?.status !== "ACTIVE") throw new NotFoundError();

  const created = await prisma.$transaction(async (tx) => {
    if (await tx.accessRequest.findFirst({ where: { personId: link.personId, requesterUserId: actor.userId, status: "REQUESTED" }, select: { id: true } })) {
      throw new ConflictError("You already have a request waiting for this patient.");
    }
    const r = await tx.accessRequest.create({
      data: {
        personId: link.personId, patientId: patient.id, requesterKind: kind, requesterUserId: actor.userId, requesterFacilityId: actor.facilityId,
        purpose: choice.purpose, categories: choice.categories, recordedFrom: choice.recordedFrom, recordedTo: choice.recordedTo, reason,
        expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86_400_000),
      },
    });
    await tx.personAccessLogEntry.create({ data: { personId: link.personId, kind: "ACCESS_REQUESTED", actorUserId: actor.userId, accessingFacilityId: actor.facilityId, detail: { requestId: r.id, categories: r.categories } } });
    await emitDomainEvent(tx, {
      type: "AccessRequested", aggregateId: r.id, personId: link.personId, actorUserId: actor.userId,
      payload: { requestId: r.id, personId: link.personId, requesterKind: kind, requesterFacilityId: actor.facilityId, purpose: r.purpose, categories: r.categories },
    });
    return r;
  });
  await recordAuditEvent("person.access.requested", actor.userId, { requestId: created.id }, { facilityId: actor.facilityId, patientId: patient.id });
  // The person is told through the notification pipeline (person-notifier, on AccessRequested), in their language.
  return { id: created.id, status: created.status, expiresAt: created.expiresAt.toISOString() };
}

/** The requester's facility's requests (a facility admin sees the facility's; a doctor sees their own). */
export async function listFacilityRequests(actor: RequestActor, patientId?: string) {
  const rows = await prisma.accessRequest.findMany({
    where: { requesterFacilityId: actor.facilityId, ...(actor.role === "HOSPITAL_ADMIN" ? {} : { requesterUserId: actor.userId }), ...(patientId ? { patientId } : {}) },
    orderBy: { createdAt: "desc" }, take: 100,
  });
  const shares = await prisma.recordShare.findMany({ where: { accessRequestId: { in: rows.map((r) => r.id) } }, select: { id: true, accessRequestId: true, status: true, expiresAt: true, categories: true } });
  return rows.map((r) => {
    const s = shares.find((x) => x.accessRequestId === r.id);
    return {
      id: r.id, patientId: r.patientId, requesterKind: r.requesterKind, purpose: r.purpose, categories: r.categories, status: r.status,
      createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
      share: s ? { id: s.id, status: s.status, expiresAt: s.expiresAt.toISOString(), categories: s.categories } : null,
    };
  });
}

export async function cancelRequest(actor: RequestActor, requestId: string) {
  const r = await prisma.accessRequest.findUnique({ where: { id: requestId } });
  const mine = r && r.requesterFacilityId === actor.facilityId && (r.requesterUserId === actor.userId || (r.requesterKind === "FACILITY" && actor.role === "HOSPITAL_ADMIN"));
  if (!r || !mine) throw new NotFoundError();
  if (r.status !== "REQUESTED") throw new ConflictError("This request has already been decided.");
  if (!(await prisma.$transaction((tx) => statusTx(tx, r, "CANCELLED", actor.userId)))) throw new ConflictError("This request has already been decided.");
  return { status: "CANCELLED" as const };
}

/** The person's requests: pending first, then the last 30 days. */
export async function listOwnRequests(userId: string) {
  const personId = await requireOwnedPerson(userId);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await prisma.accessRequest.findMany({ where: { personId, OR: [{ status: "REQUESTED" }, { createdAt: { gte: since } }] }, orderBy: { createdAt: "desc" }, take: 100 });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.requesterUserId) } }, select: { id: true, displayName: true } });
  const facilities = await prisma.facility.findMany({ where: { id: { in: rows.map((r) => r.requesterFacilityId) } }, select: { id: true, name: true } });
  return rows
    .map((r) => ({
      id: r.id, status: r.status, requesterKind: r.requesterKind,
      requesterName: r.requesterKind === "DOCTOR" ? users.find((u) => u.id === r.requesterUserId)?.displayName ?? "A doctor" : null,
      facilityName: facilities.find((f) => f.id === r.requesterFacilityId)?.name ?? "A hospital",
      purpose: r.purpose, categories: r.categories, period: { from: r.recordedFrom?.toISOString() ?? null, to: r.recordedTo?.toISOString() ?? null },
      reason: r.reason, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
    }))
    .sort((a, b) => Number(b.status === "REQUESTED") - Number(a.status === "REQUESTED"));
}

/**
 * The person decides. Approving creates the share (kind REQUEST, ACTIVE, bound
 * to the requester) in the same transaction: categories only from those asked
 * for, a period only inside the one asked for, sensitive categories only by
 * the person's own choice, valid 1–90 days (default 30).
 */
export async function decideRequest(userId: string, requestId: string, body: Record<string, unknown> | null) {
  const personId = await requireOwnedPerson(userId);
  const r = await prisma.accessRequest.findUnique({ where: { id: requestId } });
  if (!r || r.personId !== personId) throw new NotFoundError();
  if (r.status !== "REQUESTED" || r.expiresAt <= new Date()) throw new ConflictError("This request is no longer waiting for you.");
  const b = body ?? {};
  if (b.decision === "DECLINE") {
    if (!(await prisma.$transaction((tx) => statusTx(tx, r, "DECLINED", userId)))) throw new ConflictError("This request is no longer waiting for you.");
    return { status: "DECLINED" as const, shareId: null };
  }
  if (b.decision !== "APPROVE") throw new BadRequestError("decision must be APPROVE or DECLINE.");
  const choice: ShareChoice = parseShareChoice(
    { ...b, purpose: r.purpose, period: b.period ?? { from: r.recordedFrom?.toISOString().slice(0, 10), to: r.recordedTo?.toISOString().slice(0, 10) } },
    { categories: r.categories },
  );
  if (choice.categories.some((c: ShareCategory) => !r.categories.includes(c))) throw new BadRequestError("You can share fewer categories than asked for, never more.");
  if ((r.recordedFrom && (!choice.recordedFrom || choice.recordedFrom < r.recordedFrom)) || (r.recordedTo && (!choice.recordedTo || choice.recordedTo > new Date(r.recordedTo.getTime() + 86_400_000)))) {
    throw new BadRequestError("The period can only be narrower than the one asked for.");
  }
  if (choice.sensitiveCategories.some((c) => !SENSITIVE_CATEGORIES.includes(c))) throw new BadRequestError("Unknown sensitive category.");
  const days = b.validDays === undefined ? SHARE_VALID_DAYS.default : Number(b.validDays);
  if (!Number.isInteger(days) || days < SHARE_VALID_DAYS.min || days > SHARE_VALID_DAYS.max) throw new BadRequestError(`validDays must be ${SHARE_VALID_DAYS.min}–${SHARE_VALID_DAYS.max}.`);

  const shareId = await prisma.$transaction(async (tx) => {
    const share = await createShareTx(tx, {
      personId, kind: "REQUEST", status: "ACTIVE", choice, patientIds: await activeLinkedPatients(personId, tx), expiresAt: new Date(Date.now() + days * 86_400_000),
      // Always the doctor who asked (a facility request too, §15), at their facility.
      createdByUserId: userId, recipientUserId: r.requesterUserId, recipientFacilityId: r.requesterFacilityId, accessRequestId: r.id,
    });
    if (!(await statusTx(tx, r, "APPROVED", userId, share.id))) throw new ConflictError("This request is no longer waiting for you.");
    return share.id;
  });
  await recordAuditEvent("person.access.requestApproved", userId, { requestId: r.id, shareId });
  return { status: "APPROVED" as const, shareId };
}

/** Runner sweep: undecided requests past their 7 days expire, each with its event. */
export async function sweepAccessRequestExpiry(opts: { now?: Date; batchSize?: number } = {}): Promise<{ expired: number }> {
  const now = opts.now ?? new Date();
  const due = await prisma.accessRequest.findMany({ where: { status: "REQUESTED", expiresAt: { lte: now } }, take: opts.batchSize ?? 200, orderBy: { expiresAt: "asc" } });
  let expired = 0;
  for (const r of due) if (await prisma.$transaction((tx) => statusTx(tx, r, "EXPIRED", null))) expired += 1;
  return { expired };
}

/** Revoke-all declines the person's pending requests in its transaction. */
export async function declinePendingRequestsTx(tx: Prisma.TransactionClient, personId: string, userId: string): Promise<number> {
  let n = 0;
  for (const r of await tx.accessRequest.findMany({ where: { personId, status: "REQUESTED" } })) if (await statusTx(tx, r, "DECLINED", userId)) n += 1;
  return n;
}
