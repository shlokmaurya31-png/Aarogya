import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section, pct } from "./_build";
import { startOfToday } from "./filters";
import type { CommandSection } from "./types";

/**
 * BED CAPACITY — current-state occupancy with a canonical WHY view. Source: Bed
 * (status) + Ward; flow drivers from Admission/Discharge/AdmissionRequest/
 * TransferRequest. Occupancy % is computed; only its status interpretation is
 * D8-configurable (bedOccupancy thresholds).
 */
export async function getCapacity(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const today = startOfToday(ctx.now);
  const [byStatus, total, admissionsToday, dischargesToday, blocked, pendingTransfers, pendingAdmitReq, dischargeReadyWaiting] = await Promise.all([
    prisma.bed.groupBy({ by: ["status"], where: { facilityId: f }, _count: true }),
    prisma.bed.count({ where: { facilityId: f } }),
    prisma.admission.count({ where: { admittedAt: { gte: today }, encounter: { facilityId: f } } }),
    prisma.discharge.count({ where: { dischargedAt: { gte: today }, admission: { encounter: { facilityId: f } } } }),
    prisma.bed.count({ where: { facilityId: f, status: { in: ["BLOCKED", "MAINTENANCE"] } } }),
    prisma.transferRequest.count({ where: { facilityId: f, status: { notIn: ["COMPLETED", "CANCELLED", "REJECTED"] } } }),
    prisma.admissionRequest.count({ where: { facilityId: f, status: { in: ["PENDING", "DEFERRED"] } } }),
    prisma.discharge.count({ where: { dischargedAt: null, clinicallyReady: true, admission: { encounter: { facilityId: f } } } }),
  ]);

  const counts = Object.fromEntries(byStatus.map((b) => [b.status, b._count])) as Record<string, number>;
  const available = counts.AVAILABLE ?? 0;
  const reserved = counts.RESERVED ?? 0;
  const cleaning = counts.CLEANING ?? 0;
  const occupancy = pct(total - available, total);
  const t = ctx.thresholds.bedOccupancy;

  const metrics = [
    metric({ key: "bedOccupancy", label: "Bed occupancy", value: occupancy, unit: "%", timeSemantics: "CURRENT_STATE", threshold: t, source: "Bed", explanation: `${total - available}/${total} beds in use.` }),
    metric({ key: "bedsAvailable", label: "Beds available", value: available, unit: "beds", timeSemantics: "CURRENT_STATE", source: "Bed" }),
    metric({ key: "bedsBlocked", label: "Beds blocked / maintenance", value: blocked, unit: "beds", timeSemantics: "CURRENT_STATE", source: "Bed" }),
  ];

  const drivers = [
    driver("Admissions today", admissionsToday, "DIRECT"),
    driver("Discharges today", -dischargesToday, "DIRECT"),
    driver("Beds blocked / maintenance", blocked, "DIRECT", "/api/hospital/command-center/drilldown?kind=blocked-beds"),
    driver("Discharge-ready patients still occupying a bed", dischargeReadyWaiting, "DIRECT", "/api/hospital/command-center/drilldown?kind=discharge-blockers"),
    driver("Pending transfers", pendingTransfers, "CONTRIBUTING"),
    driver("Pending admission requests", pendingAdmitReq, "CONTRIBUTING"),
    driver("Reserved beds", reserved, "CONTRIBUTING"),
    driver("Beds in turnaround (cleaning)", cleaning, "CONTRIBUTING"),
  ];

  return section(ctx, { key: "capacity", label: "Bed capacity", metrics, drivers, drillDown: "/api/hospital/command-center/drilldown?kind=ward-occupancy" });
}
