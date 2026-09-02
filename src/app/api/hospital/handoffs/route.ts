import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { createHandoff } from "@/lib/hospital/handoff";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const toStaffId = searchParams.get("toStaffId");
    const status = searchParams.get("status");
    const type = searchParams.get("type");

    const handoffs = await prisma.clinicalHandoff.findMany({
      where: {
        facilityId,
        ...(toStaffId ? { toStaffId } : {}),
        ...(status ? { status: status as never } : {}),
        ...(type ? { type: type as never } : {}),
      },
      include: { patient: true, fromStaff: { include: { user: true } }, toStaff: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { handoffs };
  });
}

const HandoffSchema = z.object({
  patientId: z.string(),
  encounterId: z.string().optional(),
  type: z.enum(["DOCTOR", "NURSE"]),
  toStaffId: z.string().optional(),
  urgency: z.enum(["ROUTINE", "URGENT", "EMERGENCY"]).optional(),
  summary: z.string().min(1),
  activeProblems: z.string().optional(),
  pendingInvestigations: z.string().optional(),
  pendingMedications: z.string().optional(),
  pendingTasks: z.string().optional(),
  safetyConcerns: z.string().optional(),
  escalationRequired: z.boolean().optional(),
  facilityId: z.string().optional(),
});

/** Structured clinical handoff (brief §9/§26) — never silently disappears; status starts PENDING. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("handoff:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Handoffs must be created by a staff account.");
    const parsed = HandoffSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid handoff data.");

    const patient = await prisma.patient.findUnique({ where: { id: parsed.data.patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const handoff = await createHandoff({
      facilityId,
      patientId: parsed.data.patientId,
      encounterId: parsed.data.encounterId,
      type: parsed.data.type,
      fromStaffId: staff.id,
      toStaffId: parsed.data.toStaffId,
      urgency: parsed.data.urgency,
      summary: parsed.data.summary,
      activeProblems: parsed.data.activeProblems,
      pendingInvestigations: parsed.data.pendingInvestigations,
      pendingMedications: parsed.data.pendingMedications,
      pendingTasks: parsed.data.pendingTasks,
      safetyConcerns: parsed.data.safetyConcerns,
      escalationRequired: parsed.data.escalationRequired,
      byUserId: session.userId,
    });
    return { handoff };
  });
}
