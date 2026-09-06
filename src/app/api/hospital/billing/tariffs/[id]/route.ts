import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { deactivateTariff } from "@/lib/hospital/billing/pricing";

/** Deactivates (end-dates) a tariff — historical pricing is never destroyed, only ever superseded. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:tariff:manage", body?.facilityId);

    const tariff = await prisma.tariff.findUnique({ where: { id } });
    if (!tariff || tariff.facilityId !== facilityId) throw new NotFoundError("Tariff not found.");

    const updated = await prisma.$transaction((tx) => deactivateTariff(tx, id, body?.effectiveTo ? new Date(body.effectiveTo) : undefined));
    await recordAuditEvent("hospital.billing.tariffDeactivated", session.userId, { tariffId: id }, { facilityId });
    return { tariff: updated };
  });
}
