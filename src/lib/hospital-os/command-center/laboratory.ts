import { prisma } from "@/lib/db";
import { getDiagnosticsOperationalCounts } from "@/lib/hospital/diagnosticsSnapshot";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import type { CommandSection } from "./types";

/**
 * LAB TAT — turnaround-time intelligence. TAT is defined as ORDER-TO-RESULT:
 * `LabResult.resultedAt − LabOrder.orderedAt` (documented explicitly, never silently
 * mixed with collection-to-result). Averages come from a BOUNDED sample of recent
 * current results in the window; pending-stage + critical counts reuse the canonical
 * diagnostics snapshot. Average-TAT interpretation is D8-configurable (labTat).
 */
export async function getLaboratory(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const warnMin = ctx.thresholds.labTat.warning ?? 240;
  const [diag, results] = await Promise.all([
    getDiagnosticsOperationalCounts(f),
    prisma.labResult.findMany({
      where: { isCurrent: true, resultedAt: { gte: ctx.window.from, lte: ctx.window.to }, labOrder: { encounter: { facilityId: f } } },
      select: { resultedAt: true, labOrder: { select: { orderedAt: true } } },
      orderBy: { resultedAt: "desc" }, take: 500,
    }),
  ]);
  const tats = results.map((r) => Math.round((r.resultedAt.getTime() - r.labOrder.orderedAt.getTime()) / 60000)).filter((n) => n >= 0);
  const avg = tats.length ? Math.round(tats.reduce((a, b) => a + b, 0) / tats.length) : null;
  const median = tats.length ? [...tats].sort((a, b) => a - b)[Math.floor(tats.length / 2)] : null;
  const breaches = tats.filter((n) => n > warnMin).length;

  const metrics = [
    metric({ key: "labTatAvg", label: "Average lab TAT", value: avg, unit: "min", timeSemantics: "PERIOD_AGGREGATE", threshold: ctx.thresholds.labTat, source: "LabResult/LabOrder", explanation: `Order-to-result over ${tats.length} result(s) in ${ctx.window.label.toLowerCase()}.`, confidence: "DERIVED" }),
    metric({ key: "labTatMedian", label: "Median lab TAT", value: median, unit: "min", timeSemantics: "PERIOD_AGGREGATE", source: "LabResult/LabOrder", confidence: "DERIVED" }),
    metric({ key: "labTatBreaches", label: "TAT breaches", value: breaches, unit: "results", timeSemantics: "PERIOD_AGGREGATE", source: "LabResult/LabOrder", explanation: `Results exceeding the configured warning TAT (${warnMin}m).`, confidence: "DERIVED" }),
    metric({ key: "labPendingVerification", label: "Results pending verification", value: diag.pending.resultsPendingVerification, unit: "results", timeSemantics: "CURRENT_STATE", source: "LabResult" }),
  ];
  const drivers = [
    driver("Specimens pending collection", diag.pending.specimensPendingCollection, "DIRECT"),
    driver("Results awaiting verification", diag.pending.resultsPendingVerification, "DIRECT"),
    driver("Specimens rejected, awaiting recollection", diag.pending.specimensRejectedAwaitingRecollection, "CONTRIBUTING"),
    driver("TAT breaches in window", breaches, "DIRECT", "/api/hospital/command-center/drilldown?kind=lab-breaches"),
    driver("Critical labs awaiting acknowledgement", diag.safety.criticalLab, "CONTRIBUTING"),
  ];
  return section(ctx, { key: "laboratory", label: "Lab TAT", metrics, drivers, drillDown: "/api/hospital/command-center/drilldown?kind=lab-breaches" });
}
