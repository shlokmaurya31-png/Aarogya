import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { linkMedicationToItem } from "@/lib/hospital/inventory/itemMedicationLink";

/**
 * Real write path for MedicationItemLink (brief P0-A) — without this route,
 * dispenseMedication has no way to resolve a drug name to a stock item
 * short of direct database access. GET lists both this facility's own
 * mappings and the global (facilityId=null) fallback ones, matching
 * resolveItemForDrugName's own facility-then-global lookup order.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:item:view", searchParams.get("facilityId") ?? undefined);
    const links = await prisma.medicationItemLink.findMany({
      where: { OR: [{ facilityId }, { facilityId: null }] },
      include: { item: true },
      orderBy: { drugNameKey: "asc" },
    });
    return { links };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("inventory:item:manage", body?.facilityId);

    const { drugName, itemId } = body ?? {};
    if (!drugName || typeof drugName !== "string") throw new BadRequestError("drugName is required.");
    if (!itemId || typeof itemId !== "string") throw new BadRequestError("itemId is required.");

    const link = await prisma.$transaction((tx) =>
      linkMedicationToItem(tx, { facilityId, global: body?.global === true, drugName, itemId })
    );
    await recordAuditEvent("hospital.inventory.medicationLinked", session.userId, { linkId: link.id, drugName, itemId }, { facilityId });
    return { link };
  });
}
