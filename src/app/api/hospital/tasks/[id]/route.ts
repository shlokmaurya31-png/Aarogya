import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

const VALID_STATUSES = ["OPEN", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "OVERDUE"];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("task:manage", body?.facilityId);

    const task = await prisma.task.findUnique({ where: { id } });
    if (!task || task.facilityId !== facilityId) throw new NotFoundError("Task not found.");

    const { status, ownerStaffId, action, skipReason, startedAt } = body ?? {};
    if (status && !VALID_STATUSES.includes(status)) throw new BadRequestError(`status must be one of ${VALID_STATUSES.join(", ")}.`);
    if (action === "skip" && !skipReason) throw new BadRequestError("skipReason is required to skip a task.");

    const updated = await prisma.task.update({
      where: { id },
      data: {
        ...(status ? { status } : {}),
        ...(ownerStaffId !== undefined ? { ownerStaffId } : {}),
        ...(status === "COMPLETED" ? { completedByStaffId: staff?.id, completedAt: new Date() } : {}),
        ...(startedAt ? { startedAt: new Date() } : {}),
        ...(action === "skip" ? { status: "CANCELLED", skippedAt: new Date(), skipReason } : {}),
      },
    });

    if (status === "COMPLETED") {
      await recordAuditEvent("hospital.task.completed", session.userId, { taskId: id });
    }
    if (action === "skip") {
      await recordAuditEvent("hospital.task.skipped", session.userId, { taskId: id, skipReason });
    }
    return { task: updated };
  });
}
