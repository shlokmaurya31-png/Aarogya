import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createPatientWithUhid } from "@/lib/hospital/uhid";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const q = searchParams.get("q")?.trim();

    const patients = await prisma.patient.findMany({
      where: {
        facilityId,
        ...(q
          ? {
              OR: [
                { fullName: { contains: q } },
                { uhid: { contains: q } },
                { phone: { contains: q } },
                // Phase 6.8 — search by any patient identifier (ABHA/MRN/insurance).
                { identifiers: { some: { value: { contains: q } } } },
              ],
            }
          : {}),
      },
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
      prisma.patient.create({
        data: {
          uhid,
          facilityId,
          fullName: parsed.data.fullName,
          sex: parsed.data.sex,
          ageYears: parsed.data.ageYears,
          phone: parsed.data.phone,
          bloodGroup: parsed.data.bloodGroup,
        },
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
