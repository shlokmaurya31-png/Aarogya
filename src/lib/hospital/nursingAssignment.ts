import { prisma } from "@/lib/db";

/** Nurse-to-patient assignment (brief §11) — history is never overwritten. Reassigning a patient ends the current assignment (endAt) and creates a new row rather than mutating the old one. */
export async function assignNurse(input: {
  facilityId: string;
  departmentId?: string;
  nurseStaffId: string;
  patientId: string;
  encounterId?: string;
  bedId?: string;
  reason?: string;
  assignedByStaffId: string;
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    // End any existing open assignment for this patient (one active nurse assignment at a time per patient).
    await tx.nursingAssignment.updateMany({
      where: { patientId: input.patientId, endAt: null },
      data: { endAt: new Date() },
    });
    const assignment = await tx.nursingAssignment.create({
      data: {
        facilityId: input.facilityId,
        departmentId: input.departmentId,
        nurseStaffId: input.nurseStaffId,
        patientId: input.patientId,
        encounterId: input.encounterId,
        bedId: input.bedId,
        reason: input.reason,
        assignedByStaffId: input.assignedByStaffId,
      },
    });
    await tx.auditEvent.create({ data: { type: "hospital.nursing.assignmentChanged", userId: input.byUserId, detail: { assignmentId: assignment.id, patientId: input.patientId, nurseStaffId: input.nurseStaffId } } });
    return assignment;
  });
}

export async function endAssignment(assignmentId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.nursingAssignment.update({ where: { id: assignmentId }, data: { endAt: new Date() } });
    await tx.auditEvent.create({ data: { type: "hospital.nursing.assignmentChanged", userId: byUserId, detail: { assignmentId, ended: true } } });
    return updated;
  });
}
