import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createDepartmentRequest } from "@/lib/hospital/inventory/inventoryAdvanced";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:stock:view", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const requests = await prisma.departmentSupplyRequest.findMany({ where: { facilityId, ...(status ? { status: status as never } : {}) }, orderBy: [{ urgency: "desc" }, { createdAt: "asc" }], take: 200 });
    return { requests };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("inventory:request:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Supply requests require a staff account.");
    if (!body?.itemId || !body?.quantity) throw new BadRequestError("itemId and quantity are required.");
    const request = await createDepartmentRequest({
      facilityId, itemId: body.itemId, quantity: Number(body.quantity), unit: body.unit, departmentId: body.departmentId, requestingLocationId: body.requestingLocationId,
      urgency: body.urgency, reason: body.reason, patientId: body.patientId, encounterId: body.encounterId, requestedByStaffId: staff.id, byUserId: session.userId,
    });
    return { request };
  });
}
