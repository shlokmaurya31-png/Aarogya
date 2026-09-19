import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import type { CommandSection } from "./types";

/**
 * INFECTION — operational status from the canonical infection-control model
 * (InfectionIncident / InfectionInvestigation). Aggregate operational indicators only;
 * no clinical surveillance is inferred from diagnoses. Active-incident count is
 * D8-configurable (infectionActive).
 */
export async function getInfection(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const active = { facilityId: f, status: { notIn: ["RESOLVED", "CLOSED", "CANCELLED"] } };
  const [activeCount, isolation, actionRequired, openInvestigations, byType] = await Promise.all([
    prisma.infectionIncident.count({ where: active }),
    prisma.infectionIncident.count({ where: { ...active, isolationRequired: true } }),
    prisma.infectionIncident.count({ where: { facilityId: f, status: "ACTION_REQUIRED" } }),
    prisma.infectionInvestigation.count({ where: { facilityId: f, status: "OPEN" } }),
    prisma.infectionIncident.groupBy({ by: ["incidentType"], where: active, _count: { _all: true } }),
  ]);

  const metrics = [
    metric({ key: "infectionActive", label: "Active infection incidents", value: activeCount, unit: "incidents", timeSemantics: "CURRENT_STATE", threshold: ctx.thresholds.infectionActive, source: "InfectionIncident" }),
    metric({ key: "infectionIsolation", label: "Requiring isolation", value: isolation, unit: "incidents", timeSemantics: "CURRENT_STATE", status: isolation > 0 ? "WATCH" : "NORMAL", source: "InfectionIncident" }),
    metric({ key: "infectionActionRequired", label: "Action required", value: actionRequired, unit: "incidents", timeSemantics: "CURRENT_STATE", status: actionRequired > 0 ? "WARNING" : "NORMAL", source: "InfectionIncident" }),
    metric({ key: "infectionOpenInvestigations", label: "Open investigations", value: openInvestigations, unit: "investigations", timeSemantics: "CURRENT_STATE", source: "InfectionInvestigation" }),
  ];
  const drivers = [
    driver("Action required", actionRequired, "DIRECT"),
    driver("Requiring isolation", isolation, "DIRECT"),
    driver("Open investigations", openInvestigations, "CONTRIBUTING"),
    ...byType.map((b) => driver(`Type: ${b.incidentType}`, b._count._all, "CONTRIBUTING")),
  ];
  return section(ctx, { key: "infection", label: "Infection control", metrics, drivers, drillDown: null });
}
