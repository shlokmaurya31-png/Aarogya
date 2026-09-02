import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { endAssignment } from "@/lib/hospital/nursingAssignment";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("nursing:assignment:manage", body?.facilityId);

    const assignment = await prisma.nursingAssignment.findUnique({ where: { id } });
    if (!assignment || assignment.facilityId !== facilityId) throw new NotFoundError("Assignment not found.");

    const updated = await endAssignment(id, session.userId);
    return { assignment: updated };
  });
}
