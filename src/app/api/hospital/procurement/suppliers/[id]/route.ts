import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { updateSupplier } from "@/lib/hospital/procurement/suppliers";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:supplier:view", searchParams.get("facilityId") ?? undefined);
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier || supplier.facilityId !== facilityId) throw new NotFoundError("Supplier not found.");
    return { supplier };
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("procurement:supplier:manage", body?.facilityId);

    const supplier = await prisma.$transaction((tx) => updateSupplier(tx, id, facilityId, body ?? {}));
    await recordAuditEvent("hospital.procurement.supplierUpdated", session.userId, { supplierId: id }, { facilityId });
    return { supplier };
  });
}
