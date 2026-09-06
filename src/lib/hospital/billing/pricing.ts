import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

export class TariffConflictError extends BadRequestError {
  constructor() {
    super("An active tariff already covers this facility/charge code/payer for an overlapping period.");
  }
}

export class PriceNotFoundError extends NotFoundError {
  constructor(chargeCode: string) {
    super(`No active tariff found for charge code "${chargeCode}" on the given date.`);
  }
}

/** The seeded self-pay sentinel — every Tariff/Invoice needs a real Payer row, never payerId: null (see Tariff's doc comment). */
export async function getCashPayerId(tx: Tx | typeof prisma = prisma): Promise<string> {
  const cash = await tx.payer.findFirst({ where: { type: "CASH" } });
  if (!cash) throw new Error("Seeded CASH payer not found — run the seed script.");
  return cash.id;
}

/** Postgres GiST exclusion-constraint violation for Tariff overlap — same defensive text-match pattern as imagingStudyLifecycle.ts's isExclusionViolation (Prisma has no first-class error-code mapping for EXCLUDE constraints). */
function isTariffExclusionViolation(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${JSON.stringify((err as { meta?: unknown }).meta ?? "")}` : String(err);
  return /23P01|exclusion_violation|tariff_no_overlap/i.test(text);
}

/** Pure half-open-interval overlap predicate — [aFrom,aTo) intersects [bFrom,bTo) — extracted so it's unit-testable without a DB, same convention as isStudyTransitionAllowed. Null end = open-ended (never expires). */
export function dateRangesOverlap(aFrom: Date, aTo: Date | null, bFrom: Date, bTo: Date | null): boolean {
  const aEndsAfterBStarts = aTo === null || aTo > bFrom;
  const bEndsAfterAStarts = bTo === null || bTo > aFrom;
  return aEndsAfterBStarts && bEndsAfterAStarts;
}

/**
 * Effective-dated pricing — never overwrites historical pricing. Overlap
 * invariant checked app-side (same idiom as ImagingStudy scheduling) and
 * backstopped on Postgres by a GiST exclusion constraint (see
 * prisma/migrations-postgres-baseline) — the app-level check alone can't
 * close a genuine concurrent race between two overlapping-range creates.
 */
export async function createTariff(
  tx: Tx,
  input: {
    facilityId: string;
    payerId: string;
    chargeCode: string;
    description: string;
    category: string;
    unitPriceMinor: number;
    currency?: string;
    effectiveFrom: Date;
    effectiveTo?: Date | null;
    createdByUserId: string;
  }
) {
  // Narrow with an indexed DB query first (cheap), then apply the exact
  // pure overlap predicate in-process — avoids re-deriving the same
  // half-open-interval logic twice in two different query shapes.
  const candidates = await tx.tariff.findMany({
    where: { facilityId: input.facilityId, payerId: input.payerId, chargeCode: input.chargeCode, active: true },
    select: { effectiveFrom: true, effectiveTo: true },
  });
  const hasOverlap = candidates.some((c) => dateRangesOverlap(input.effectiveFrom, input.effectiveTo ?? null, c.effectiveFrom, c.effectiveTo));
  if (hasOverlap) throw new TariffConflictError();

  try {
    return await tx.tariff.create({
      data: {
        facilityId: input.facilityId,
        payerId: input.payerId,
        chargeCode: input.chargeCode,
        description: input.description,
        category: input.category,
        unitPriceMinor: input.unitPriceMinor,
        currency: input.currency ?? "INR",
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        createdByUserId: input.createdByUserId,
      },
    });
  } catch (err) {
    if (isTariffExclusionViolation(err)) throw new TariffConflictError();
    throw err;
  }
}

/** Deactivates a tariff (end-dates it) rather than deleting — historical pricing is never destroyed. */
export async function deactivateTariff(tx: Tx, tariffId: string, effectiveTo: Date = new Date()) {
  return tx.tariff.update({ where: { id: tariffId }, data: { active: false, effectiveTo } });
}

/**
 * Deterministic: given (facility, chargeCode, payerId, date), always
 * produces the same price. Falls back to the CASH sentinel payer when no
 * payerId is supplied (self-pay is the default pricing context for a
 * freshly-ordered service before any coverage is attached).
 */
export async function priceFor(
  facilityId: string,
  chargeCode: string,
  atDate: Date,
  payerId?: string
): Promise<{ unitPriceMinor: number; currency: string; tariffId: string }> {
  const effectivePayerId = payerId ?? (await getCashPayerId());
  const tariff = await prisma.tariff.findFirst({
    where: {
      facilityId,
      chargeCode,
      payerId: effectivePayerId,
      active: true,
      effectiveFrom: { lte: atDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: atDate } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
  if (!tariff) throw new PriceNotFoundError(chargeCode);
  return { unitPriceMinor: tariff.unitPriceMinor, currency: tariff.currency, tariffId: tariff.id };
}
