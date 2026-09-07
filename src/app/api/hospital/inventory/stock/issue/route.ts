import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { issueStock } from "@/lib/hospital/inventory/issue";

/** Generic manual/ward issue — the same consumeInventory boundary Lab/Radiology/OT will call once they have dedicated flows. Pharmacy dispensing goes through medicationLifecycle.ts#dispenseMedication directly, not this route. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("inventory:stock:issue", body?.facilityId);
    if (!staff) throw new BadRequestError("Issuing stock must be performed by a staff account.");

    const { itemId, locationId, quantity } = body ?? {};
    if (!itemId || !locationId || !quantity || quantity <= 0) throw new BadRequestError("itemId, locationId, and a positive quantity are required.");

    const sourceType = body?.sourceType ?? "ManualIssue";
    const sourceId = body?.sourceId ?? randomUUID();

    const result = await prisma.$transaction((tx) =>
      issueStock(tx, {
        facilityId,
        itemId,
        locationId,
        quantity,
        unit: body?.unit,
        lotId: body?.lotId,
        requestedByStaffId: staff.id,
        actorUserId: session.userId,
        reason: body?.reason,
        patientId: body?.patientId,
        encounterId: body?.encounterId,
        sourceType,
        sourceId,
      })
    );
    await recordAuditEvent("hospital.inventory.stockIssued", session.userId, { itemId, locationId, quantity, lotId: result.lotId }, { facilityId, patientId: body?.patientId, encounterId: body?.encounterId });
    return result;
  });
}
