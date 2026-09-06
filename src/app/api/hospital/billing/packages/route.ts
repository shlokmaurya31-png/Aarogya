import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createPackageDefinition } from "@/lib/hospital/billing/packages";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("billing:view", searchParams.get("facilityId") ?? undefined);
    const packages = await prisma.packageDefinition.findMany({ where: { facilityId, active: true }, include: { items: true }, orderBy: { name: "asc" } });
    return { packages };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:package:manage", body?.facilityId);

    const { code, name, description, packagePriceMinor, items } = body ?? {};
    if (!code || typeof code !== "string") throw new BadRequestError("code is required.");
    if (!name || typeof name !== "string") throw new BadRequestError("name is required.");
    if (typeof packagePriceMinor !== "number" || packagePriceMinor <= 0) throw new BadRequestError("packagePriceMinor must be a positive number.");
    if (!Array.isArray(items)) throw new BadRequestError("items must be an array.");

    const pkg = await prisma.$transaction((tx) => createPackageDefinition(tx, { facilityId, code, name, description, packagePriceMinor, items }));
    await recordAuditEvent("hospital.billing.packageCreated", session.userId, { packageId: pkg.id, code }, { facilityId });
    return { package: pkg };
  });
}
