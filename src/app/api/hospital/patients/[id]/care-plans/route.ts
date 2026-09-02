import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createCarePlan } from "@/lib/hospital/carePlan";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const carePlans = await prisma.carePlan.findMany({ where: { patientId: id }, include: { interventions: true }, orderBy: { createdAt: "desc" } });
    return { carePlans };
  });
}

const CarePlanSchema = z.object({
  encounterId: z.string().optional(),
  problem: z.string().min(1),
  goal: z.string().min(1),
  priority: z.enum(["ROUTINE", "URGENT", "EMERGENCY"]).optional(),
  targetDate: z.string().optional(),
  notes: z.string().optional(),
  interventions: z.array(z.object({ description: z.string(), responsibleRole: z.string() })).optional(),
  facilityId: z.string().optional(),
});

/** Care plan (brief §6) — problem/goal/interventions, never inventing thresholds or protocols; all clinician-authored text. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("carePlan:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Care plans must be created by a staff account.");
    const parsed = CarePlanSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid care plan data.");

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const carePlan = await createCarePlan({
      patientId: id,
      encounterId: parsed.data.encounterId,
      facilityId,
      problem: parsed.data.problem,
      goal: parsed.data.goal,
      priority: parsed.data.priority,
      targetDate: parsed.data.targetDate ? new Date(parsed.data.targetDate) : undefined,
      createdByStaffId: staff.id,
      notes: parsed.data.notes,
      interventions: parsed.data.interventions,
    });
    await recordAuditEvent("hospital.carePlan.created", session.userId, { carePlanId: carePlan.id, patientId: id });
    return { carePlan };
  });
}
