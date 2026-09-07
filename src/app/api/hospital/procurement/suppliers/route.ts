import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { createSupplier, listSuppliers } from "@/lib/hospital/procurement/suppliers";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:supplier:view", searchParams.get("facilityId") ?? undefined);
    const suppliers = await listSuppliers(prisma, facilityId, { active: searchParams.get("active") ? searchParams.get("active") === "true" : undefined });
    return { suppliers };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("procurement:supplier:manage", body?.facilityId);

    const { name, code } = body ?? {};
    if (!name || typeof name !== "string") throw new BadRequestError("name is required.");
    if (!code || typeof code !== "string") throw new BadRequestError("code is required.");

    const supplier = await prisma.$transaction((tx) =>
      createSupplier(tx, {
        facilityId,
        name,
        code,
        contactName: body?.contactName,
        contactPhone: body?.contactPhone,
        contactEmail: body?.contactEmail,
        address: body?.address,
        paymentTermsDays: body?.paymentTermsDays,
      })
    );
    await recordAuditEvent("hospital.procurement.supplierCreated", session.userId, { supplierId: supplier.id, code }, { facilityId });
    return { supplier };
  });
}
