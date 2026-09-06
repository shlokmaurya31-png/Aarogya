import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { draftInvoiceForAccount } from "@/lib/hospital/billing/invoices";

const MAX_PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("billing:view", searchParams.get("facilityId") ?? undefined);

    const status = searchParams.get("status") ?? undefined;
    const patientId = searchParams.get("patientId") ?? undefined;
    const encounterId = searchParams.get("encounterId") ?? undefined;
    const invoiceNumber = searchParams.get("invoiceNumber") ?? undefined;
    const take = Math.min(Number(searchParams.get("limit") ?? 25) || 25, MAX_PAGE_SIZE);
    const skip = Math.max(Number(searchParams.get("offset") ?? 0) || 0, 0);

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where: { facilityId, status: status as never, patientId, encounterId, invoiceNumber: invoiceNumber ? { contains: invoiceNumber } : undefined },
        include: { patient: { select: { fullName: true, uhid: true } }, payer: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.invoice.count({ where: { facilityId, status: status as never, patientId, encounterId } }),
    ]);
    return { invoices, total, limit: take, offset: skip };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:invoice:create", body?.facilityId);

    const { encounterId, payerId } = body ?? {};
    if (!encounterId) throw new BadRequestError("encounterId is required.");

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    if (payerId) {
      const payer = await prisma.payer.findUnique({ where: { id: payerId } });
      if (!payer) throw new NotFoundError("Payer not found.");
    }

    const invoice = await prisma.$transaction((tx) =>
      draftInvoiceForAccount(tx, { encounterId, patientId: encounter.patientId, facilityId, payerId, generatedByUserId: session.userId })
    );

    await recordAuditEvent(
      "hospital.invoice.drafted",
      session.userId,
      { invoiceId: invoice.id, encounterId },
      { facilityId, patientId: encounter.patientId, encounterId }
    );
    return { invoice };
  });
}
