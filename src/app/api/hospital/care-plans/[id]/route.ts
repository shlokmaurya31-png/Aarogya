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
    const { session, facilityId } = await requireFacilityStaff("carePlan:manage", body?.facilityId);

    const carePlan = await prisma.carePlan.findUnique({ where: { id } });
    if (!carePlan || carePlan.facilityId !== facilityId) throw new NotFoundError("Care plan not found.");

    const action = body?.action as string | undefined;
    if (action === "close") {
      const status = body?.status === "CANCELLED" ? "CANCELLED" : "COMPLETED";
      const updated = await closeCarePlan(id, status);
      await recordAuditEvent("hospital.carePlan.closed", session.userId, { carePlanId: id, status });
      return { carePlan: updated };
    }
    if (action === "addIntervention") {
      if (!body?.description || !body?.responsibleRole) throw new BadRequestError("description and responsibleRole are required.");
      const intervention = await addIntervention(id, body.description, body.responsibleRole);
      return { intervention };
    }
    if (action === "completeIntervention") {
      if (!body?.interventionId) throw new BadRequestError("interventionId is required.");
      const intervention = await completeIntervention(body.interventionId);
      return { intervention };
    }
    throw new BadRequestError("Unknown action.");
  });
}
