import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { requestPreAuth } from "@/lib/hospital/billing/preauth";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("insurance:preauth:manage", searchParams.get("facilityId") ?? undefined);
    const encounterId = searchParams.get("encounterId") ?? undefined;

    const encounter = encounterId ? await prisma.encounter.findUnique({ where: { id: encounterId } }) : null;
    if (encounterId && (!encounter || encounter.facilityId !== facilityId)) throw new NotFoundError("Encounter not found.");

    const preAuths = await prisma.preAuthorization.findMany({
      where: encounterId ? { encounterId } : { encounter: { facilityId } },
      include: { coverage: { include: { payer: true } } },
      orderBy: { requestedAt: "desc" },
    });
    return { preAuths };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("insurance:preauth:manage", body?.facilityId);

    const { coverageId, encounterId, requestedAmountMinor, payerReferenceNo, notes } = body ?? {};
    if (!coverageId) throw new BadRequestError("coverageId is required.");
    if (!encounterId) throw new BadRequestError("encounterId is required.");
    if (typeof requestedAmountMinor !== "number" || requestedAmountMinor <= 0) throw new BadRequestError("requestedAmountMinor must be a positive number.");

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const preAuth = await prisma.$transaction((tx) =>
      requestPreAuth(tx, { coverageId, encounterId, requestedAmountMinor, requestedByUserId: session.userId, payerReferenceNo, notes })
    );

    await recordAuditEvent(
      "hospital.insurance.preauthRequested",
      session.userId,
      { preAuthId: preAuth.id, requestedAmountMinor },
      { facilityId, patientId: encounter.patientId, encounterId }
    );
    return { preAuth };
  });
}
