import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { createAdjustment } from "@/lib/hospital/inventory/adjustment";
import { clampPageSize } from "@/lib/hospital/inventory/expiry";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:stock:adjust", searchParams.get("facilityId") ?? undefined);
    const cursor = searchParams.get("cursor") ?? undefined;
    const adjustments = await prisma.stockAdjustment.findMany({
      where: { facilityId, ...(searchParams.get("status") ? { status: searchParams.get("status") as never } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: clampPageSize(searchParams.get("take") ? Number(searchParams.get("take")) : undefined),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    return { adjustments };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("inventory:stock:adjust", body?.facilityId);
    if (!staff) throw new BadRequestError("Adjusting stock must be performed by a staff account.");

    const { itemId, lotId, locationId, quantityDelta, reason } = body ?? {};
    if (!itemId || !lotId || !locationId || typeof quantityDelta !== "number" || quantityDelta === 0) {
      throw new BadRequestError("itemId, lotId, locationId, and a non-zero quantityDelta are required.");
    }
    if (!reason) throw new BadRequestError("reason is required.");

    const { adjustment, alreadyExisted } = await prisma.$transaction((tx) =>
      createAdjustment(tx, {
        facilityId,
        itemId,
        lotId,
        locationId,
        quantityDelta,
        reason,
        notes: body?.notes,
        requestedByStaffId: staff.id,
        actorUserId: session.userId,
        idempotencyKey: body?.idempotencyKey ?? randomUUID(),
      })
    );
    if (!alreadyExisted) {
      await recordAuditEvent("hospital.inventory.stockAdjusted", session.userId, { adjustmentId: adjustment.id, itemId, quantityDelta, status: adjustment.status }, { facilityId });
    }
    return { adjustment, alreadyExisted };
  });
}
