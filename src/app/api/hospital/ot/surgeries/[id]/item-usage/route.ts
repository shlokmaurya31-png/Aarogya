import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordItemUsage } from "@/lib/hospital/surgery";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const surgery = await prisma.surgery.findUnique({ where: { id } });
    if (!surgery || surgery.facilityId !== facilityId) throw new NotFoundError("Surgery not found.");
    const usages = await prisma.surgeryItemUsage.findMany({ where: { surgeryId: id }, orderBy: { createdAt: "desc" } });
    return { usages };
  });
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const usageType = body?.usageType === "CONSUMABLE" ? "CONSUMABLE" : "IMPLANT";
    const permission = usageType === "IMPLANT" ? "ot:implant:record" : "ot:implant:record";
    const { session, facilityId, staff } = await requireFacilityStaff(permission, body?.facilityId);
    if (!staff) throw new BadRequestError("Must be performed by a staff account.");
    if (!body?.itemId || !body?.quantity) throw new BadRequestError("itemId and quantity are required.");
    const usage = await recordItemUsage({
      surgeryId: id, facilityId, usageType, itemId: body.itemId, itemLotId: body.itemLotId, quantity: Number(body.quantity),
      manufacturer: body.manufacturer, serialNumber: body.serialNumber, site: body.site, locationId: body.locationId,
      recordedByStaffId: staff.id, actorUserId: session.userId, byUserId: session.userId,
    });
    return { usage };
  });
}
