import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { prisma } from "@/lib/db";
import { redeemAccessCode } from "@/lib/patient/accessSession";

/**
 * POST — a clinician redeems a patient-supplied access code, opening an ACTIVE
 * consultation session that grants full-history access for the visit.
 * Gated by clinical:chart:read (same permission the chart itself requires).
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("clinical:chart:read");
    const body = await req.json().catch(() => ({}));
    const raw = typeof body?.code === "string" ? body.code.replace(/[^a-zA-Z0-9]/g, "") : "";
    if (!raw) throw new BadRequestError("Enter the patient's access code.");

    const staff = await prisma.hospitalStaffProfile.findUnique({
      where: { userId: session.userId },
      include: { user: true },
    });

    const accessSession = await redeemAccessCode({
      code: raw,
      doctorUserId: session.userId,
      doctorStaffId: staff?.id ?? null,
      doctorName: staff?.user?.displayName ?? null,
      facilityId: facilityId ?? null,
    });

    // Uniform failure: invalid / expired / already-used are indistinguishable.
    if (!accessSession) throw new BadRequestError("That code is invalid, expired, or already in use.");

    const patient = await prisma.patient.findUnique({
      where: { id: accessSession.patientId },
      select: { id: true, fullName: true, uhid: true, sex: true, ageYears: true, bloodGroup: true },
    });

    return {
      sessionId: accessSession.id,
      patient,
      redeemedAt: accessSession.redeemedAt,
    };
  });
}
