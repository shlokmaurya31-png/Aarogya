import { prisma } from "@/lib/db";
import { MedicationAdministrationStatus, type Prisma } from "@prisma/client";

const FREQUENCY_INTERVAL_HOURS: Record<string, number> = {
  OD: 24, "ONCE DAILY": 24,
  BD: 12, "TWICE DAILY": 12,
  TDS: 8, "THRICE DAILY": 8,
  QID: 6, "FOUR TIMES DAILY": 6,
  STAT: 0, PRN: 0,
};

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Generates the next few scheduled doses for a medication order, so the
 * Nursing task engine (brief §23) has real rows to surface. The mar-scheduler
 * consumer calls it on MedicationVerified (spine §2) with `from` = the
 * verification time, so the dose times are a pure function of the event and a
 * redelivery inserts nothing: (medicationOrderId, scheduledAt) is unique for
 * scheduled doses and duplicates are skipped. Returns the number inserted.
 */
export async function generateAdministrationSchedule(
  medicationOrderId: string,
  frequency: string,
  count = 3,
  opts: { from?: Date; db?: Db } = {},
): Promise<number> {
  const key = frequency.trim().toUpperCase();
  const intervalHours = FREQUENCY_INTERVAL_HOURS[key] ?? 8;
  const from = opts.from ?? new Date();

  const rows = Array.from({ length: intervalHours === 0 ? 1 : count }, (_, i) => ({
    medicationOrderId,
    scheduledAt: new Date(from.getTime() + i * intervalHours * 3_600_000),
    status: MedicationAdministrationStatus.DUE,
  }));

  const db = opts.db ?? prisma;
  const { count: inserted } = await db.medicationAdministration.createMany({ data: rows, skipDuplicates: true });
  return inserted;
}
