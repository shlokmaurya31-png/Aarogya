import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordReconciliation } from "@/lib/hospital/reconciliation";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const source = searchParams.get("source");
    const encounterId = searchParams.get("encounterId");

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const records = await prisma.medicationReconciliation.findMany({
      where: { patientId: id, ...(source ? { source: source as never } : {}), ...(encounterId ? { encounterId } : {}) },
      orderBy: { createdAt: "desc" },
    });
    return { records };
  });
}

const ReconciliationSchema = z.object({
  encounterId: z.string(),
  source: z.enum(["ADMISSION", "TRANSFER", "DISCHARGE"]),
  medicationName: z.string().min(1),
  priorDose: z.string().optional(),
  decision: z.enum(["CONTINUED", "MODIFIED", "STOPPED", "NEW"]),
  medicationOrderId: z.string().optional(),
  reason: z.string().optional(),
  facilityId: z.string().optional(),
});

/** Medication reconciliation (brief §19) — admission/transfer/discharge, purely additive rows, never destroys prior medication history. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("clinical:order:medication", body?.facilityId);
    if (!staff) throw new BadRequestError("Reconciliation must be reviewed by a staff account.");
    const parsed = ReconciliationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid reconciliation data.");

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const record = await recordReconciliation({
      encounterId: parsed.data.encounterId,
      patientId: id,
      facilityId,
      source: parsed.data.source,
      medicationName: parsed.data.medicationName,
      priorDose: parsed.data.priorDose,
      decision: parsed.data.decision,
      medicationOrderId: parsed.data.medicationOrderId,
      reason: parsed.data.reason,
      reviewedByStaffId: staff.id,
      byUserId: session.userId,
    });
    return { record };
  });
}
