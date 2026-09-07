import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:requisition:create", searchParams.get("facilityId") ?? undefined);
    const requisition = await prisma.purchaseRequisition.findUnique({ where: { id }, include: { lines: true } });
    if (!requisition || requisition.facilityId !== facilityId) throw new NotFoundError("Requisition not found.");
    return { requisition };
  });
}
