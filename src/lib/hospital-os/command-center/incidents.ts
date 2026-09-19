import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import type { CommandSection } from "./types";

/**
 * INCIDENTS — operational safety/quality incidents (QualityIncident). Aggregate counts
 * only; RESTRICTED-confidentiality detail is never exposed here (patient/individual
 * detail requires the quality drill-down + permission). Requires `quality:incident:read`
 * to view. High-severity open count is D8-configurable (incidentsHigh).
 */
export async function getIncidents(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const open = { facilityId: f, status: { notIn: ["RESOLVED", "CLOSED", "CANCELLED"] } };
  const overdueBefore = new Date(ctx.now.getTime() - 7 * 86_400_000);
  const [openCount, highOpen, overdueInvestigations, actionRequired, byCategory] = await Promise.all([
    prisma.qualityIncident.count({ where: open }),
    prisma.qualityIncident.count({ where: { ...open, severity: { in: ["HIGH", "CRITICAL"] } } }),
    prisma.qualityIncident.count({ where: { facilityId: f, status: "UNDER_INVESTIGATION", reportedAt: { lt: overdueBefore } } }),
    prisma.qualityIncident.count({ where: { facilityId: f, status: "ACTION_REQUIRED" } }),
    prisma.qualityIncident.groupBy({ by: ["category"], where: open, _count: { _all: true } }),
  ]);

  const metrics = [
    metric({ key: "incidentsHigh", label: "High-severity open incidents", value: highOpen, unit: "incidents", timeSemantics: "CURRENT_STATE", threshold: ctx.thresholds.incidentsHigh, source: "QualityIncident" }),
    metric({ key: "incidentsOpen", label: "Open incidents", value: openCount, unit: "incidents", timeSemantics: "CURRENT_STATE", source: "QualityIncident" }),
    metric({ key: "incidentsOverdueInvestigation", label: "Overdue investigations (>7d)", value: overdueInvestigations, unit: "incidents", timeSemantics: "CURRENT_STATE", status: overdueInvestigations > 0 ? "WARNING" : "NORMAL", source: "QualityIncident" }),
    metric({ key: "incidentsActionRequired", label: "Corrective action required", value: actionRequired, unit: "incidents", timeSemantics: "CURRENT_STATE", status: actionRequired > 0 ? "WATCH" : "NORMAL", source: "QualityIncident" }),
  ];
  const drivers = [
    driver("High-severity open", highOpen, "DIRECT"),
    driver("Overdue investigations", overdueInvestigations, "DIRECT"),
    driver("Corrective action required", actionRequired, "DIRECT"),
    ...byCategory.map((b) => driver(`Category: ${b.category}`, b._count._all, "CONTRIBUTING")),
  ];
  return section(ctx, { key: "incidents", label: "Incidents", metrics, drivers, drillDown: null });
}
