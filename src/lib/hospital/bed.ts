import { prisma } from "@/lib/db";
import { BedStatus } from "@prisma/client";

/** Legal bed-status transitions. Anything not listed is refused — a bed can't jump from AVAILABLE straight to TRANSFER_PENDING, for example. */
const ALLOWED_TRANSITIONS: Record<BedStatus, BedStatus[]> = {
  AVAILABLE: ["OCCUPIED", "RESERVED", "BLOCKED", "MAINTENANCE", "ISOLATION"],
  OCCUPIED: ["TRANSFER_PENDING", "CLEANING"],
  RESERVED: ["OCCUPIED", "AVAILABLE"],
  CLEANING: ["AVAILABLE", "MAINTENANCE"],
  BLOCKED: ["AVAILABLE", "MAINTENANCE"],
  MAINTENANCE: ["AVAILABLE"],
  ISOLATION: ["CLEANING", "TRANSFER_PENDING"],
  TRANSFER_PENDING: ["OCCUPIED", "CLEANING"],
};

export class InvalidBedTransitionError extends Error {
  constructor(from: BedStatus, to: BedStatus) {
    super(`Illegal bed transition: ${from} -> ${to}`);
  }
}

/** Pure legality check, exported separately so it's unit-testable without a database. */
export function isTransitionAllowed(from: BedStatus, to: BedStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Every bed-status change goes through here so a BedStateEvent is always written — this is what lets the Command Center answer "why is this bed blocked" instead of just "this bed is blocked". */
export async function transitionBed(
  bedId: string,
  toStatus: BedStatus,
  opts: { reason?: string; byUserId?: string; patientId?: string; encounterId?: string } = {}
) {
  return prisma.$transaction(async (tx) => {
    const bed = await tx.bed.findUniqueOrThrow({ where: { id: bedId } });
    const allowed = ALLOWED_TRANSITIONS[bed.status] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new InvalidBedTransitionError(bed.status, toStatus);
    }
    const updated = await tx.bed.update({ where: { id: bedId }, data: { status: toStatus } });
    await tx.bedStateEvent.create({
      data: {
        bedId,
        fromStatus: bed.status,
        toStatus,
        reason: opts.reason,
        byUserId: opts.byUserId,
        patientId: opts.patientId,
        encounterId: opts.encounterId,
      },
    });
    return updated;
  });
}

export async function findAvailableBed(facilityId: string, wardId?: string) {
  return prisma.bed.findFirst({
    where: { facilityId, status: BedStatus.AVAILABLE, ...(wardId ? { wardId } : {}) },
    orderBy: { label: "asc" },
  });
}
