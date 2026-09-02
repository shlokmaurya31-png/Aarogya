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

    const problems = await prisma.problem.findMany({ where: { patientId: id }, orderBy: { createdAt: "desc" } });
    return { problems };
  });
}

/** Problem list entries persist across encounters (brief §16) — patient-scoped, not encounter-scoped. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("problem:manage", body?.facilityId);

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const { diagnosis, severity, onsetDate } = body ?? {};
    if (!diagnosis) throw new BadRequestError("diagnosis is required.");

    const problem = await prisma.problem.create({
      data: { patientId: id, diagnosis, status: "active", severity, onsetDate: onsetDate ? new Date(onsetDate) : undefined },
    });

    await recordAuditEvent("hospital.problem.added", session.userId, { patientId: id, problemId: problem.id });
    return { problem };
  });
}
