import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { addFormularyEntry } from "@/lib/hospital/pharmacy";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const activeOnly = searchParams.get("active") !== "false";
    const entries = await prisma.formularyEntry.findMany({ where: { facilityId, ...(activeOnly ? { active: true } : {}) }, include: { item: true }, orderBy: { effectiveFrom: "desc" }, take: 500 });
    return { entries };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:formulary:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Formulary management requires a staff account.");
    if (!body?.itemId) throw new BadRequestError("itemId is required.");
    const entry = await addFormularyEntry({ facilityId, itemId: body.itemId, restrictions: body.restrictions, requiresAuthorization: body.requiresAuthorization, notes: body.notes, effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : undefined, createdByStaffId: staff.id, byUserId: session.userId });
    return { entry };
  });
}
