import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { startStockTake } from "@/lib/hospital/inventory/stocktake";
import { clampPageSize } from "@/lib/hospital/inventory/expiry";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:stocktake:manage", searchParams.get("facilityId") ?? undefined);
    const cursor = searchParams.get("cursor") ?? undefined;
    const stockTakes = await prisma.stockTake.findMany({
      where: { facilityId, ...(searchParams.get("status") ? { status: searchParams.get("status") as never } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: clampPageSize(searchParams.get("take") ? Number(searchParams.get("take")) : undefined),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    return { stockTakes };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("inventory:stocktake:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Starting a stocktake must be performed by a staff account.");
    if (!body?.locationId) throw new BadRequestError("locationId is required.");

    const stockTake = await prisma.$transaction((tx) => startStockTake(tx, { facilityId, locationId: body.locationId, startedByStaffId: staff.id }));
    await recordAuditEvent("hospital.inventory.stocktakeStarted", session.userId, { stockTakeId: stockTake.id, locationId: body.locationId }, { facilityId });
    return { stockTake };
  });
}
