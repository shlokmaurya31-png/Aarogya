import type { CardShare, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { addPatientCoverage } from "@/lib/hospital/billing/coverage";
import { staffCard } from "./cards";

/**
 * Week 5c — a card shared with one facility for one visit
 * (docs/PATIENT_INSURANCE_DESIGN.md §2, §8). Made at pre-arrival check-in;
 * ends when the check-in lapses or is cancelled, when the card is removed,
 * or by itself a couple of days after the visit (expiresAt). Staff read the
 * card only through it (personAccess, CARD_SHARE), and verify it into the
 * facility's own PatientCoverage (sourceCardId). The check-in never waits
 * for that: until then its eligibility shows "pending".
 */
type Tx = Prisma.TransactionClient;

export async function cardShareEventTx(tx: Tx, cs: CardShare, from: "NONE" | "ACTIVE", to: "ACTIVE" | "ENDED", userId: string | null) {
  await emitDomainEvent(tx, {
    type: "CardShareStatusChanged", aggregateId: cs.id, personId: cs.personId, actorUserId: userId,
    payload: { insuranceShareId: cs.id, insuranceId: cs.cardId, personId: cs.personId, recipientFacilityId: cs.recipientFacilityId, from, to },
  });
}

export async function createCardShareTx(tx: Tx, input: { cardId: string; personId: string; facilityId: string; expiresAt: Date; createdByPersonId: string; userId: string }) {
  const card = await tx.insuranceCard.findUnique({ where: { id: input.cardId } });
  if (!card || card.personId !== input.personId || card.status !== "ACTIVE") throw new NotFoundError();
  const cs = await tx.cardShare.create({ data: { cardId: card.id, personId: input.personId, recipientFacilityId: input.facilityId, expiresAt: input.expiresAt, createdByPersonId: input.createdByPersonId } });
  await cardShareEventTx(tx, cs, "NONE", "ACTIVE", input.userId);
  return cs;
}

/** Ends ACTIVE card shares matching `where` (a card, or a check-in's), each with its event. */
export async function endCardSharesTx(tx: Tx, where: { cardId?: string; id?: string }, reason: string, userId: string | null) {
  const rows = await tx.cardShare.findMany({ where: { ...where, status: "ACTIVE" } });
  for (const cs of rows) {
    const r = await tx.cardShare.updateMany({ where: { id: cs.id, status: "ACTIVE" }, data: { status: "ENDED", endedAt: new Date(), endedReason: reason, version: { increment: 1 } } });
    if (r.count === 1) await cardShareEventTx(tx, { ...cs, status: "ENDED" }, "ACTIVE", "ENDED", userId);
  }
}

/** Runner sweep: card shares past their expiry end (each with its event). */
export async function sweepExpiredCardShares(now = new Date()) {
  const rows = await prisma.cardShare.findMany({ where: { status: "ACTIVE", expiresAt: { lte: now } }, select: { id: true }, take: 500 });
  for (const r of rows) await prisma.$transaction((tx) => endCardSharesTx(tx, { id: r.id }, "EXPIRED", null));
  return { ended: rows.length };
}

/**
 * Staff verify the card of a pre-arrival check-in (by the desk's manual
 * check now; by NHCX eligibility once wired): VERIFIED creates (or reuses)
 * the facility's PatientCoverage with sourceCardId; NOT_VERIFIED records the
 * outcome and sends the patient to the desk. Either way the check-in's
 * eligibility changes with its event, and CoverageVerifiedFromCard.
 */
export async function verifyCheckInCard(staff: { userId: string; facilityId: string }, checkInId: string, body: { outcome?: unknown; payerId?: unknown; planId?: unknown; validFrom?: unknown; validTo?: unknown; note?: unknown }) {
  const ci = await prisma.preArrivalCheckIn.findUnique({ where: { id: checkInId } });
  if (!ci || ci.facilityId !== staff.facilityId || !ci.cardShareId) throw new NotFoundError();
  if (!["SUBMITTED", "READY", "NEEDS_DESK"].includes(ci.status)) throw new ConflictError("This check-in is closed.");
  if (body.outcome !== "VERIFIED" && body.outcome !== "NOT_VERIFIED") throw new BadRequestError("outcome must be VERIFIED or NOT_VERIFIED.");
  const { card, view } = await staffCard({ userId: staff.userId, facilityId: staff.facilityId, cardShareId: ci.cardShareId });
  let payerId: string | null = null;
  if (body.outcome === "VERIFIED") {
    payerId = typeof body.payerId === "string" ? body.payerId : card.payerId;
    const payer = payerId ? await prisma.payer.findUnique({ where: { id: payerId }, select: { id: true, active: true, type: true } }) : null;
    if (!payer?.active || payer.type === "CASH") throw new BadRequestError("Choose the payer this card is with.");
  }
  const out = await prisma.$transaction(async (tx) => {
    const cur = await tx.preArrivalCheckIn.findUniqueOrThrow({ where: { id: ci.id } });
    if (cur.version !== ci.version) throw new ConflictError("This check-in changed in the meantime.");
    let coverageId: string | null = null;
    if (body.outcome === "VERIFIED") {
      const existing = await tx.patientCoverage.findUnique({ where: { patientId_payerId_memberId: { patientId: ci.patientId, payerId: payerId!, memberId: view.memberId } } });
      if (existing && existing.status === "ACTIVE") {
        await tx.patientCoverage.update({ where: { id: existing.id }, data: { sourceCardId: card.id } });
        coverageId = existing.id;
      } else if (existing) {
        throw new ConflictError("This coverage was ended at this hospital; reactivate it from billing.");
      } else {
        const created = await addPatientCoverage(tx, {
          patientId: ci.patientId, payerId: payerId!, planId: typeof body.planId === "string" ? body.planId : undefined, memberId: view.memberId,
          validFrom: card.validFrom ?? new Date(new Date().toISOString().slice(0, 10)), validTo: card.validTo, addedByUserId: staff.userId, sourceCardId: card.id,
        });
        coverageId = created.id;
      }
    }
    const eligibility = body.outcome === "VERIFIED" ? "VERIFIED" : "NOT_VERIFIED";
    const status = body.outcome === "VERIFIED" ? cur.status : "NEEDS_DESK";
    const reason = body.outcome === "VERIFIED" ? cur.needsDeskReason : "CARD_NOT_VERIFIED";
    await tx.preArrivalCheckIn.update({ where: { id: ci.id }, data: { eligibility, status, needsDeskReason: reason, decidedByUserId: staff.userId, decidedAt: new Date(), version: { increment: 1 } } });
    await emitFacilityEvent(tx, {
      type: "CoverageVerifiedFromCard", aggregateId: ci.id, facilityId: ci.facilityId, actorUserId: staff.userId,
      payload: { checkInId: ci.id, patientId: ci.patientId, insuranceShareId: ci.cardShareId!, coverageId: coverageId ?? undefined, method: "MANUAL", outcome: eligibility },
    });
    if (status !== cur.status) {
      await emitFacilityEvent(tx, { type: "PreArrivalCheckInStatusChanged", aggregateId: ci.id, facilityId: ci.facilityId, actorUserId: staff.userId, payload: { checkInId: ci.id, patientId: ci.patientId, from: cur.status, to: status, needsDeskReason: reason ?? undefined } });
    }
    return { eligibility, status, coverageId };
  });
  await recordAuditEvent("hospital.checkin.cardVerified", staff.userId, { checkInId: ci.id, outcome: out.eligibility, coverageId: out.coverageId }, { facilityId: ci.facilityId, patientId: ci.patientId });
  return out;
}
