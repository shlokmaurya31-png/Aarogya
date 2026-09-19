import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import { worstStatus, type CommandSection } from "./types";

/**
 * CRITICAL RESULTS — operational acknowledgement status of critical diagnostics.
 * AGGREGATE ONLY: counts and ages, never patient identity or result values in the
 * Command Center view (patient-level detail requires clinical authorization via a
 * separate drill-down). Source: LabResult / ImagingReport (isCritical, acknowledgedAt).
 */
export async function getCriticalResults(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const overdueBefore = new Date(ctx.now.getTime() - 3_600_000); // pending > 1h = overdue
  const [labPending, imgPending, labOverdue, imgOverdue, oldestLab, oldestImg] = await Promise.all([
    prisma.labResult.count({ where: { isCurrent: true, isCritical: true, acknowledgedAt: null, labOrder: { encounter: { facilityId: f } } } }),
    prisma.imagingReport.count({ where: { isCurrent: true, isCritical: true, acknowledgedAt: null, imagingOrder: { encounter: { facilityId: f } } } }),
    prisma.labResult.count({ where: { isCurrent: true, isCritical: true, acknowledgedAt: null, resultedAt: { lt: overdueBefore }, labOrder: { encounter: { facilityId: f } } } }),
    prisma.imagingReport.count({ where: { isCurrent: true, isCritical: true, acknowledgedAt: null, reportedAt: { lt: overdueBefore }, imagingOrder: { encounter: { facilityId: f } } } }),
    prisma.labResult.findFirst({ where: { isCurrent: true, isCritical: true, acknowledgedAt: null, labOrder: { encounter: { facilityId: f } } }, orderBy: { resultedAt: "asc" }, select: { resultedAt: true } }),
    prisma.imagingReport.findFirst({ where: { isCurrent: true, isCritical: true, acknowledgedAt: null, imagingOrder: { encounter: { facilityId: f } } }, orderBy: { reportedAt: "asc" }, select: { reportedAt: true } }),
  ]);
  const pending = labPending + imgPending;
  const overdue = labOverdue + imgOverdue;
  const oldestTs = [oldestLab?.resultedAt, oldestImg?.reportedAt].filter(Boolean).map((d) => d!.getTime());
  const oldestMin = oldestTs.length ? Math.round((ctx.now.getTime() - Math.min(...oldestTs)) / 60000) : 0;

  const t = ctx.thresholds.criticalResultsPending;
  const metrics = [
    metric({ key: "criticalPending", label: "Critical results pending acknowledgement", value: pending, unit: "results", timeSemantics: "CURRENT_STATE", threshold: t, source: "LabResult/ImagingReport" }),
    metric({ key: "criticalOverdue", label: "Acknowledgement overdue (>1h)", value: overdue, unit: "results", timeSemantics: "CURRENT_STATE", status: overdue >= (t.critical ?? 3) ? "CRITICAL" : overdue > 0 ? "WARNING" : "NORMAL", source: "LabResult/ImagingReport" }),
    metric({ key: "criticalOldest", label: "Oldest unacknowledged", value: oldestMin, unit: "min", timeSemantics: "CURRENT_STATE", source: "LabResult/ImagingReport" }),
  ];
  const drivers = [
    driver("Critical labs pending", labPending, "DIRECT"),
    driver("Critical imaging pending", imgPending, "DIRECT"),
    driver("Overdue (>1h)", overdue, "DIRECT"),
  ];
  const s = section(ctx, { key: "criticalResults", label: "Critical results", metrics, drivers, drillDown: null });
  s.status = worstStatus(s.status);
  return s;
}
