import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import type { CommandSection } from "./types";

/**
 * ED PRESSURE — current queue + census with a canonical WHY. Source: QueueEntry (ED)
 * for waiting/longest-wait, Encounter (type ED) for census/arrivals. Waiting count and
 * longest-wait interpretation are D8-configurable.
 */
export async function getEmergency(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const [waiting, longest, census, arrivals, dispositionPending, bedsAvailable] = await Promise.all([
    prisma.queueEntry.count({ where: { facilityId: f, queueType: "ED", status: "WAITING" } }),
    prisma.queueEntry.findFirst({ where: { facilityId: f, queueType: "ED", status: "WAITING" }, orderBy: { enteredAt: "asc" }, select: { enteredAt: true } }),
    prisma.encounter.count({ where: { facilityId: f, type: "ED", status: { notIn: ["DISCHARGED", "CLOSED"] } } }),
    prisma.encounter.count({ where: { facilityId: f, type: "ED", registeredAt: { gte: ctx.window.from, lte: ctx.window.to } } }),
    prisma.encounter.count({ where: { facilityId: f, type: "ED", status: "INVESTIGATING" } }),
    prisma.bed.count({ where: { facilityId: f, status: "AVAILABLE" } }),
  ]);
  const longestMin = longest ? Math.round((ctx.now.getTime() - longest.enteredAt.getTime()) / 60000) : 0;

  const metrics = [
    metric({ key: "edWaiting", label: "Patients waiting (ED)", value: waiting, unit: "patients", timeSemantics: "CURRENT_STATE", threshold: ctx.thresholds.edWaiting, source: "QueueEntry" }),
    metric({ key: "edLongestWait", label: "Longest ED wait", value: longestMin, unit: "min", timeSemantics: "CURRENT_STATE", threshold: ctx.thresholds.edLongestWait, source: "QueueEntry", explanation: "Time the oldest still-waiting ED patient has been in the queue." }),
    metric({ key: "edCensus", label: "ED census", value: census, unit: "patients", timeSemantics: "CURRENT_STATE", source: "Encounter" }),
    metric({ key: "edArrivals", label: `ED arrivals (${ctx.window.label.toLowerCase()})`, value: arrivals, unit: "patients", timeSemantics: "PERIOD_AGGREGATE", source: "Encounter" }),
  ];
  const drivers = [
    driver("Currently waiting", waiting, "DIRECT", "/api/hospital/command-center/drilldown?kind=ed-queue"),
    driver("Longest wait (min)", longestMin, "DIRECT"),
    driver(`Arrivals in ${ctx.window.label.toLowerCase()}`, arrivals, "CONTRIBUTING"),
    driver("Disposition pending (investigating)", dispositionPending, "CONTRIBUTING"),
    driver("Beds available (flow constraint)", bedsAvailable, "CONTRIBUTING"),
  ];
  return section(ctx, { key: "emergency", label: "ED pressure", metrics, drivers, drillDown: "/api/hospital/command-center/drilldown?kind=ed-queue" });
}
