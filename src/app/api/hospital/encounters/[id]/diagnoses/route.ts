import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

const VALID_TYPES = ["PRIMARY", "SECONDARY", "PROVISIONAL", "RULE_OUT", "FINAL"];

/** Diagnosis (brief §17) — distinct from Problem, see docs/CLINICAL_CORE.md and docs/TARGET_DOMAIN_ARCHITECTURE.md §2. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("diagnosis:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Diagnoses must be recorded by a staff account.");

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const { diagnosis, type, onsetDate, codeSystem, code } = body ?? {};
    if (!diagnosis || !type || !VALID_TYPES.includes(type)) {
      throw new BadRequestError(`diagnosis is required and type must be one of ${VALID_TYPES.join(", ")}.`);
    }

    const created = await prisma.diagnosis.create({
      data: {
        patientId: encounter.patientId,
        encounterId: id,
        diagnosis,
        type,
        onsetDate: onsetDate ? new Date(onsetDate) : undefined,
        codeSystem,
        code,
        diagnosedByStaffId: staff.id,
      },
    });

    await recordAuditEvent("hospital.diagnosis.added", session.userId, { encounterId: id, diagnosisId: created.id, type });
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
