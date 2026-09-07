import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { recordWaste } from "@/lib/hospital/inventory/waste";
import { clampPageSize } from "@/lib/hospital/inventory/expiry";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:stock:waste", searchParams.get("facilityId") ?? undefined);
    const cursor = searchParams.get("cursor") ?? undefined;
    const wasteRecords = await prisma.wasteRecord.findMany({
      where: { facilityId, ...(searchParams.get("status") ? { status: searchParams.get("status") as never } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: clampPageSize(searchParams.get("take") ? Number(searchParams.get("take")) : undefined),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    return { wasteRecords };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("inventory:stock:waste", body?.facilityId);
    if (!staff) throw new BadRequestError("Recording waste must be performed by a staff account.");

    const { itemId, lotId, locationId, quantity, reason } = body ?? {};
    if (!itemId || !lotId || !locationId || !quantity || quantity <= 0) throw new BadRequestError("itemId, lotId, locationId, and a positive quantity are required.");
    if (!reason) throw new BadRequestError("reason is required.");

    const { waste, alreadyExisted } = await prisma.$transaction((tx) =>
      recordWaste(tx, {
        facilityId,
        itemId,
        lotId,
        locationId,
        quantity,
        reason,
        notes: body?.notes,
        patientId: body?.patientId,
        encounterId: body?.encounterId,
        requestedByStaffId: staff.id,
        actorUserId: session.userId,
        idempotencyKey: body?.idempotencyKey ?? randomUUID(),
      })
    );
    if (!alreadyExisted) {
      await recordAuditEvent("hospital.inventory.wasteRecorded", session.userId, { wasteId: waste.id, itemId, quantity, status: waste.status }, { facilityId, patientId: body?.patientId, encounterId: body?.encounterId });
    }
    return { waste, alreadyExisted };
  });
}
