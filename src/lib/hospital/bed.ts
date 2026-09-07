import { prisma } from "@/lib/db";
import { BedStatus, Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";

type Db = Prisma.TransactionClient | typeof prisma;

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

/** Thrown when a guarded concurrent bed-status update affects zero rows — someone else won the race. */
export class BedConcurrencyError extends BadRequestError {
  constructor(bedId: string) {
    super(`Bed ${bedId} was changed by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

/** Pure legality check, exported separately so it's unit-testable without a database. */
export function isTransitionAllowed(from: BedStatus, to: BedStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Every bed-status change goes through here so a BedStateEvent is always
 * written — this is what lets the Command Center answer "why is this bed
 * blocked" instead of just "this bed is blocked".
 *
 * Accepts an optional Prisma transaction client so Phase 2's
 * request/reservation flows (admissionRequest.ts, transferRequest.ts) can
 * compose a bed transition into their own larger atomic operation (e.g.
 * "reserve this bed AND mark the admission request BED_RESERVED" must
 * commit or fail together) — reusing this exact legality check and
 * BedStateEvent-writing logic rather than duplicating it inline.
 */
export async function transitionBed(
  bedId: string,
  toStatus: BedStatus,
  opts: { reason?: string; byUserId?: string; patientId?: string; encounterId?: string } = {},
  db: Db = prisma
) {
  const run = async (tx: Db) => {
    const bed = await tx.bed.findUniqueOrThrow({ where: { id: bedId } });
    const allowed = ALLOWED_TRANSITIONS[bed.status] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new InvalidBedTransitionError(bed.status, toStatus);
    }
    // Guarded CAS, not a blind update: the WHERE clause re-checks the status
    // we just observed at write time, so a concurrent transition (another
    // request racing us between the read above and this write) affects zero
    // rows here instead of silently overwriting it.
    const result = await tx.bed.updateMany({ where: { id: bedId, status: bed.status }, data: { status: toStatus } });
    if (result.count !== 1) throw new BedConcurrencyError(bedId);
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
    return { ...bed, status: toStatus };
  };
  // If we were handed a transaction client, run inline (composed into the caller's
  // transaction); otherwise open our own, matching the original standalone behavior.
  return db === prisma ? prisma.$transaction((tx) => run(tx)) : run(db);
}

export async function findAvailableBed(facilityId: string, wardId?: string) {
  return prisma.bed.findFirst({
    where: { facilityId, status: BedStatus.AVAILABLE, ...(wardId ? { wardId } : {}) },
    orderBy: { label: "asc" },
  });
}

/**
 * Bed matching for admission/transfer requests (brief §30) — a ranked list
 * of eligible beds for staff to choose from, never an auto-pick of "the
 * first available bed." Filters on facility, ward type, gender
 * compatibility, and isolation requirement; ordering favors an exact
 * ward-type match before falling back to any available bed when the
 * request didn't specify one.
 */
export async function findEligibleBeds(
  facilityId: string,
  criteria: { wardType?: string; isolationRequired?: boolean; genderRestriction?: string | null }
) {
  const beds = await prisma.bed.findMany({
    where: {
      facilityId,
      status: BedStatus.AVAILABLE,
      ...(criteria.isolationRequired ? { isolationRequired: true } : {}),
      ...(criteria.genderRestriction
        ? { OR: [{ genderRestriction: null }, { genderRestriction: criteria.genderRestriction }] }
        : {}),
    },
    include: { ward: true },
    orderBy: [{ ward: { name: "asc" } }, { label: "asc" }],
  });

  if (!criteria.wardType) return beds;
  const exact = beds.filter((b) => b.ward.wardType === criteria.wardType);
  const rest = beds.filter((b) => b.ward.wardType !== criteria.wardType);
  return [...exact, ...rest];
}
