import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { completeTask, skipTask, updateTask } from "@/lib/hospital/task";

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

    let updated;
    if (action === "skip") {
      updated = await skipTask({ taskId: id, facilityId, skipReason, byUserId: session.userId });
    } else if (status === "COMPLETED") {
      updated = await completeTask({ taskId: id, facilityId, completedByStaffId: staff?.id, byUserId: session.userId });
    } else {
      updated = await updateTask({
        taskId: id,
        facilityId,
        status: status && status !== "COMPLETED" ? status : undefined,
        ownerStaffId,
        startedAt: Boolean(startedAt),
      });
    }

    return { task: updated };
  });
}
