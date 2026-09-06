import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createClaimDraft } from "@/lib/hospital/billing/claims";

const MAX_PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("billing:view", searchParams.get("facilityId") ?? undefined);

    const status = searchParams.get("status") ?? undefined;
    const take = Math.min(Number(searchParams.get("limit") ?? 25) || 25, MAX_PAGE_SIZE);
    const skip = Math.max(Number(searchParams.get("offset") ?? 0) || 0, 0);

    const [claims, total] = await Promise.all([
      prisma.claim.findMany({
        where: { facilityId, status: status as never },
        include: { coverage: { include: { payer: true } }, invoice: { select: { invoiceNumber: true, patientId: true } } },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.claim.count({ where: { facilityId, status: status as never } }),
    ]);
    return { claims, total, limit: take, offset: skip };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("insurance:claim:create", body?.facilityId);

    const { invoiceId, coverageId, preAuthorizationId } = body ?? {};
    if (!invoiceId) throw new BadRequestError("invoiceId is required.");
    if (!coverageId) throw new BadRequestError("coverageId is required.");

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice || invoice.facilityId !== facilityId) throw new NotFoundError("Invoice not found.");

    const claim = await prisma.$transaction((tx) => createClaimDraft(tx, { invoiceId, coverageId, preAuthorizationId, facilityId, createdByUserId: session.userId }));

    await recordAuditEvent(
      "hospital.claim.created",
      session.userId,
      { claimId: claim.id, invoiceId },
      { facilityId, patientId: invoice.patientId, encounterId: invoice.encounterId }
    );
    return { claim };
  });
}
