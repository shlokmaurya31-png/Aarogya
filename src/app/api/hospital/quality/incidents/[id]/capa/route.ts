import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createCapa } from "@/lib/hospital/quality/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("quality:capa:create", body?.facilityId);
    if (!staff) throw new BadRequestError("This action requires a staff account.");
    if (!body?.title || !body?.description || !body?.actionType) throw new BadRequestError("title, description and actionType are required.");
    const capa = await createCapa({
      facilityId, incidentId: id, title: body.title, description: body.description, actionType: body.actionType,
      ownerStaffId: body.ownerStaffId, departmentId: body.departmentId, dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
      createdByStaffId: staff.id, byUserId: session.userId,
    });
    return { capa };
  });
}
