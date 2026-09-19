import { prisma } from "@/lib/db";
import { getDiagnosticsOperationalCounts } from "@/lib/hospital/diagnosticsSnapshot";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import type { CommandSection } from "./types";

/**
 * RADIOLOGY TAT — same rigor as lab. TAT is ORDER-TO-REPORT:
 * `ImagingReport.reportedAt − ImagingOrder.orderedAt`. Pending-stage + critical counts
 * reuse the canonical diagnostics snapshot. Interpretation is D8-configurable (radiologyTat).
 */
export async function getRadiology(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const warnMin = ctx.thresholds.radiologyTat.warning ?? 480;
  const [diag, reports] = await Promise.all([
    getDiagnosticsOperationalCounts(f),
    prisma.imagingReport.findMany({
      where: { isCurrent: true, reportedAt: { gte: ctx.window.from, lte: ctx.window.to }, imagingOrder: { encounter: { facilityId: f } } },
      select: { reportedAt: true, imagingOrder: { select: { orderedAt: true } } },
      orderBy: { reportedAt: "desc" }, take: 500,
    }),
  ]);
  const tats = reports.map((r) => Math.round((r.reportedAt.getTime() - r.imagingOrder.orderedAt.getTime()) / 60000)).filter((n) => n >= 0);
  const avg = tats.length ? Math.round(tats.reduce((a, b) => a + b, 0) / tats.length) : null;
  const median = tats.length ? [...tats].sort((a, b) => a - b)[Math.floor(tats.length / 2)] : null;
  const breaches = tats.filter((n) => n > warnMin).length;

  const metrics = [
    metric({ key: "radTatAvg", label: "Average radiology TAT", value: avg, unit: "min", timeSemantics: "PERIOD_AGGREGATE", threshold: ctx.thresholds.radiologyTat, source: "ImagingReport/ImagingOrder", explanation: `Order-to-report over ${tats.length} report(s) in ${ctx.window.label.toLowerCase()}.`, confidence: "DERIVED" }),
    metric({ key: "radTatMedian", label: "Median radiology TAT", value: median, unit: "min", timeSemantics: "PERIOD_AGGREGATE", source: "ImagingReport/ImagingOrder", confidence: "DERIVED" }),
    metric({ key: "radTatBreaches", label: "TAT breaches", value: breaches, unit: "reports", timeSemantics: "PERIOD_AGGREGATE", source: "ImagingReport/ImagingOrder", explanation: `Reports exceeding the configured warning TAT (${warnMin}m).`, confidence: "DERIVED" }),
    metric({ key: "radReportsPendingVerification", label: "Reports pending verification", value: diag.pending.reportsPendingVerification, unit: "reports", timeSemantics: "CURRENT_STATE", source: "ImagingReport" }),
  ];
  const drivers = [
    driver("Studies pending scheduling", diag.pending.studiesPendingScheduling, "DIRECT"),
    driver("Studies scheduled awaiting arrival", diag.pending.studiesScheduledAwaitingArrival, "CONTRIBUTING"),
    driver("Reports awaiting verification", diag.pending.reportsPendingVerification, "DIRECT"),
    driver("TAT breaches in window", breaches, "DIRECT", "/api/hospital/command-center/drilldown?kind=radiology-breaches"),
    driver("Critical findings awaiting acknowledgement", diag.safety.criticalImaging, "CONTRIBUTING"),
  ];
  return section(ctx, { key: "radiology", label: "Radiology TAT", metrics, drivers, drillDown: "/api/hospital/command-center/drilldown?kind=radiology-breaches" });
}
