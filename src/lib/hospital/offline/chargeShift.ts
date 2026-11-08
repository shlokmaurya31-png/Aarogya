import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { isStaffInFacility } from "@/lib/auth/staffFacility";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

/**
 * Flagship 3a — the charge nurse per shift (docs/OFFLINE_NURSING_DESIGN.md
 * §12.9). The hospital admin keeps the ward's shift roster: one charge nurse
 * per ward per shift, never two at once (an exclusion constraint). Whoever is
 * the charge nurse NOW takes dose leases over and gets the offline conflict
 * tasks; with no shift on, the ward's named charge nurse is the fallback.
 */

type Db = PrismaClient | Prisma.TransactionClient;
export interface AdminActor { userId: string; facilityId: string }

const MAX_SHIFT_MS = 24 * 3_600_000;

/** A NURSE at the facility, or 404 (nothing about another facility's staff is revealed). */
export async function assertFacilityNurse(facilityId: string, staffId: string) {
  const s = await prisma.hospitalStaffProfile.findUnique({ where: { id: staffId }, select: { id: true, user: { select: { role: true } } } });
  if (!s || s.user.role !== "NURSE" || !(await isStaffInFacility(prisma, s.id, facilityId))) throw new NotFoundError("Nurse not found at this facility.");
}

async function facilityWard(facilityId: string, wardId: string) {
  const ward = await prisma.ward.findUnique({ where: { id: wardId }, select: { id: true, facilityId: true } });
  if (!ward || ward.facilityId !== facilityId) throw new NotFoundError("Ward not found.");
  return ward;
}

function isOverlap(e: unknown) {
  return /23P01|exclusion_violation|ward_charge_shift_no_overlap/i.test(String((e as { message?: string })?.message ?? e));
}

/** POST { staffId, startAt, endAt }: the charge nurse for one shift on the ward. */
export async function assignChargeShift(admin: AdminActor, wardId: string, body: { staffId?: unknown; startAt?: unknown; endAt?: unknown }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const ward = await facilityWard(admin.facilityId, wardId);
  if (typeof body.staffId !== "string") throw new BadRequestError("staffId is required.");
  const startAt = typeof body.startAt === "string" ? new Date(body.startAt) : null;
  const endAt = typeof body.endAt === "string" ? new Date(body.endAt) : null;
  if (!startAt || !endAt || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) throw new BadRequestError("startAt and endAt must be ISO times.");
  if (endAt <= startAt || endAt.getTime() - startAt.getTime() > MAX_SHIFT_MS) throw new BadRequestError("A shift ends after it starts, within 24 hours.");
  if (endAt <= now) throw new BadRequestError("This shift has already ended.");
  await assertFacilityNurse(admin.facilityId, body.staffId);
  const staffId = body.staffId;

  try {
    return await prisma.$transaction(async (tx) => {
      const clash = await tx.wardChargeShift.findFirst({ where: { wardId: ward.id, status: "ACTIVE", startAt: { lt: endAt }, endAt: { gt: startAt } }, select: { id: true } });
      if (clash) throw new ConflictError("Another charge nurse is rostered on this ward for part of that time.");
      const s = await tx.wardChargeShift.create({ data: { facilityId: admin.facilityId, wardId: ward.id, staffId, startAt, endAt, assignedByUserId: admin.userId } });
      await emitFacilityEvent(tx, {
        type: "WardChargeShiftAssigned", aggregateId: s.id, facilityId: admin.facilityId, actorUserId: admin.userId,
        payload: { shiftId: s.id, wardId: ward.id, chargeNurseStaffId: staffId, startAt: startAt.toISOString(), endAt: endAt.toISOString() },
      });
      return s;
    });
  } catch (e) {
    if (isOverlap(e)) throw new ConflictError("Another charge nurse is rostered on this ward for part of that time.");
    throw e;
  }
}

/** Cancels a rostered shift (from then on the ward's named charge nurse covers that time). */
export async function cancelChargeShift(admin: AdminActor, shiftId: string) {
  const s = await prisma.wardChargeShift.findUnique({ where: { id: shiftId } });
  if (!s || s.facilityId !== admin.facilityId) throw new NotFoundError("Shift not found.");
  if (s.status === "CANCELLED") return s;
  return prisma.$transaction(async (tx) => {
    const r = await tx.wardChargeShift.updateMany({ where: { id: s.id, status: "ACTIVE" }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: admin.userId } });
    if (r.count !== 1) throw new ConflictError("The shift changed in the meantime.");
    await emitFacilityEvent(tx, { type: "WardChargeShiftCancelled", aggregateId: s.id, facilityId: s.facilityId, actorUserId: admin.userId, payload: { shiftId: s.id, wardId: s.wardId } });
    return tx.wardChargeShift.findUniqueOrThrow({ where: { id: s.id } });
  });
}

/** The ward's roster from a time (default: shifts not yet ended), soonest first. */
export async function listChargeShifts(facilityId: string, wardId: string, opts: { from?: Date } = {}) {
  const ward = await facilityWard(facilityId, wardId);
  const from = opts.from ?? new Date();
  return prisma.wardChargeShift.findMany({
    where: { wardId: ward.id, status: "ACTIVE", endAt: { gt: from } },
    select: { id: true, staffId: true, startAt: true, endAt: true },
    orderBy: { startAt: "asc" },
    take: 200,
  });
}

export interface ChargeNurseNow { staffId: string | null; source: "SHIFT" | "WARD" | null; shiftId: string | null }

/**
 * The ward's charge nurse at a moment: the rostered shift's, or else the
 * ward's named charge nurse, or none (then tasks go to the CHARGE_NURSE role).
 */
export async function currentChargeNurse(db: Db, wardId: string, at: Date): Promise<ChargeNurseNow> {
  const shift = await db.wardChargeShift.findFirst({ where: { wardId, status: "ACTIVE", startAt: { lte: at }, endAt: { gt: at } }, select: { id: true, staffId: true } });
  if (shift) return { staffId: shift.staffId, source: "SHIFT", shiftId: shift.id };
  const ward = await db.ward.findUnique({ where: { id: wardId }, select: { chargeNurseStaffId: true } });
  return ward?.chargeNurseStaffId ? { staffId: ward.chargeNurseStaffId, source: "WARD", shiftId: null } : { staffId: null, source: null, shiftId: null };
}
