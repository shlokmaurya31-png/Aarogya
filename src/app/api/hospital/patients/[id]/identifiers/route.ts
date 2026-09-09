import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

const IDENTIFIER_TYPES = ["ABHA", "MRN", "EXTERNAL_MRN", "INSURANCE_MEMBER_ID", "LEGACY", "OTHER"];

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const patient = await prisma.patient.findUnique({ where: { id }, include: { identifiers: true } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    return { identifiers: patient.identifiers };
  });
}

const AddSchema = z.object({
  type: z.string().min(1),
  value: z.string().min(1),
  issuer: z.string().optional(),
  facilityId: z.string().optional(),
});

/** Add a patient identifier — ABHA/MRN/insurance/etc. (brief §4/§6). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("patient:write", body?.facilityId);
    const parsed = AddSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid identifier data.");
    if (!IDENTIFIER_TYPES.includes(parsed.data.type)) {
      throw new BadRequestError(`type must be one of ${IDENTIFIER_TYPES.join(", ")}.`);
    }

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const identifier = await prisma.patientIdentifier.create({
      data: { patientId: id, type: parsed.data.type, value: parsed.data.value, issuer: parsed.data.issuer },
    });

    await recordAuditEvent(
      "hospital.patient.identifierAdded",
      session.userId,
      { patientId: id, identifierId: identifier.id, type: identifier.type },
      { facilityId, patientId: id }
    );
    return { identifier };
  });
}
