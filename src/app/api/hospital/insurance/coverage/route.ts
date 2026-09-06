import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { addPatientCoverage } from "@/lib/hospital/billing/coverage";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("insurance:coverage:manage", searchParams.get("facilityId") ?? undefined);
    const patientId = searchParams.get("patientId");
    if (!patientId) throw new BadRequestError("patientId is required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const coverages = await prisma.patientCoverage.findMany({
      where: { patientId },
      include: { payer: true, plan: true },
      orderBy: { priorityOrder: "asc" },
    });
    return { coverages };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("insurance:coverage:manage", body?.facilityId);

    const { patientId, payerId, planId, memberId, validFrom, validTo, priorityOrder } = body ?? {};
    if (!patientId) throw new BadRequestError("patientId is required.");
    if (!payerId) throw new BadRequestError("payerId is required.");
    if (!memberId || typeof memberId !== "string") throw new BadRequestError("memberId is required.");
    if (!validFrom) throw new BadRequestError("validFrom is required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const coverage = await prisma.$transaction((tx) =>
      addPatientCoverage(tx, {
        patientId,
        payerId,
        planId,
        memberId,
        validFrom: new Date(validFrom),
        validTo: validTo ? new Date(validTo) : null,
        priorityOrder,
        addedByUserId: session.userId,
      })
    );

    await recordAuditEvent(
      "hospital.insurance.coverageAdded",
      session.userId,
      { coverageId: coverage.id, payerId },
      { facilityId, patientId }
    );
    return { coverage };
  });
}
