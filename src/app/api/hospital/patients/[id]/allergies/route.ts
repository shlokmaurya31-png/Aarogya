import { NextRequest } from "next/server";
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

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const { substance, reaction, severity } = body ?? {};
    if (!substance || !severity) throw new BadRequestError("substance and severity are required.");

    const allergy = await prisma.allergy.create({
      data: { patientId: id, substance, reaction, severity, status: "ACTIVE", verification: body?.verification ?? "UNCONFIRMED" },
    });

    await recordAuditEvent("hospital.allergy.added", session.userId, { patientId: id, allergyId: allergy.id });
    return { allergy };
  });
}
