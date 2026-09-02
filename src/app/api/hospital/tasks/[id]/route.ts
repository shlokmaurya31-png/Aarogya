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

    const { status, ownerStaffId } = body ?? {};
    if (status && !VALID_STATUSES.includes(status)) throw new BadRequestError(`status must be one of ${VALID_STATUSES.join(", ")}.`);

    const updated = await prisma.task.update({
      where: { id },
      data: {
        ...(status ? { status } : {}),
        ...(ownerStaffId !== undefined ? { ownerStaffId } : {}),
        ...(status === "COMPLETED" ? { completedByStaffId: staff?.id, completedAt: new Date() } : {}),
      },
    });

    if (status === "COMPLETED") {
      await recordAuditEvent("hospital.task.completed", session.userId, { taskId: id });
    }
    return { task: updated };
  });
}
