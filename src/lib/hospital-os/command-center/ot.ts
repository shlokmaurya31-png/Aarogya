import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import { startOfToday } from "./filters";
import type { CommandSection } from "./types";

/**
 * OT / OPERATING THEATRE — schedule status from canonical Surgery + SurgerySchedule.
 * A "delayed" case is one whose scheduled start has passed but is not yet IN_PROGRESS/
 * COMPLETED. Theatre utilization is intentionally NOT computed (operating-hours are not
 * modelled) rather than inferred — see the driver marked UNAVAILABLE.
 */
export async function getOt(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const today = startOfToday(ctx.now);
  const [scheduled, inProgress, completedToday, cancelledToday, theatres, delayed] = await Promise.all([
    prisma.surgery.count({ where: { facilityId: f, status: "SCHEDULED" } }),
    prisma.surgery.count({ where: { facilityId: f, status: "IN_PROGRESS" } }),
    prisma.surgery.count({ where: { facilityId: f, status: "COMPLETED", updatedAt: { gte: today } } }),
    prisma.surgery.count({ where: { facilityId: f, status: "CANCELLED", updatedAt: { gte: today } } }),
    prisma.operatingTheatre.count({ where: { facilityId: f } }),
    prisma.surgerySchedule.count({ where: { facilityId: f, status: "SCHEDULED", startAt: { lt: ctx.now }, surgery: { status: { in: ["SCHEDULED", "APPROVED", "REVIEWED"] } } } }),
  ]);

  const metrics = [
    metric({ key: "otScheduled", label: "Surgeries scheduled", value: scheduled, unit: "cases", timeSemantics: "CURRENT_STATE", source: "Surgery" }),
    metric({ key: "otInProgress", label: "Surgeries in progress", value: inProgress, unit: "cases", timeSemantics: "CURRENT_STATE", source: "Surgery" }),
    metric({ key: "otDelayed", label: "Delayed starts", value: delayed, unit: "cases", timeSemantics: "CURRENT_STATE", threshold: ctx.thresholds.otDelayed, source: "SurgerySchedule", explanation: "Scheduled start time passed but the case has not started.", confidence: "DERIVED" }),
    metric({ key: "otCompletedToday", label: "Completed today", value: completedToday, unit: "cases", timeSemantics: "PERIOD_AGGREGATE", source: "Surgery" }),
    metric({ key: "otCancelledToday", label: "Cancelled today", value: cancelledToday, unit: "cases", timeSemantics: "PERIOD_AGGREGATE", source: "Surgery" }),
  ];
  const drivers = [
    driver("Delayed starts", delayed, "DIRECT", "/api/hospital/command-center/drilldown?kind=ot-delayed"),
    driver("Cancellations today", cancelledToday, "CONTRIBUTING"),
    driver("Theatres configured", theatres, "CONTRIBUTING"),
    driver("Theatre utilization", "operating hours not modelled", "UNAVAILABLE"),
  ];
  return section(ctx, { key: "ot", label: "Operating theatre", metrics, drivers, drillDown: "/api/hospital/command-center/drilldown?kind=ot-delayed" });
}
