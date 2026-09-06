import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { recordPayment } from "@/lib/hospital/billing/payments";
import { PaymentMethod } from "@prisma/client";

const MAX_PAGE_SIZE = 100;
const VALID_METHODS: string[] = Object.values(PaymentMethod);

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("billing:view", searchParams.get("facilityId") ?? undefined);

    const patientId = searchParams.get("patientId") ?? undefined;
    const take = Math.min(Number(searchParams.get("limit") ?? 25) || 25, MAX_PAGE_SIZE);
    const skip = Math.max(Number(searchParams.get("offset") ?? 0) || 0, 0);

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where: { facilityId, patientId },
        include: { patient: { select: { fullName: true, uhid: true } } },
        orderBy: { receivedAt: "desc" },
        take,
        skip,
      }),
      prisma.payment.count({ where: { facilityId, patientId } }),
    ]);
    return { payments, total, limit: take, offset: skip };
  });
}

/** Records a payment (or, when no invoice is targeted at this step, an unallocated deposit — see payments.ts). idempotencyKey is required: the caller (UI or gateway webhook) must supply a stable key so retries never double-post. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:payment:record", body?.facilityId);

    const { encounterId, amountMinor, method, idempotencyKey, referenceNo } = body ?? {};
    if (!encounterId) throw new BadRequestError("encounterId is required.");
    if (typeof amountMinor !== "number" || amountMinor <= 0) throw new BadRequestError("amountMinor must be a positive number.");
    if (!method || !VALID_METHODS.includes(method)) throw new BadRequestError(`method must be one of ${VALID_METHODS.join(", ")}.`);
    if (!idempotencyKey || typeof idempotencyKey !== "string") throw new BadRequestError("idempotencyKey is required.");

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const { payment, alreadyExisted } = await prisma.$transaction((tx) =>
      recordPayment(tx, { encounterId, patientId: encounter.patientId, facilityId, amountMinor, method, idempotencyKey, referenceNo, receivedByUserId: session.userId })
    );

    if (!alreadyExisted) {
      await recordAuditEvent(
        "hospital.payment.recorded",
        session.userId,
        { paymentId: payment.id, amountMinor, method },
        { facilityId, patientId: encounter.patientId, encounterId }
      );
    }
    return { payment, alreadyExisted };
  });
}
