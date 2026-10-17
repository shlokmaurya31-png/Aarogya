import { NextRequest } from "next/server";
import { recordDiagnosis, updateDiagnosis } from "@/lib/hospital/clinicalRecords";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";


/** Diagnosis (brief §17) — distinct from Problem, see docs/CLINICAL_CORE.md and docs/TARGET_DOMAIN_ARCHITECTURE.md §2. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("diagnosis:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Diagnoses must be recorded by a staff account.");

    const { diagnosis, type, onsetDate, codeSystem, code, codeDisplay } = body ?? {};
    const created = await recordDiagnosis({ encounterId: id, facilityId, staffId: staff.id, diagnosis, type, onsetDate: onsetDate ? new Date(onsetDate) : undefined, codeSystem, code, codeDisplay, byUserId: session.userId });
    const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id }, select: { patientId: true } });

    await recordAuditEvent(
      "hospital.diagnosis.added",
      session.userId,
      { encounterId: id, diagnosisId: created.id, type },
      { facilityId, patientId: encounter.patientId, encounterId: id }
    );
    return { diagnosis: created };
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const diagnoses = await prisma.diagnosis.findMany({ where: { encounterId: id }, orderBy: { createdAt: "desc" } });
    return { diagnoses };
  });
}

/** Batch 7: change a diagnosis's type or status ({ diagnosisId, type?, status? }); RESOLVED resolves it. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("diagnosis:manage", body?.facilityId);
    if (!body?.diagnosisId) throw new BadRequestError("diagnosisId is required.");
    const current = await prisma.diagnosis.findUnique({ where: { id: body.diagnosisId }, select: { encounterId: true } });
    if (!current || current.encounterId !== id) throw new NotFoundError("Diagnosis not found.");
    const updated = await updateDiagnosis({ diagnosisId: body.diagnosisId, facilityId, type: body.type, status: body.status, byUserId: session.userId });
    await recordAuditEvent("hospital.diagnosis.updated", session.userId, { encounterId: id, diagnosisId: updated.id, status: updated.status, type: updated.type }, { facilityId, patientId: updated.patientId, encounterId: id });
    return { diagnosis: updated };
  });
}
