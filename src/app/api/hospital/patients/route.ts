import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { patientSearchWhere } from "@/lib/hospital/patientSearch";
import { registerPatient } from "@/lib/patient/registration";
import { patientIdsByExternalIdentifier } from "@/lib/patient/identifiers";

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
    if (!parsed.success) throw new BadRequestError("Invalid patient data.", { issues: parsed.error.issues });

    const patient = await registerPatient({ facilityId, byUserId: session.userId, ...parsed.data });
    return { patient };
  });
}
