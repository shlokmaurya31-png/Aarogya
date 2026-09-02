import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordTriage } from "@/lib/hospital/triage";
import { recomputeQueuePriority } from "@/lib/hospital/queue";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const assessments = await prisma.triageAssessment.findMany({ where: { encounterId: id }, orderBy: { createdAt: "desc" } });
    return { assessments };
  });
}

const TriageSchema = z.object({
  acuity: z.number().int().min(1).max(5),
  chiefComplaint: z.string().optional(),
  redFlags: z.string().optional(),
  assignedArea: z.string().optional(),
  notes: z.string().optional(),
  facilityId: z.string().optional(),
});

/** Records a triage assessment (brief §19-20) — the clinician/nurse decides the acuity, never the software. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("triage:record", body?.facilityId);
    if (!staff) throw new BadRequestError("Triage must be recorded by a staff account.");
    const parsed = TriageSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid triage data.");

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const assessment = await recordTriage({
      encounterId: id,
      recordedByStaffId: staff.id,
      acuity: parsed.data.acuity,
      chiefComplaint: parsed.data.chiefComplaint,
      redFlags: parsed.data.redFlags,
      assignedArea: parsed.data.assignedArea,
      notes: parsed.data.notes,
      byUserId: session.userId,
    });

    // If this encounter has an active queue entry, recompute its priority now that acuity is known (brief §23 — never silently reordered without a recorded reason).
    const activeEntry = await prisma.queueEntry.findFirst({ where: { encounterId: id, status: { in: ["WAITING", "CALLED"] } } });
    if (activeEntry) await recomputeQueuePriority(activeEntry.id, session.userId, { triageAcuity: parsed.data.acuity });

    return { assessment };
  });
}
