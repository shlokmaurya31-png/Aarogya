import { NextRequest } from "next/server";
import { recordAllergy, updateAllergy } from "@/lib/hospital/clinicalRecords";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const allergies = await prisma.allergy.findMany({ where: { patientId: id }, orderBy: { recordedAt: "desc" } });
    return { allergies };
  });
}

/** This is the table src/lib/hospital/clinicalSafety.ts's medication-order check reads — see docs/CLINICAL_SAFETY_AUDIT.md §1.1. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("allergy:manage", body?.facilityId);

    const { substance, reaction, severity } = body ?? {};
    const allergy = await recordAllergy({ patientId: id, facilityId, substance, reaction, severity, criticality: body?.criticality, verification: body?.verification, byUserId: session.userId });

    await recordAuditEvent(
      "hospital.allergy.added",
      session.userId,
      { patientId: id, allergyId: allergy.id },
      { facilityId, patientId: id }
    );
    return { allergy };
  });
}

/** Batch 7: change an allergy ({ allergyId, status?, severity?, criticality?, verification? }); INACTIVE or ENTERED_IN_ERROR inactivates it. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("allergy:manage", body?.facilityId);
    if (!body?.allergyId) throw new BadRequestError("allergyId is required.");
    const current = await prisma.allergy.findUnique({ where: { id: body.allergyId }, select: { patientId: true } });
    if (!current || current.patientId !== id) throw new NotFoundError("Allergy not found.");
    const allergy = await updateAllergy({ allergyId: body.allergyId, facilityId, status: body.status, severity: body.severity, criticality: body.criticality, verification: body.verification, byUserId: session.userId });
    await recordAuditEvent("hospital.allergy.updated", session.userId, { patientId: id, allergyId: allergy.id, status: allergy.status }, { facilityId, patientId: id });
    return { allergy };
  });
}
