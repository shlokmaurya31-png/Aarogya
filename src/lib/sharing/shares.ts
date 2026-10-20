import type { Prisma, RecordShare, RecordShareKind, RecordShareStatus, ShareEndReason } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { emitDomainEvent } from "@/lib/events/emit";
import { requireOwnedPerson } from "@/lib/person/access";
import type { ShareChoice } from "./categories";

/**
 * Week 4c — the life of a share (docs/CONSENT_SHARING_DESIGN.md §3.1, §4):
 * PENDING (a code not yet redeemed) → ACTIVE → ENDED (its visit ended) |
 * EXPIRED (past its validity) | REVOKED (by the person, revoke-all, or the
 * account closing). Every transition emits RecordShareStatusChanged in its
 * transaction and is written to the person's access log.
 */
const LIVE: RecordShareStatus[] = ["PENDING", "ACTIVE"];

/** The person's facility records a new share covers: every ACTIVE link now (a snapshot, §12 decision 6). */
export async function activeLinkedPatients(personId: string, tx: Prisma.TransactionClient = prisma): Promise<string[]> {
  return (await tx.personPatientLink.findMany({ where: { personId, status: "ACTIVE" }, select: { patientId: true }, orderBy: { createdAt: "asc" } })).map((l) => l.patientId);
}

export async function createShareTx(tx: Prisma.TransactionClient, input: {
  personId: string; kind: RecordShareKind; status: "PENDING" | "ACTIVE"; choice: ShareChoice; patientIds: string[]; expiresAt: Date; createdByUserId: string;
  recipientUserId?: string | null; recipientFacilityId?: string | null; accessRequestId?: string;
  /** Week 5a: a BOOKING share reads only from here. */
  validFrom?: Date;
}): Promise<RecordShare> {
  const c = input.choice;
  const share = await tx.recordShare.create({
    data: {
      personId: input.personId, kind: input.kind, status: input.status, purpose: c.purpose, categories: c.categories, sensitiveCategories: c.sensitiveCategories,
      recordedFrom: c.recordedFrom, recordedTo: c.recordedTo, patientIds: input.patientIds, expiresAt: input.expiresAt, createdByUserId: input.createdByUserId,
      recipientUserId: input.recipientUserId ?? null, recipientFacilityId: input.recipientFacilityId ?? null, accessRequestId: input.accessRequestId,
      activatedAt: input.status === "ACTIVE" ? new Date() : null, validFrom: input.validFrom ?? null,
    },
  });
  await tx.personAccessLogEntry.create({ data: { personId: input.personId, kind: "SHARE_CREATED", actorUserId: input.createdByUserId, accessingFacilityId: input.recipientFacilityId ?? null, detail: { shareId: share.id, kind: share.kind, categories: share.categories, sensitive: share.sensitiveCategories.length } } });
  await emitDomainEvent(tx, {
    type: "RecordShareCreated", aggregateId: share.id, personId: input.personId, actorUserId: input.createdByUserId,
    payload: {
      shareId: share.id, personId: input.personId, kind: share.kind, status: share.status, purpose: share.purpose, categories: share.categories,
      sensitiveCategories: share.sensitiveCategories, hasPeriod: Boolean(share.recordedFrom || share.recordedTo), expiresAt: share.expiresAt.toISOString(),
      ...(share.validFrom ? { validFrom: share.validFrom.toISOString() } : {}),
    },
  });
  return share;
}

/** A redeemed code's share: bound to the doctor and their facility, ACTIVE. False if the share is no longer PENDING or has expired. */
export async function activateShareTx(tx: Prisma.TransactionClient, shareId: string, recipient: { userId: string; facilityId: string }): Promise<boolean> {
  const now = new Date();
  const r = await tx.recordShare.updateMany({
    where: { id: shareId, status: "PENDING", expiresAt: { gt: now } },
    data: { status: "ACTIVE", recipientUserId: recipient.userId, recipientFacilityId: recipient.facilityId, activatedAt: now, version: { increment: 1 } },
  });
  if (r.count !== 1) return false;
  const s = await tx.recordShare.findUniqueOrThrow({ where: { id: shareId } });
  await emitDomainEvent(tx, { type: "RecordShareStatusChanged", aggregateId: s.id, personId: s.personId, actorUserId: recipient.userId, payload: { shareId: s.id, personId: s.personId, from: "PENDING", to: "ACTIVE" } });
  return true;
}

/** Ends a live share (no-op if it already ended). Returns whether this call ended it. */
export async function endShareTx(tx: Prisma.TransactionClient, shareId: string, to: "ENDED" | "EXPIRED" | "REVOKED", reason: ShareEndReason, actorUserId: string | null): Promise<boolean> {
  const before = await tx.recordShare.findUnique({ where: { id: shareId }, select: { status: true, personId: true } });
  if (!before || !LIVE.includes(before.status)) return false;
  const r = await tx.recordShare.updateMany({ where: { id: shareId, status: before.status }, data: { status: to, endedAt: new Date(), endedReason: reason, version: { increment: 1 } } });
  if (r.count !== 1) return false;
  await tx.personAccessLogEntry.create({ data: { personId: before.personId, kind: "SHARE_ENDED", actorUserId, detail: { shareId, to, reason } } });
  await emitDomainEvent(tx, {
    type: "RecordShareStatusChanged", aggregateId: shareId, personId: before.personId, actorUserId,
    payload: { shareId, personId: before.personId, from: before.status, to, endedReason: reason },
  });
  return true;
}

/** Runner sweep: live shares past their validity expire (each with its event); their open code sessions end with them. */
export async function sweepShareExpiry(opts: { now?: Date; batchSize?: number } = {}): Promise<{ expired: number }> {
  const now = opts.now ?? new Date();
  const due = await prisma.recordShare.findMany({ where: { status: { in: LIVE }, expiresAt: { lte: now } }, select: { id: true }, take: opts.batchSize ?? 200, orderBy: { expiresAt: "asc" } });
  let expired = 0;
  for (const { id } of due) {
    if (await prisma.$transaction((tx) => endShareTx(tx, id, "EXPIRED", "EXPIRED", null))) expired += 1;
  }
  return { expired };
}

export interface OwnShareDTO {
  id: string; kind: RecordShareKind; status: RecordShareStatus; purpose: string; categories: string[]; sensitiveCategories: string[];
  period: { from: string | null; to: string | null }; recipient: { doctorName: string | null; facilityName: string | null };
  createdAt: string; activatedAt: string | null; expiresAt: string; endedAt: string | null; endedReason: string | null;
}

/** The person's shares: live ones, and those that ended in the last 30 days. */
export async function listOwnShares(userId: string): Promise<OwnShareDTO[]> {
  const personId = await requireOwnedPerson(userId);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await prisma.recordShare.findMany({ where: { personId, OR: [{ status: { in: LIVE } }, { endedAt: { gte: since } }] }, orderBy: { createdAt: "desc" }, take: 100 });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.recipientUserId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } });
  const facilities = await prisma.facility.findMany({ where: { id: { in: rows.map((r) => r.recipientFacilityId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  return rows.map((r) => ({
    id: r.id, kind: r.kind, status: r.status, purpose: r.purpose, categories: r.categories, sensitiveCategories: r.sensitiveCategories,
    period: { from: r.recordedFrom?.toISOString() ?? null, to: r.recordedTo?.toISOString() ?? null },
    recipient: { doctorName: users.find((u) => u.id === r.recipientUserId)?.displayName ?? null, facilityName: facilities.find((f) => f.id === r.recipientFacilityId)?.name ?? null },
    createdAt: r.createdAt.toISOString(), activatedAt: r.activatedAt?.toISOString() ?? null, expiresAt: r.expiresAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null, endedReason: r.endedReason ?? null,
  }));
}

/** The person stops one share now; a code's open visit ends with it. */
export async function endOwnShare(userId: string, shareId: string): Promise<{ status: RecordShareStatus }> {
  const personId = await requireOwnedPerson(userId);
  const share = await prisma.recordShare.findUnique({ where: { id: shareId }, include: { session: { select: { id: true, status: true } } } });
  if (!share || share.personId !== personId) throw new NotFoundError();
  await prisma.$transaction(async (tx) => {
    await endShareTx(tx, share.id, "REVOKED", "PATIENT_ENDED", userId);
    if (share.session) await closeSessionTx(tx, share.session.id, "PATIENT", userId);
  });
  return { status: (await prisma.recordShare.findUniqueOrThrow({ where: { id: shareId }, select: { status: true } })).status };
}

/**
 * Closes a code session whose share was ended elsewhere (revoke, revoke-all):
 * an unredeemed code is CANCELLED, a live visit ENDED, with the session's own
 * event when a facility was involved (PatientAccessSessionStatusChanged).
 */
export async function closeSessionTx(tx: Prisma.TransactionClient, sessionId: string, by: "PATIENT" | "SYSTEM", actorUserId: string | null): Promise<void> {
  const s = await tx.patientAccessSession.findUnique({ where: { id: sessionId } });
  if (!s || (s.status !== "PENDING" && s.status !== "ACTIVE")) return;
  const to = s.status === "PENDING" ? "CANCELLED" : "ENDED";
  const r = await tx.patientAccessSession.updateMany({ where: { id: s.id, status: s.status }, data: { status: to, endedAt: new Date(), endedBy: by } });
  if (r.count !== 1 || !s.facilityId) return;
  const { emitFacilityEvent } = await import("@/lib/events/facilityEvent");
  await emitFacilityEvent(tx, {
    type: "PatientAccessSessionStatusChanged", aggregateId: s.id, facilityId: s.facilityId, actorUserId,
    payload: { accessGrantId: s.id, patientId: s.patientId, from: s.status, to, extended: false, endedBy: by, ...(s.doctorStaffId ? { doctorStaffId: s.doctorStaffId } : {}) },
  });
}
