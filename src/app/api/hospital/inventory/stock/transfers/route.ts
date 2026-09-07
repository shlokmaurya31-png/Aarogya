import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { initiateTransfer } from "@/lib/hospital/inventory/transfer";
import { clampPageSize } from "@/lib/hospital/inventory/expiry";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:stock:transfer", searchParams.get("facilityId") ?? undefined);
    const cursor = searchParams.get("cursor") ?? undefined;
    const transfers = await prisma.stockTransfer.findMany({
      where: { facilityId, ...(searchParams.get("status") ? { status: searchParams.get("status") as never } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: clampPageSize(searchParams.get("take") ? Number(searchParams.get("take")) : undefined),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    return { transfers };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("inventory:stock:transfer", body?.facilityId);
    if (!staff) throw new BadRequestError("Transferring stock must be performed by a staff account.");

    const { itemId, lotId, fromLocationId, toLocationId, quantity } = body ?? {};
    if (!itemId || !lotId || !fromLocationId || !toLocationId || !quantity || quantity <= 0) {
      throw new BadRequestError("itemId, lotId, fromLocationId, toLocationId, and a positive quantity are required.");
    }

    const { transfer, alreadyExisted } = await prisma.$transaction((tx) =>
      initiateTransfer(tx, {
        facilityId,
        itemId,
        lotId,
        fromLocationId,
        toLocationId,
        quantity,
        requestedByStaffId: staff.id,
        actorUserId: session.userId,
        reason: body?.reason,
        idempotencyKey: body?.idempotencyKey ?? randomUUID(),
      })
    );
    if (!alreadyExisted) {
      await recordAuditEvent("hospital.inventory.stockTransferred", session.userId, { transferId: transfer.id, itemId, quantity }, { facilityId });
    }
    return { transfer, alreadyExisted };
  });
}
