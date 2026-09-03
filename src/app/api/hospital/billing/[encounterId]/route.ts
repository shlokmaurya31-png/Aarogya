import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createCharge } from "@/lib/hospital/billing";

export async function GET(req: NextRequest, { params }: { params: Promise<{ encounterId: string }> }) {
  return withApiErrors(async () => {
    const { encounterId } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("billing:view", searchParams.get("facilityId") ?? undefined);

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId }, include: { patient: true, bill: true } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const charges = await prisma.charge.findMany({ where: { encounterId }, orderBy: { createdAt: "asc" } });
    return { encounter, charges, bill: encounter.bill };
  });
}

/** Charge engine (brief §34): every charge has source/timestamp/department/encounter/amount, and rolls into a Bill total. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ encounterId: string }> }) {
  return withApiErrors(async () => {
    const { encounterId } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:charge:create", body?.facilityId);

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const { description, category, amount } = body ?? {};
    if (!description || !category || typeof amount !== "number") throw new BadRequestError("description, category and numeric amount are required.");

    const result = await prisma.$transaction(async (tx) =>
      createCharge(tx, { encounterId, patientId: encounter.patientId, facilityId, description, category, amount, sourceType: body?.sourceType, sourceId: body?.sourceId })
    );

    await recordAuditEvent("hospital.billing.chargeCreated", session.userId, { encounterId, amount });
    return result;
  });
}
