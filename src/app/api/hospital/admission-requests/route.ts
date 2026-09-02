import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { createAdmissionRequest } from "@/lib/hospital/admissionRequest";

/** Admission work queue (brief §29). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");

    const requests = await prisma.admissionRequest.findMany({
      where: { facilityId, status: status ? status : { notIn: ["ADMITTED", "REJECTED", "CANCELLED"] } },
      include: { patient: true, encounter: true, department: true, requestedBy: { include: { user: true } }, reservedBed: { include: { ward: true } } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      take: 200,
    });
    return { requests };
  });
}

const RequestSchema = z.object({
  patientId: z.string(),
  encounterId: z.string(),
  departmentId: z.string().optional(),
  requestedWardType: z.string().optional(),
  isolationRequired: z.boolean().optional(),
  genderRestriction: z.string().optional(),
  priority: z.enum(["ROUTINE", "URGENT", "EMERGENCY"]).optional(),
  reason: z.string().min(1),
  expectedLosDays: z.number().int().min(0).optional(),
  facilityId: z.string().optional(),
});

/** brief §28 — never directly mutates a bed. Creates the request; allocation is a separate step. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("admission:request", body?.facilityId);
    if (!staff) throw new BadRequestError("Admission requests must be made by a staff account.");
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid admission-request data.");

    const encounter = await prisma.encounter.findUnique({ where: { id: parsed.data.encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const request = await createAdmissionRequest({
      patientId: parsed.data.patientId,
      encounterId: parsed.data.encounterId,
      facilityId,
      departmentId: parsed.data.departmentId,
      requestedByStaffId: staff.id,
      requestedWardType: parsed.data.requestedWardType,
      isolationRequired: parsed.data.isolationRequired,
      genderRestriction: parsed.data.genderRestriction,
      priority: parsed.data.priority,
      reason: parsed.data.reason,
      expectedLosDays: parsed.data.expectedLosDays,
      byUserId: session.userId,
    });
    return { request };
  });
}
