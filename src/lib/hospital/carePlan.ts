import { prisma } from "@/lib/db";

/** Care plan (brief §6) — problem/goal/interventions. Never invents medical thresholds or protocols; goal/intervention text is entirely clinician-authored. */
export async function createCarePlan(input: {
  patientId: string;
  encounterId?: string;
  facilityId: string;
  problem: string;
  goal: string;
  priority?: "ROUTINE" | "URGENT" | "EMERGENCY";
  targetDate?: Date;
  createdByStaffId: string;
  notes?: string;
  interventions?: { description: string; responsibleRole: string }[];
}) {
  return prisma.carePlan.create({
    data: {
      patientId: input.patientId,
      encounterId: input.encounterId,
      facilityId: input.facilityId,
      problem: input.problem,
      goal: input.goal,
      priority: input.priority,
      targetDate: input.targetDate,
      createdByStaffId: input.createdByStaffId,
      notes: input.notes,
      interventions: input.interventions?.length
        ? { create: input.interventions.map((i) => ({ description: i.description, responsibleRole: i.responsibleRole })) }
        : undefined,
    },
    include: { interventions: true },
  });
}

export async function addIntervention(carePlanId: string, description: string, responsibleRole: string) {
  return prisma.carePlanIntervention.create({ data: { carePlanId, description, responsibleRole } });
}

export async function completeIntervention(interventionId: string) {
  return prisma.carePlanIntervention.update({ where: { id: interventionId }, data: { status: "COMPLETED", completedAt: new Date() } });
}

export async function closeCarePlan(carePlanId: string, status: "COMPLETED" | "CANCELLED") {
  return prisma.carePlan.update({ where: { id: carePlanId }, data: { status, completedAt: status === "COMPLETED" ? new Date() : undefined } });
}
