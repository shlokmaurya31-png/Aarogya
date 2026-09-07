import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { reserveStock } from "@/lib/hospital/inventory/reservation";

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("inventory:stock:reserve", body?.facilityId);
    if (!staff) throw new BadRequestError("Reserving stock must be performed by a staff account.");

    const { itemId, locationId, quantity } = body ?? {};
    if (!itemId || !locationId || !quantity || quantity <= 0) throw new BadRequestError("itemId, locationId, and a positive quantity are required.");

    const { reservation, alreadyExisted } = await prisma.$transaction((tx) =>
      reserveStock(tx, {
        facilityId,
        itemId,
        locationId,
        quantity,
        lotId: body?.lotId,
        reservedForType: body?.reservedForType,
        reservedForId: body?.reservedForId,
        patientId: body?.patientId,
        encounterId: body?.encounterId,
        requestedByStaffId: staff.id,
        actorUserId: session.userId,
        expiresAt: body?.expiresAt ? new Date(body.expiresAt) : undefined,
        idempotencyKey: body?.idempotencyKey ?? randomUUID(),
      })
    );
    if (!alreadyExisted) {
      await recordAuditEvent("hospital.inventory.stockReserved", session.userId, { reservationId: reservation.id, itemId, quantity }, { facilityId, patientId: body?.patientId, encounterId: body?.encounterId });
    }
    return { reservation, alreadyExisted };
  });
}
