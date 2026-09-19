import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import { startOfToday } from "./filters";
import type { CommandSection } from "./types";

/**
 * STAFFING / WORKFORCE — operational coverage + workload. Source: StaffShift,
 * WorkforceAssignment, Task (backlog), Encounter (census). OBSERVED counts only; a
 * true staffing RATIO is not fabricated where the data is insufficient. Cancelled
 * shifts covering today are treated as coverage gaps (D8-configurable).
 */
export async function getStaffing(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const today = startOfToday(ctx.now);
  const [activeNow, scheduledToday, cancelledToday, overdueTasks, unassignedAdmitted, activeAssignments] = await Promise.all([
    prisma.staffShift.count({ where: { facilityId: f, status: "SCHEDULED", startAt: { lte: ctx.now }, endAt: { gte: ctx.now } } }),
    prisma.staffShift.count({ where: { facilityId: f, status: { in: ["SCHEDULED", "COMPLETED"] }, startAt: { gte: today } } }),
    prisma.staffShift.count({ where: { facilityId: f, status: "CANCELLED", startAt: { gte: today } } }),
    prisma.task.count({ where: { facilityId: f, status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS"] }, dueAt: { lt: ctx.now } } }),
    prisma.encounter.count({ where: { facilityId: f, status: "ADMITTED", nursingAssignments: { none: { endAt: null } } } }),
    prisma.workforceAssignment.count({ where: { facilityId: f, status: "ACTIVE" } }),
  ]);

  const metrics = [
    metric({ key: "staffActiveNow", label: "Staff on shift now", value: activeNow, unit: "staff", timeSemantics: "CURRENT_STATE", source: "StaffShift" }),
    metric({ key: "staffingGaps", label: "Coverage gaps (cancelled shifts today)", value: cancelledToday, unit: "shifts", timeSemantics: "CURRENT_STATE", threshold: ctx.thresholds.staffingGaps, source: "StaffShift" }),
    metric({ key: "taskBacklog", label: "Overdue operational tasks", value: overdueTasks, unit: "tasks", timeSemantics: "CURRENT_STATE", source: "Task" }),
    metric({ key: "unassignedAdmitted", label: "Admitted patients without nursing assignment", value: unassignedAdmitted, unit: "patients", timeSemantics: "CURRENT_STATE", source: "Encounter" }),
  ];
  const drivers = [
    driver("Cancelled shifts today", cancelledToday, "DIRECT"),
    driver("Overdue tasks", overdueTasks, "DIRECT"),
    driver("Unassigned admitted patients", unassignedAdmitted, "DIRECT"),
    driver("Shifts scheduled today", scheduledToday, "CONTRIBUTING"),
    driver("Active workforce assignments", activeAssignments, "CONTRIBUTING"),
    driver("Staffing ratio", "insufficient canonical data", "UNAVAILABLE"),
  ];
  return section(ctx, { key: "staffing", label: "Staffing", metrics, drivers, drillDown: null });
}
