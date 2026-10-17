import { NextRequest } from "next/server";
import { addProblem } from "@/lib/hospital/problemList";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { normalizeCode } from "@/lib/hospital/problemList";
import { parseOptionalEnum } from "@/lib/enumValue";
import { $Enums } from "@prisma/client";

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

    const { diagnosis, severity, onsetDate, codeSystem, code, codeDisplay } = body ?? {};
    if (!diagnosis) throw new BadRequestError("diagnosis is required.");
    const coded = normalizeCode({ codeSystem, code, codeDisplay });

    const problem = await addProblem({
      facilityId, patientId: id, diagnosis, byUserId: session.userId, onsetDate: onsetDate ? new Date(onsetDate) : undefined, ...coded,
      severity: parseOptionalEnum($Enums.Severity, typeof severity === "string" ? severity.toUpperCase() : severity, "severity"),
    });

    await recordAuditEvent(
      "hospital.problem.added",
      session.userId,
      { patientId: id, problemId: problem.id },
      { facilityId, patientId: id }
    );
    return { problem };
  });
}
