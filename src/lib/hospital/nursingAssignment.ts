import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";
import type { NursingAssignment, Prisma } from "@prisma/client";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

/** NurseAssignmentStatusChanged (triage step 5b), in the writer's transaction. */
function emitAssignmentStatus(tx: Prisma.TransactionClient, a: NursingAssignment, change: { from: "ACTIVE" | null; to: "ACTIVE" | "ENDED"; endedBy?: "ENDED" | "REASSIGNED" }, byUserId: string) {
  return emitFacilityEvent(tx, {
    type: "NurseAssignmentStatusChanged", aggregateId: a.id, facilityId: a.facilityId, actorUserId: byUserId, encounterId: a.encounterId,
    payload: {
      assignmentId: a.id, patientId: a.patientId, nurseStaffId: a.nurseStaffId, from: change.from, to: change.to,
      ...(a.encounterId ? { encounterId: a.encounterId } : {}),
      ...(change.endedBy ? { endedBy: change.endedBy } : {}),
    },
  });
}

export class NursingAssignmentConcurrencyError extends BadRequestError {
  constructor(message: string) {
    super(message);
  }
}

function isDuplicateOpenAssignmentError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002");
}

/**
 * Nurse-to-patient assignment (brief §11/§13/§24-D) — history is never
 * overwritten. Reassigning a patient ends the current assignment (endAt)
 * and creates a new row rather than mutating the old one. The app-level
 * "end open assignments then create" sequence already expressed the "one
 * active assignment per patient" invariant, but without a DB constraint two
 * concurrent assignNurse calls could each end the same stale row and both
 * create a new active row. The partial unique index on
 * NursingAssignment(patientId) WHERE endAt IS NULL is the real backstop;
 * this catches the resulting P2002 and turns it into a clear error instead
 * of a raw constraint-violation 500.
 */
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
  try {
    return await prisma.$transaction(async (tx) => {
      // End the patient's open assignment (at most one: partial unique index)
      // and emit its ENDED change; a row ended concurrently is a conflict.
      const open = await tx.nursingAssignment.findMany({ where: { patientId: input.patientId, endAt: null } });
      if (open.length) {
        const ended = await tx.nursingAssignment.updateMany({
          where: { id: { in: open.map((o) => o.id) }, endAt: null },
          data: { endAt: new Date() },
        });
        if (ended.count !== open.length) {
          throw new NursingAssignmentConcurrencyError("This patient's assignment changed at the same moment. Refresh and try again.");
        }
        for (const o of open) await emitAssignmentStatus(tx, o, { from: "ACTIVE", to: "ENDED", endedBy: "REASSIGNED" }, input.byUserId);
      }
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
      await tx.auditEvent.create({
        data: {
          type: "hospital.nursing.assignmentChanged",
          userId: input.byUserId,
          detail: { assignmentId: assignment.id, patientId: input.patientId, nurseStaffId: input.nurseStaffId },
          facilityId: input.facilityId,
          patientId: input.patientId,
          encounterId: input.encounterId,
        },
      });
      await emitAssignmentStatus(tx, assignment, { from: null, to: "ACTIVE" }, input.byUserId);
      return assignment;
    });
  } catch (err) {
    if (isDuplicateOpenAssignmentError(err)) {
      throw new NursingAssignmentConcurrencyError(
        "This patient was assigned to another nurse at the same moment. Refresh and try again."
      );
    }
    throw err;
  }
}

/** Ends an open assignment. Guarded updateMany (endAt IS NULL in the WHERE) so a double-fired "end" can't be applied twice or race a concurrent reassignment. */
export async function endAssignment(input: { assignmentId: string; facilityId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.nursingAssignment.findUniqueOrThrow({ where: { id: input.assignmentId } });
    if (existing.endAt !== null) throw new NursingAssignmentConcurrencyError("This assignment has already ended.");

    const result = await tx.nursingAssignment.updateMany({
      where: { id: input.assignmentId, endAt: null },
      data: { endAt: new Date() },
    });
    if (result.count !== 1) throw new NursingAssignmentConcurrencyError("This assignment has already ended.");

    const updated = await tx.nursingAssignment.findUniqueOrThrow({ where: { id: input.assignmentId } });
    await tx.auditEvent.create({
      data: {
        type: "hospital.nursing.assignmentChanged",
        userId: input.byUserId,
        detail: { assignmentId: input.assignmentId, ended: true },
        facilityId: input.facilityId,
        patientId: existing.patientId,
        encounterId: existing.encounterId ?? undefined,
      },
    });
    await emitAssignmentStatus(tx, updated, { from: "ACTIVE", to: "ENDED", endedBy: "ENDED" }, input.byUserId);
    return updated;
  });
}
