import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";

/** Structured clinical handoff (brief §9/§26), shared by doctor and nurse handoffs (`type` + the actual role of the participants distinguishes them). Never silently disappears — status starts PENDING and only an explicit acknowledgement flips it. */
export async function createHandoff(input: {
  facilityId: string;
  patientId: string;
  encounterId?: string;
  type: "DOCTOR" | "NURSE";
  fromStaffId: string;
  toStaffId?: string;
  urgency?: "ROUTINE" | "URGENT" | "EMERGENCY";
  summary: string;
  activeProblems?: string;
  pendingInvestigations?: string;
  pendingMedications?: string;
  pendingTasks?: string;
  safetyConcerns?: string;
  escalationRequired?: boolean;
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const handoff = await tx.clinicalHandoff.create({
      data: {
        facilityId: input.facilityId,
        patientId: input.patientId,
        encounterId: input.encounterId,
        type: input.type,
        fromStaffId: input.fromStaffId,
        toStaffId: input.toStaffId,
        urgency: input.urgency,
        summary: input.summary,
        activeProblems: input.activeProblems,
        pendingInvestigations: input.pendingInvestigations,
        pendingMedications: input.pendingMedications,
        pendingTasks: input.pendingTasks,
        safetyConcerns: input.safetyConcerns,
        escalationRequired: input.escalationRequired ?? false,
      },
    });
    await tx.auditEvent.create({
      data: {
        type: "hospital.handoff.created",
        userId: input.byUserId,
        detail: { handoffId: handoff.id, handoffType: input.type },
        facilityId: input.facilityId,
        patientId: input.patientId,
        encounterId: input.encounterId,
      },
    });
    return handoff;
  });
}

export class HandoffAlreadyAcknowledgedError extends BadRequestError {
  constructor() {
    super("This handoff has already been acknowledged.");
  }
}

/**
 * Acknowledges a PENDING handoff (brief §15/§24-E). Concurrency-safe via a
 * guarded updateMany (status: "PENDING" in the WHERE, count-checked after)
 * — the previous check-then-update (`findUniqueOrThrow` + status check,
 * then an unguarded `update`) let two concurrent acknowledgements both pass
 * the read-time check and both commit under READ COMMITTED isolation.
 */
export async function acknowledgeHandoff(handoffId: string, acknowledgedByStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const handoff = await tx.clinicalHandoff.findUniqueOrThrow({ where: { id: handoffId } });
    if (handoff.status === "ACKNOWLEDGED") throw new HandoffAlreadyAcknowledgedError();

    const result = await tx.clinicalHandoff.updateMany({
      where: { id: handoffId, status: "PENDING" },
      data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedByStaffId },
    });
    if (result.count !== 1) throw new HandoffAlreadyAcknowledgedError();

    const updated = await tx.clinicalHandoff.findUniqueOrThrow({ where: { id: handoffId } });
    await tx.auditEvent.create({
      data: {
        type: "hospital.handoff.acknowledged",
        userId: byUserId,
        detail: { handoffId },
        facilityId: handoff.facilityId,
        patientId: handoff.patientId,
        encounterId: handoff.encounterId ?? undefined,
      },
    });
    return updated;
  });
}
