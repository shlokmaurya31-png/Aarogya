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

    const patient = await prisma.patient.findUnique({ where: { id }, include: { emergencyContacts: { orderBy: { priority: "asc" } } } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    return { emergencyContacts: patient.emergencyContacts };
  });
}

const AddSchema = z.object({
  name: z.string().min(1),
  relation: z.string().min(1), // "guardian" | "spouse" | "parent" | ... (free text)
  phone: z.string().min(1),
  priority: z.coerce.number().int().min(1).optional(),
  facilityId: z.string().optional(),
});

/** Add a guardian / emergency contact (brief §12). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("patient:write", body?.facilityId);
    const parsed = AddSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid emergency contact.");

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const contact = await prisma.patientEmergencyContact.create({
      data: { patientId: id, name: parsed.data.name, relation: parsed.data.relation, phone: parsed.data.phone, priority: parsed.data.priority ?? 1 },
    });

    await recordAuditEvent(
      "hospital.patient.emergencyContactAdded",
      session.userId,
      { patientId: id, contactId: contact.id },
      { facilityId, patientId: id }
    );
    return { contact };
  });
}
