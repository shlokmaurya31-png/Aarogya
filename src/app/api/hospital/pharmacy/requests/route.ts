import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createPharmacyRequest } from "@/lib/hospital/pharmacy";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const requests = await prisma.pharmacyRequest.findMany({ where: { facilityId, ...(status ? { status: status as never } : {}) }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }], take: 200 });
    return { requests };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:request:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Requests require a staff account.");
    if (!body?.itemId || !body?.quantity) throw new BadRequestError("itemId and quantity are required.");
    const request = await createPharmacyRequest({
      facilityId, itemId: body.itemId, quantity: Number(body.quantity), unit: body.unit, requestingLocationId: body.requestingLocationId,
      patientId: body.patientId, encounterId: body.encounterId, priority: body.priority, requestedByStaffId: staff.id, reason: body.reason, byUserId: session.userId,
    });
    return { request };
  });
}
