import { LabOrderStatus, ImagingOrderStatus } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";

/**
 * Server-validated status transitions for LabOrder/ImagingOrder. Both
 * reflect their respective Milestone's fine-grained-entity-driven
 * workflow: LabOrder tracks ORDERED -> COLLECTED (specimen collected) ->
 * IN_PROGRESS (specimen accepted) -> RESULTED (every required result
 * entered), driven by src/lib/hospital/specimenLifecycle.ts and
 * labResultLifecycle.ts. ImagingOrder (Milestone C) tracks ORDERED ->
 * SCHEDULED (study booked) -> ACQUIRED (study completed) -> REPORTED
 * (report entered), driven by src/lib/hospital/imagingStudyLifecycle.ts
 * and imagingReportLifecycle.ts. Neither is set directly by API routes.
 * CANCELLED stays declared-but-unreached for both, same "declared, not
 * invented" discipline as Milestone A.
 */
const ALLOWED_LAB: Record<LabOrderStatus, LabOrderStatus[]> = {
  ORDERED: ["COLLECTED"],
  COLLECTED: ["IN_PROGRESS"],
  IN_PROGRESS: ["RESULTED"],
  RESULTED: [],
  CANCELLED: [],
};

const ALLOWED_IMAGING: Record<ImagingOrderStatus, ImagingOrderStatus[]> = {
  ORDERED: ["SCHEDULED"],
  SCHEDULED: ["ACQUIRED"],
  ACQUIRED: ["REPORTED"],
  REPORTED: [],
  CANCELLED: [],
};

export class InvalidLabOrderTransitionError extends BadRequestError {
  constructor(from: LabOrderStatus, to: LabOrderStatus) {
    super(`Illegal lab order transition: ${from} -> ${to}`);
  }
}

export class InvalidImagingOrderTransitionError extends BadRequestError {
  constructor(from: ImagingOrderStatus, to: ImagingOrderStatus) {
    super(`Illegal imaging order transition: ${from} -> ${to}`);
  }
}

export function isLabOrderTransitionAllowed(from: LabOrderStatus, to: LabOrderStatus): boolean {
  return ALLOWED_LAB[from]?.includes(to) ?? false;
}

export function isImagingOrderTransitionAllowed(from: ImagingOrderStatus, to: ImagingOrderStatus): boolean {
  return ALLOWED_IMAGING[from]?.includes(to) ?? false;
}

/**
 * LabOrder/ImagingOrder.priority is a free-text field documented as
 * "ROUTINE | URGENT | STAT" (Phase 0-2), while the generalized Order
 * envelope's priority is the RequestPriority enum (ROUTINE | URGENT |
 * EMERGENCY — no STAT member). STAT is clinically the most urgent tier, so
 * it maps to EMERGENCY rather than being silently dropped when the
 * envelope is created; anything else defaults to ROUTINE.
 */
export function mapDiagnosticPriorityToOrderPriority(priority?: string | null): "ROUTINE" | "URGENT" | "EMERGENCY" {
  if (priority === "STAT") return "EMERGENCY";
  if (priority === "URGENT") return "URGENT";
  return "ROUTINE";
}
