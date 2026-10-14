import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { facilityOrganizationId } from "@/lib/events/tenant";
import { createPatientWithUhid } from "@/lib/hospital/uhid";
import { patientSearchWhere } from "@/lib/hospital/patientSearch";
import { patientIdsByExternalIdentifier } from "@/lib/patient/identifiers";
import { estimatedDobFromAge } from "@/lib/patient/age";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const q = searchParams.get("q")?.trim();

    const externalMatchIds = q ? await patientIdsByExternalIdentifier(facilityId, q) : [];
    const patients = await prisma.patient.findMany({
      where: patientSearchWhere(facilityId, q, externalMatchIds),
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return { patients };
  });
}

const RegisterSchema = z.object({
  fullName: z.string().min(2),
  sex: z.string().min(1),
  ageYears: z.coerce.number().int().min(0).max(130).optional(),
  phone: z.string().optional(),
  bloodGroup: z.string().optional(),
  facilityId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("patient:write", body?.facilityId);
    const parsed = RegisterSchema.safeParse(body);
    if (!parsed.success) return { error: "Invalid patient data.", issues: parsed.error.issues };

    const patient = await createPatientWithUhid(facilityId, (uhid) =>
      // Phase D6 — create the patient and emit PatientRegistered in one
      // transaction so the domain fact is durable iff the patient row committed.
      prisma.$transaction(async (tx) => {
        const created = await tx.patient.create({
          data: {
            uhid,
            facilityId,
            fullName: parsed.data.fullName,
            sex: parsed.data.sex,
            // An age given at registration is recorded as an estimated dob; age is always calculated from dob.
            ...(parsed.data.ageYears !== undefined ? { dob: estimatedDobFromAge(parsed.data.ageYears), dobEstimated: true } : {}),
            phone: parsed.data.phone,
            bloodGroup: parsed.data.bloodGroup,
          },
        });
        await emitDomainEvent(tx, {
          type: "PatientRegistered",
          aggregateId: created.id,
          organizationId: await facilityOrganizationId(tx, facilityId),
          facilityId,
          actorUserId: session.userId,
          payload: { patientId: created.id, uhid: created.uhid },
        });
        return created;
      })
    );

    await recordAuditEvent(
      "hospital.patient.registered",
      session.userId,
      { patientId: patient.id },
      { facilityId, patientId: patient.id }
    );
    return { patient };
  });
}
