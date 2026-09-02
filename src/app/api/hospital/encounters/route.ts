import { NextRequest } from "next/server";
import { z } from "zod";
import { EncounterType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("encounter:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const type = searchParams.get("type");
    const includeAll = searchParams.get("all") === "true";

    const encounters = await prisma.encounter.findMany({
      where: {
        facilityId,
        ...(status ? { status: status as never } : includeAll ? {} : { status: { notIn: ["DISCHARGED", "CLOSED"] } }),
        ...(type ? { type: type as never } : {}),
      },
      include: { patient: true, department: true, admission: { include: { bed: true } }, bill: true },
      orderBy: { registeredAt: "desc" },
      take: 100,
    });

    return { encounters };
  });
}

const CreateEncounterSchema = z.object({
  patientId: z.string(),
  type: z.nativeEnum(EncounterType),
  departmentId: z.string().optional(),
  chiefComplaint: z.string().optional(),
  facilityId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("encounter:create", body?.facilityId);
    const parsed = CreateEncounterSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid encounter data.");

    const patient = await prisma.patient.findUnique({ where: { id: parsed.data.patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new BadRequestError("Patient not found in this facility.");

    const encounter = await prisma.encounter.create({
      data: {
        patientId: parsed.data.patientId,
        facilityId,
        type: parsed.data.type,
        departmentId: parsed.data.departmentId,
        chiefComplaint: parsed.data.chiefComplaint,
      },
    });

    await recordAuditEvent("hospital.encounter.registered", session.userId, { encounterId: encounter.id, type: encounter.type });
    return { encounter };
  });
}
