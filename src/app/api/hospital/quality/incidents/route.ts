import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createQualityIncident } from "@/lib/hospital/quality/service";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("quality:incident:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const severity = searchParams.get("severity");
    const category = searchParams.get("category");
    const departmentId = searchParams.get("departmentId");
    const investigator = searchParams.get("investigator");
    const incidents = await prisma.qualityIncident.findMany({
      where: {
        facilityId,
        ...(status ? { status } : {}),
        ...(severity ? { severity } : {}),
        ...(category ? { category } : {}),
        ...(departmentId ? { departmentId } : {}),
        ...(investigator ? { assignedInvestigatorStaffId: investigator } : {}),
      },
      orderBy: [{ reportedAt: "desc" }],
      take: 200,
    });
    return { incidents };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("quality:incident:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Reporting an incident requires a staff account.");
    if (!body?.category || !body?.title || !body?.description) throw new BadRequestError("category, title and description are required.");
    const incident = await createQualityIncident({
      facilityId, category: body.category, severity: body.severity, title: body.title, description: body.description,
      patientId: body.patientId || undefined, encounterId: body.encounterId || undefined, departmentId: body.departmentId || undefined,
      immediateAction: body.immediateAction, occurrenceAt: body.occurrenceAt ? new Date(body.occurrenceAt) : undefined,
      dueAt: body.dueAt ? new Date(body.dueAt) : undefined, confidentiality: body.confidentiality,
      relatedEntityType: body.relatedEntityType, relatedEntityId: body.relatedEntityId, infectionIncidentId: body.infectionIncidentId,
      source: body.source, reportedByStaffId: staff.id, byUserId: session.userId,
    });
    return { incident };
  });
}
