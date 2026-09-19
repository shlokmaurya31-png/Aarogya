import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import type { CommandSection } from "./types";

/**
 * DISCHARGE BOTTLENECKS — for clinically-ready but not-yet-discharged patients, each
 * unmet readiness flag on Discharge is a bottleneck with a canonical operational OWNER
 * (Billing / Documentation / Insurance / Pharmacy / Transport). No blame is assigned to
 * a person. Source: Discharge readiness flags. Blocked count is D8-configurable.
 */
export async function getDischarge(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const base = { dischargedAt: null, clinicallyReady: true, admission: { encounter: { facilityId: f } } };
  const [ready, billing, documentation, insurance, pharmacy, transport, blocked, oldest] = await Promise.all([
    prisma.discharge.count({ where: base }),
    prisma.discharge.count({ where: { ...base, billingReady: false } }),
    prisma.discharge.count({ where: { ...base, documentationReady: false } }),
    prisma.discharge.count({ where: { ...base, insuranceReady: false } }),
    prisma.discharge.count({ where: { ...base, pharmacyReady: false } }),
    prisma.discharge.count({ where: { ...base, transportReady: false } }),
    prisma.discharge.count({ where: { ...base, OR: [{ billingReady: false }, { documentationReady: false }, { insuranceReady: false }, { pharmacyReady: false }, { transportReady: false }] } }),
    prisma.discharge.findFirst({ where: { ...base, OR: [{ billingReady: false }, { documentationReady: false }, { insuranceReady: false }, { pharmacyReady: false }, { transportReady: false }] }, orderBy: { initiatedAt: "asc" }, select: { initiatedAt: true } }),
  ]);
  const oldestHours = oldest ? Math.round((ctx.now.getTime() - oldest.initiatedAt.getTime()) / 3_600_000) : 0;

  const metrics = [
    metric({ key: "dischargeBlocked", label: "Discharge-ready but blocked", value: blocked, unit: "patients", timeSemantics: "CURRENT_STATE", threshold: ctx.thresholds.dischargeBlocked, source: "Discharge", explanation: `${blocked} of ${ready} clinically-ready patients are held by an unmet readiness item.` }),
    metric({ key: "dischargeOldest", label: "Oldest blocked discharge", value: oldestHours, unit: "h", timeSemantics: "CURRENT_STATE", source: "Discharge" }),
    metric({ key: "dischargeReady", label: "Clinically ready", value: ready, unit: "patients", timeSemantics: "CURRENT_STATE", source: "Discharge" }),
  ];
  // Each bottleneck names its operational owner, not a person (§13).
  const drivers = [
    driver("Billing pending (Billing)", billing, "DIRECT", "/api/hospital/command-center/drilldown?kind=discharge-blockers&owner=billing"),
    driver("Insurance authorization pending (Insurance)", insurance, "DIRECT", "/api/hospital/command-center/drilldown?kind=discharge-blockers&owner=insurance"),
    driver("Medications pending (Pharmacy)", pharmacy, "DIRECT", "/api/hospital/command-center/drilldown?kind=discharge-blockers&owner=pharmacy"),
    driver("Documentation pending (Medical documentation)", documentation, "DIRECT", "/api/hospital/command-center/drilldown?kind=discharge-blockers&owner=documentation"),
    driver("Transport pending (Transport)", transport, "DIRECT", "/api/hospital/command-center/drilldown?kind=discharge-blockers&owner=transport"),
  ];
  return section(ctx, { key: "discharge", label: "Discharge bottlenecks", metrics, drivers, drillDown: "/api/hospital/command-center/drilldown?kind=discharge-blockers" });
}
