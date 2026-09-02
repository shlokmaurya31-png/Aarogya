import { prisma } from "@/lib/db";
import { MedicationAdministrationStatus } from "@prisma/client";

const FREQUENCY_INTERVAL_HOURS: Record<string, number> = {
  OD: 24, "ONCE DAILY": 24,
  BD: 12, "TWICE DAILY": 12,
  TDS: 8, "THRICE DAILY": 8,
  QID: 6, "FOUR TIMES DAILY": 6,
  STAT: 0, PRN: 0,
};

/** Generates the next few scheduled doses for a new medication order, so the Nursing task engine (brief §23) has real rows to surface rather than nothing. */
export async function generateAdministrationSchedule(medicationOrderId: string, frequency: string, count = 3) {
  const key = frequency.trim().toUpperCase();
  const intervalHours = FREQUENCY_INTERVAL_HOURS[key] ?? 8;

  const rows = Array.from({ length: intervalHours === 0 ? 1 : count }, (_, i) => ({
    medicationOrderId,
    scheduledAt: new Date(Date.now() + i * intervalHours * 3_600_000),
    status: MedicationAdministrationStatus.DUE,
  }));

  await prisma.medicationAdministration.createMany({ data: rows });
}
