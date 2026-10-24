import { updatePatientRecord } from "@/lib/patient/demographics";
import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { listPatientIdentifiers } from "@/lib/patient/identifiers";
import { noteStaffChartRead } from "@/lib/doctors/self";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { session, facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const patient = await prisma.patient.findUnique({
      where: { id },
      include: { identifiers: true, emergencyContacts: { orderBy: { priority: "asc" } } },
    });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    // 5b follow-up: reading one's own chart as staff is allowed, recorded as SELF_ACCESS (src/lib/doctors/self.ts).
    await noteStaffChartRead({ userId: session.userId, facilityId }, patient.id, "PATIENT");
    const { externalIdentifiers } = await listPatientIdentifiers(facilityId, id);
    return { patient: { ...patient, externalIdentifiers } };
  });
}

const UpdateSchema = z.object({
  fullName: z.string().min(2).optional(),
  preferredName: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  bloodGroup: z.string().optional(),
  language: z.string().optional(),
  // Deceased status (brief §13) — factual flag + timestamp, no medical
  // certification workflow. Pass deceased:true to set (defaults deceasedAt to
  // now if no timestamp given); deceased:false clears it.
  deceased: z.boolean().optional(),
  deceasedAt: z.string().datetime().optional(),
  facilityId: z.string().optional(),
});

/** Update patient demographics and/or deceased status (brief §12/§13). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("patient:write", body?.facilityId);
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid patient update.");

    const d = parsed.data;
    const deceasedAt =
      d.deceased === true ? (d.deceasedAt ? new Date(d.deceasedAt) : new Date()) : d.deceased === false ? null : undefined;

    const patient = await updatePatientRecord({
      patientId: id, facilityId, byUserId: session.userId,
      changes: { fullName: d.fullName, preferredName: d.preferredName, phone: d.phone, address: d.address, bloodGroup: d.bloodGroup, language: d.language, deceasedAt },
    });

    await recordAuditEvent("hospital.patient.updated", session.userId, { patientId: id }, { facilityId, patientId: id });
    if (deceasedAt !== undefined && deceasedAt !== null) {
      await recordAuditEvent("hospital.patient.deceasedRecorded", session.userId, { patientId: id, deceasedAt }, { facilityId, patientId: id });
    }
    return { patient };
  });
}
