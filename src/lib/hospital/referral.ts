import { $Enums, type Prisma, type Referral } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { parseEnum } from "@/lib/enumValue";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { syncOrderStatus } from "./orderEnvelope";

type Tx = Prisma.TransactionClient;

/**
 * Referrals (batch 7, item 1; previously written by their routes). Every status
 * change emits ReferralStatusChanged in its transaction, correlated by the
 * encounter; never the reason or the response notes.
 */
export const REFERRAL_RESPONSE_STATUSES = ["ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "REJECTED"] as const;

/** Final outcomes: a completed, cancelled or rejected referral is not reopened or re-decided (it previously could be). */
const FINAL: readonly string[] = ["COMPLETED", "CANCELLED", "REJECTED"];

async function emitReferral(tx: Tx, r: Referral, from: string | null, facilityId: string, byUserId: string) {
  await emitFacilityEvent(tx, {
    type: "ReferralStatusChanged", aggregateId: r.id, facilityId, encounterId: r.encounterId, actorUserId: byUserId,
    payload: {
      referralId: r.id, encounterId: r.encounterId, patientId: r.patientId, from, to: r.status, priority: r.priority,
      ...(r.toDepartmentId ? { toDepartmentId: r.toDepartmentId } : {}), ...(r.toStaffId ? { toStaffId: r.toStaffId } : {}),
    },
  });
}

export async function createReferral(input: { encounterId: string; facilityId: string; fromStaffId: string; toDepartmentId?: string; toStaffId?: string; reason: string; priority?: string; byUserId: string }) {
  if (!input.reason) throw new BadRequestError("encounterId and reason are required.");
  const priority = parseEnum($Enums.Priority, input.priority ?? "ROUTINE", "priority");
  return prisma.$transaction(async (tx) => {
    const enc = await tx.encounter.findUnique({ where: { id: input.encounterId }, select: { id: true, facilityId: true, patientId: true, departmentId: true } });
    if (!enc || enc.facilityId !== input.facilityId) throw new NotFoundError("Encounter not found.");
    const referral = await tx.referral.create({
      data: {
        patientId: enc.patientId, encounterId: enc.id, fromDepartmentId: enc.departmentId, toDepartmentId: input.toDepartmentId,
        fromStaffId: input.fromStaffId, toStaffId: input.toStaffId, reason: input.reason, priority, status: "PLACED",
      },
    });
    await emitReferral(tx, referral, null, enc.facilityId, input.byUserId);
    return referral;
  });
}

/** A response to a referral, compare-and-set on the status read (two responders can't both win). */
export async function respondToReferral(input: { referralId: string; facilityId: string; status: string; notes?: string; staffId?: string | null; byUserId: string }) {
  if (!(REFERRAL_RESPONSE_STATUSES as readonly string[]).includes(input.status)) throw new BadRequestError(`status must be one of ${REFERRAL_RESPONSE_STATUSES.join(", ")}.`);
  const status = input.status as (typeof REFERRAL_RESPONSE_STATUSES)[number];
  return prisma.$transaction(async (tx) => {
    const referral = await tx.referral.findUnique({ where: { id: input.referralId }, include: { encounter: { select: { facilityId: true } } } });
    if (!referral || referral.encounter.facilityId !== input.facilityId) throw new NotFoundError("Referral not found.");
    if (FINAL.includes(referral.status)) throw new BadRequestError(`This referral is already ${referral.status}.`);
    const r = await tx.referral.updateMany({
      where: { id: referral.id, status: referral.status },
      data: {
        status, notes: input.notes ?? referral.notes, toStaffId: referral.toStaffId ?? input.staffId ?? null, respondedAt: new Date(),
        acceptedAt: status === "ACKNOWLEDGED" && !referral.acceptedAt ? new Date() : referral.acceptedAt,
      },
    });
    if (r.count !== 1) throw new BadRequestError("The referral changed concurrently. Refresh and try again.");
    await syncOrderStatus(tx, "REFERRAL", referral.id);
    const updated = await tx.referral.findUniqueOrThrow({ where: { id: referral.id } });
    await emitReferral(tx, updated, referral.status, input.facilityId, input.byUserId);
    return { referral: updated, previous: referral };
  });
}
