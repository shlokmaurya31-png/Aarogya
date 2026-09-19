import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section, pct } from "./_build";
import type { CommandSection } from "./types";

/**
 * ICU CAPACITY — occupancy of ICU-capable beds. Source: Bed (icuCapable OR icuUnitId).
 * Facility-level pending transfers/admission requests are shown as CONTRIBUTING drivers
 * (they cannot be reliably attributed to ICU specifically, so they are not presented as
 * ICU-specific direct drivers — no fabricated causality).
 */
export async function getIcu(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const icuWhere = { facilityId: f, OR: [{ icuCapable: true }, { icuUnitId: { not: null } }] };
  const [byStatus, total, ventilatorBeds, pendingTransfers, pendingAdmitReq] = await Promise.all([
    prisma.bed.groupBy({ by: ["status"], where: icuWhere, _count: true }),
    prisma.bed.count({ where: icuWhere }),
    prisma.bed.count({ where: { ...icuWhere, ventilatorCapable: true } }),
    prisma.transferRequest.count({ where: { facilityId: f, status: { notIn: ["COMPLETED", "CANCELLED", "REJECTED"] } } }),
    prisma.admissionRequest.count({ where: { facilityId: f, status: { in: ["PENDING", "DEFERRED"] } } }),
  ]);
  const counts = Object.fromEntries(byStatus.map((b) => [b.status, b._count])) as Record<string, number>;
  const available = counts.AVAILABLE ?? 0;
  const blocked = (counts.BLOCKED ?? 0) + (counts.MAINTENANCE ?? 0);
  const occupancy = pct(total - available, total);

  const metrics = [
    metric({ key: "icuOccupancy", label: "ICU occupancy", value: occupancy, unit: "%", timeSemantics: "CURRENT_STATE", threshold: ctx.thresholds.icuOccupancy, source: "Bed (ICU)", explanation: total > 0 ? `${total - available}/${total} ICU beds in use.` : "No ICU-capable beds configured." }),
    metric({ key: "icuAvailable", label: "ICU beds available", value: available, unit: "beds", timeSemantics: "CURRENT_STATE", source: "Bed (ICU)" }),
    metric({ key: "icuVentilators", label: "Ventilator-capable ICU beds", value: ventilatorBeds, unit: "beds", timeSemantics: "CURRENT_STATE", source: "Bed (ICU)" }),
    metric({ key: "icuBlocked", label: "ICU beds blocked", value: blocked, unit: "beds", timeSemantics: "CURRENT_STATE", source: "Bed (ICU)" }),
  ];
  const drivers = [
    driver("ICU beds occupied", total - available, "DIRECT"),
    driver("ICU beds blocked/maintenance", blocked, "DIRECT"),
    driver("Facility pending transfers", pendingTransfers, "CONTRIBUTING"),
    driver("Facility pending admission requests", pendingAdmitReq, "CONTRIBUTING"),
  ];
  return section(ctx, { key: "icu", label: "ICU capacity", metrics, drivers, drillDown: "/api/hospital/command-center/drilldown?kind=icu-beds" });
}
