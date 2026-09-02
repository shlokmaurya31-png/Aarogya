import { prisma } from "@/lib/db";

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
    await tx.auditEvent.create({ data: { type: "hospital.handoff.created", userId: input.byUserId, detail: { handoffId: handoff.id, patientId: input.patientId, handoffType: input.type } } });
    return handoff;
  });
}

export class HandoffAlreadyAcknowledgedError extends Error {
  constructor() {
    super("This handoff has already been acknowledged.");
  }
}

export async function acknowledgeHandoff(handoffId: string, acknowledgedByStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const handoff = await tx.clinicalHandoff.findUniqueOrThrow({ where: { id: handoffId } });
    if (handoff.status === "ACKNOWLEDGED") throw new HandoffAlreadyAcknowledgedError();
    const updated = await tx.clinicalHandoff.update({
      where: { id: handoffId },
      data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedByStaffId },
    });
    await tx.auditEvent.create({ data: { type: "hospital.handoff.acknowledged", userId: byUserId, detail: { handoffId } } });
    return updated;
  });
}
