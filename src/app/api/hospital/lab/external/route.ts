import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { createExternalReferral, listExternalReferrals } from "@/lib/hospital/diagnosticsAdvanced";
import type { ExternalLabStatus } from "@prisma/client";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("lab:external:manage", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status") as ExternalLabStatus | null;
    return { referrals: await listExternalReferrals(facilityId, status ?? undefined) };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:external:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("External referral requires a lab staff account.");
    if (!body?.patientId || !body?.externalLabName) throw new BadRequestError("patientId and externalLabName are required.");
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    const referral = await createExternalReferral({
      facilityId, patientId: body.patientId, externalLabName: body.externalLabName, labOrderId: body.labOrderId, encounterId: body.encounterId,
      externalAccession: body.externalAccession, testDescription: body.testDescription, sentByStaffId: staff.id, notes: body.notes, byUserId: session.userId,
    });
    return { referral };
  });
}
