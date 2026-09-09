import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const patient = await prisma.patient.findUnique({
      where: { id },
      include: { identifiers: true, emergencyContacts: { orderBy: { priority: "asc" } } },
    });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    return { patient };
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

    const existing = await prisma.patient.findUnique({ where: { id } });
    if (!existing || existing.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const d = parsed.data;
    const deceasedAt =
      d.deceased === true ? (d.deceasedAt ? new Date(d.deceasedAt) : new Date()) : d.deceased === false ? null : undefined;

    const patient = await prisma.patient.update({
      where: { id },
      data: {
        ...(d.fullName !== undefined ? { fullName: d.fullName } : {}),
        ...(d.preferredName !== undefined ? { preferredName: d.preferredName } : {}),
        ...(d.phone !== undefined ? { phone: d.phone } : {}),
        ...(d.address !== undefined ? { address: d.address } : {}),
        ...(d.bloodGroup !== undefined ? { bloodGroup: d.bloodGroup } : {}),
        ...(d.language !== undefined ? { language: d.language } : {}),
        ...(deceasedAt !== undefined ? { deceasedAt } : {}),
      },
    });

    await recordAuditEvent("hospital.patient.updated", session.userId, { patientId: id }, { facilityId, patientId: id });
    if (deceasedAt !== undefined && deceasedAt !== null) {
      await recordAuditEvent("hospital.patient.deceasedRecorded", session.userId, { patientId: id, deceasedAt }, { facilityId, patientId: id });
    }
    return { patient };
  });
}
