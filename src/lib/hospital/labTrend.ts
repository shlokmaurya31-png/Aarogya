import { prisma } from "@/lib/db";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";

/**
 * Flagship 5 — one test's results over time for the chart: this hospital's
 * verified results, and the results imported from its previous system
 * (LegacyLabResult), each point labelled. Imported points say "imported"; a
 * converted one keeps the value and unit as sent beside it. Numeric values
 * only (a trend is a line), oldest first.
 */
export interface TrendPoint { at: string; value: number; unit: string | null; source: "RESULT" | "IMPORTED"; label: string | null; sent: { value: string; unit: string } | null }

export async function labTrend(patientId: string, testName: string, opts: { limit?: number } = {}) {
  const ids = await resolvePatientIdsForRead(patientId);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const [live, imported] = await Promise.all([
    prisma.labResult.findMany({
      where: { status: "VERIFIED", isCurrent: true, numericValue: { not: null }, labOrder: { patientId: { in: ids }, testName: { equals: testName, mode: "insensitive" } } },
      select: { numericValue: true, unit: true, resultedAt: true, verifiedAt: true },
      orderBy: { resultedAt: "desc" }, take: limit,
    }),
    prisma.legacyLabResult.findMany({
      where: { patientId: { in: ids }, testName: { equals: testName, mode: "insensitive" }, numericValue: { not: null } },
      select: { numericValue: true, unit: true, observedAt: true, originalValue: true, originalUnit: true },
      orderBy: { observedAt: "desc" }, take: limit,
    }),
  ]);
  const points: TrendPoint[] = [
    ...live.map((r) => ({ at: r.resultedAt.toISOString(), value: r.numericValue!, unit: r.unit, source: "RESULT" as const, label: null, sent: null })),
    ...imported.map((r) => ({ at: r.observedAt.toISOString(), value: r.numericValue!, unit: r.unit, source: "IMPORTED" as const, label: "imported", sent: r.originalUnit ? { value: r.originalValue ?? "", unit: r.originalUnit } : null })),
  ].sort((a, b) => a.at.localeCompare(b.at)).slice(-limit);
  return { testName, points };
}
