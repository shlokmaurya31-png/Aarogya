import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createPayerPlan } from "@/lib/hospital/billing/coverage";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("insurance:coverage:manage", body?.facilityId);

    const { name, planCode, copayPercent } = body ?? {};
    if (!name || typeof name !== "string") throw new BadRequestError("name is required.");

    const payer = await prisma.payer.findUnique({ where: { id } });
    if (!payer) throw new NotFoundError("Payer not found.");

    const plan = await prisma.$transaction((tx) => createPayerPlan(tx, { payerId: id, name, planCode, copayPercent }));
    await recordAuditEvent("hospital.insurance.payerPlanCreated", session.userId, { payerId: id, planId: plan.id }, { facilityId });
    return { plan };
  });
}
