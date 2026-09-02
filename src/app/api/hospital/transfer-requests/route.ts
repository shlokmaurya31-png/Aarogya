import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { createTransferRequest, TransferSafetyError } from "@/lib/hospital/transferRequest";

/** Transfer board (brief §36). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");

    const requests = await prisma.transferRequest.findMany({
      where: { facilityId, status: status ? status : { notIn: ["COMPLETED", "CANCELLED", "REJECTED"] } },
      include: {
        patient: true,
        requestedBy: { include: { user: true } },
        reservedBed: { include: { ward: true } },
        admission: { include: { bed: { include: { ward: true } } } },
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      take: 200,
    });
    return { requests };
  });
}

const RequestSchema = z.object({
  admissionId: z.string(),
  patientId: z.string(),
  reason: z.string().min(1),
  destinationWardType: z.string().optional(),
  isolationRequired: z.boolean().optional(),
  genderRestriction: z.string().optional(),
  priority: z.enum(["ROUTINE", "URGENT", "EMERGENCY"]).optional(),
  transportRequired: z.boolean().optional(),
  clinicalHandoverRequired: z.boolean().optional(),
  facilityId: z.string().optional(),
});

/** brief §34 — layered on the existing Admission/Transfer models. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("transfer:request", body?.facilityId);
    if (!staff) throw new BadRequestError("Transfer requests must be made by a staff account.");
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid transfer-request data.");

    const admission = await prisma.admission.findUnique({ where: { id: parsed.data.admissionId }, include: { encounter: true } });
    if (!admission || admission.encounter.facilityId !== facilityId) throw new NotFoundError("Admission not found.");

    try {
      const request = await createTransferRequest({
        admissionId: parsed.data.admissionId,
        facilityId,
        patientId: parsed.data.patientId,
        requestedByStaffId: staff.id,
        reason: parsed.data.reason,
        destinationWardType: parsed.data.destinationWardType,
        isolationRequired: parsed.data.isolationRequired,
        genderRestriction: parsed.data.genderRestriction,
        priority: parsed.data.priority,
        transportRequired: parsed.data.transportRequired,
        clinicalHandoverRequired: parsed.data.clinicalHandoverRequired,
        byUserId: session.userId,
      });
      return { request };
    } catch (err) {
      if (err instanceof TransferSafetyError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
