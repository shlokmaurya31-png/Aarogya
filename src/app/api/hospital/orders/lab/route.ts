import { NextRequest } from "next/server";
import type { LabOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { placeLabOrder } from "@/lib/hospital/labOrder";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status") as LabOrderStatus | null;

    const orders = await prisma.labOrder.findMany({
      where: { encounter: { facilityId }, ...(status ? { status } : {}) },
      include: {
        patient: true,
        encounter: true,
        results: { where: { isCurrent: true } },
        specimens: { orderBy: { createdAt: "desc" } },
        orderedBy: { include: { user: true } },
        catalogTest: true,
        panel: true,
      },
      orderBy: { orderedAt: "desc" },
      take: 100,
    });
    return { orders };
  });
}

/** Place a lab order: auth here, everything else in placeLabOrder (src/lib/hospital/labOrder.ts). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("clinical:order:lab", body?.facilityId);
    if (!staff) throw new BadRequestError("Lab orders must be placed by a staff account.");
    const { order, specimen } = await placeLabOrder({ ...(body ?? {}), facilityId, staffId: staff.id, byUserId: session.userId });
    return { order, specimen };
  });
}
