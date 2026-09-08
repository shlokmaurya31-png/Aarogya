import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { closeCarePlan, addIntervention, completeIntervention } from "@/lib/hospital/carePlan";

/** action: "close" | "addIntervention" | "completeIntervention" */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("carePlan:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Must be performed by a staff account.");

    const carePlan = await prisma.carePlan.findUnique({ where: { id } });
    if (!carePlan || carePlan.facilityId !== facilityId) throw new NotFoundError("Care plan not found.");

    const action = body?.action as string | undefined;
    if (action === "close") {
      const status = body?.status === "CANCELLED" ? "CANCELLED" : "COMPLETED";
      const updated = await closeCarePlan(id, status);
      await recordAuditEvent(
        "hospital.carePlan.closed",
        session.userId,
        { carePlanId: id, status },
        { facilityId, patientId: carePlan.patientId, encounterId: carePlan.encounterId ?? undefined }
      );
      return { carePlan: updated };
    }
    if (action === "addIntervention") {
      if (!body?.description || !body?.responsibleRole) throw new BadRequestError("description and responsibleRole are required.");
      const intervention = await addIntervention({
        carePlanId: id,
        facilityId,
        description: body.description,
        responsibleRole: body.responsibleRole,
        createdByStaffId: staff.id,
        byUserId: session.userId,
        createTask: Boolean(body.createTask),
        taskDueAt: body.taskDueAt ? new Date(body.taskDueAt) : undefined,
      });
      return { intervention };
    }
    if (action === "completeIntervention") {
      if (!body?.interventionId) throw new BadRequestError("interventionId is required.");
      const intervention = await completeIntervention({
        interventionId: body.interventionId,
        carePlanId: id,
        facilityId,
        completedByStaffId: staff.id,
        byUserId: session.userId,
      });
      return { intervention };
    }
    throw new BadRequestError("Unknown action.");
  });
}
