import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createAssessment, completeAssessment, signAssessment, amendAssessment } from "@/lib/hospital/nursingAssessment";

/**
 * Nursing assessment (brief §6/§7) — DRAFT -> COMPLETED -> SIGNED ->
 * SUPERSEDED. facilityId/patientId are always derived from the encounter
 * server-side, never trusted from the client body.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const [current, history] = await Promise.all([
      prisma.nursingAssessment.findFirst({ where: { encounterId: id, isCurrent: true }, orderBy: { createdAt: "desc" } }),
      prisma.nursingAssessment.findMany({ where: { encounterId: id, isCurrent: false }, orderBy: { createdAt: "desc" } }),
    ]);
    return { current, history };
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("nursing:assessment:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Nursing assessments must be authored by a staff account.");

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
    if (!body?.findings) throw new BadRequestError("findings is required.");

    const assessment = await createAssessment({
      facilityId,
      patientId: encounter.patientId,
      encounterId: id,
      nurseStaffId: staff.id,
      findings: body.findings,
    });

    await recordAuditEvent(
      "hospital.nursing.assessmentCreated",
      session.userId,
      { encounterId: id, assessmentId: assessment.id },
      { facilityId, patientId: encounter.patientId, encounterId: id }
    );
    return { assessment };
  });
}

/** action: "complete" | "sign" | "amend" */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action as string | undefined;

    if (action === "complete") {
      const { session, facilityId, staff } = await requireFacilityStaff("nursing:assessment:create", body?.facilityId);
      if (!staff) throw new BadRequestError("Must be performed by a staff account.");
      const encounter = await prisma.encounter.findUnique({ where: { id } });
      if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
      if (!body?.assessmentId) throw new BadRequestError("assessmentId is required.");

      const assessment = await completeAssessment({ assessmentId: body.assessmentId, encounterId: id, findings: body.findings });
      await recordAuditEvent(
        "hospital.nursing.assessmentCompleted",
        session.userId,
        { encounterId: id, assessmentId: assessment.id },
        { facilityId, patientId: encounter.patientId, encounterId: id }
      );
      return { assessment };
    }

    if (action === "sign") {
      const { session, facilityId, staff } = await requireFacilityStaff("nursing:assessment:sign", body?.facilityId);
      if (!staff) throw new BadRequestError("Must be performed by a staff account.");
      const encounter = await prisma.encounter.findUnique({ where: { id } });
      if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
      if (!body?.assessmentId) throw new BadRequestError("assessmentId is required.");

      const assessment = await signAssessment({ assessmentId: body.assessmentId, encounterId: id });
      await recordAuditEvent(
        "hospital.nursing.assessmentSigned",
        session.userId,
        { encounterId: id, assessmentId: assessment.id },
        { facilityId, patientId: encounter.patientId, encounterId: id }
      );
      return { assessment };
    }

    if (action === "amend") {
      const { session, facilityId, staff } = await requireFacilityStaff("nursing:assessment:sign", body?.facilityId);
      if (!staff) throw new BadRequestError("Must be performed by a staff account.");
      const encounter = await prisma.encounter.findUnique({ where: { id } });
      if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
      if (!body?.assessmentId || !body?.findings || !body?.amendmentReason) {
        throw new BadRequestError("assessmentId, findings, and amendmentReason are required to amend.");
      }

      const assessment = await amendAssessment({
        assessmentId: body.assessmentId,
        encounterId: id,
        nurseStaffId: staff.id,
        findings: body.findings,
        amendmentReason: body.amendmentReason,
      });
      await recordAuditEvent(
        "hospital.nursing.assessmentAmended",
        session.userId,
        { encounterId: id, assessmentId: assessment.id, previousVersionId: assessment.previousVersionId },
        { facilityId, patientId: encounter.patientId, encounterId: id }
      );
      return { assessment };
    }

    throw new BadRequestError("Unknown action.");
  });
}
