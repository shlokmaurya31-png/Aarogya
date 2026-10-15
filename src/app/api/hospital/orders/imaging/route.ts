import { NextRequest } from "next/server";
import type { ImagingOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { placeImagingOrder } from "@/lib/hospital/imagingOrder";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status") as ImagingOrderStatus | null;

    const orders = await prisma.imagingOrder.findMany({
      where: { encounter: { facilityId }, ...(status ? { status } : {}) },
      include: {
        patient: true,
        encounter: true,
        reports: { where: { isCurrent: true } },
        studies: { orderBy: { createdAt: "desc" } },
        orderedBy: { include: { user: true } },
        catalogStudy: true,
      },
      orderBy: { orderedAt: "desc" },
      take: 100,
    });
    return { orders };
  });
}

/** Place an imaging order: auth here, everything else in placeImagingOrder (src/lib/hospital/imagingOrder.ts). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("clinical:order:imaging", body?.facilityId);
    if (!staff) throw new BadRequestError("Imaging orders must be placed by a staff account.");
    const { order } = await placeImagingOrder({ ...(body ?? {}), facilityId, staffId: staff.id, byUserId: session.userId });
    return { order };
  });
}
