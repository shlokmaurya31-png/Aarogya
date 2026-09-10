import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createSupplierContract } from "@/lib/hospital/procurement/procurementAdvanced";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:contract:manage", searchParams.get("facilityId") ?? undefined);
    const itemId = searchParams.get("itemId");
    const contracts = await prisma.supplierContract.findMany({ where: { facilityId, ...(itemId ? { itemId } : {}) }, include: { supplier: { select: { name: true, code: true } } }, orderBy: { effectiveFrom: "desc" }, take: 200 });
    return { contracts };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("procurement:contract:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Contract management requires a procurement staff account.");
    if (!body?.supplierId || !body?.itemId || body?.agreedPriceMinor == null) throw new BadRequestError("supplierId, itemId, and agreedPriceMinor are required.");
    const contract = await createSupplierContract({
      facilityId, supplierId: body.supplierId, itemId: body.itemId, agreedPriceMinor: Number(body.agreedPriceMinor), effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : undefined,
      effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : undefined, moq: body.moq, leadTimeDays: body.leadTimeDays, paymentTermsDays: body.paymentTermsDays, contractRef: body.contractRef, createdByStaffId: staff.id, byUserId: session.userId,
    });
    return { contract };
  });
}
