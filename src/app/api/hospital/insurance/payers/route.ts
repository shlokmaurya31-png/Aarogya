import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createPayer } from "@/lib/hospital/billing/coverage";
import { PayerType } from "@prisma/client";

const VALID_TYPES: string[] = Object.values(PayerType);

/** Payer is org-wide, not facility-scoped (an insurer/scheme is the same entity across every facility) — still gated behind facility staff auth so only authenticated hospital staff can list/create them. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    await requireFacilityStaff("insurance:coverage:manage", searchParams.get("facilityId") ?? undefined);
    const payers = await prisma.payer.findMany({ where: { active: true }, include: { plans: true }, orderBy: { name: "asc" } });
    return { payers };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("insurance:coverage:manage", body?.facilityId);

    const { name, type } = body ?? {};
    if (!name || typeof name !== "string") throw new BadRequestError("name is required.");
    if (!type || !VALID_TYPES.includes(type)) throw new BadRequestError(`type must be one of ${VALID_TYPES.join(", ")}.`);

    const payer = await prisma.$transaction((tx) => createPayer(tx, { name, type }));
    await recordAuditEvent("hospital.insurance.payerCreated", session.userId, { payerId: payer.id, name, type }, { facilityId });
    return { payer };
  });
}
