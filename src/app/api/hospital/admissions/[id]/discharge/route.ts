import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { initiateDischarge, updateDischargeReadiness } from "@/lib/hospital/admission";

/** Discharge Command Center (brief §36): shows exactly why a patient hasn't left via these readiness flags. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("encounter:read", searchParams.get("facilityId") ?? undefined);

    const admission = await prisma.admission.findUnique({
      where: { id },
      include: { encounter: true, discharge: true },
    });
    if (!admission || admission.encounter.facilityId !== facilityId) throw new NotFoundError("Admission not found.");
    return { discharge: admission.discharge };
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("admission:discharge:initiate", body?.facilityId);

    const admission = await prisma.admission.findUnique({ where: { id }, include: { encounter: true, discharge: true } });
    if (!admission || admission.encounter.facilityId !== facilityId) throw new NotFoundError("Admission not found.");
    if (admission.discharge) throw new BadRequestError("Discharge already initiated for this admission.");

    const discharge = await initiateDischarge(id, session.userId, staff?.id);
    return { discharge };
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("admission:discharge:initiate", body?.facilityId);

    const admission = await prisma.admission.findUnique({ where: { id }, include: { encounter: true, discharge: true } });
    if (!admission || admission.encounter.facilityId !== facilityId || !admission.discharge) throw new NotFoundError("Discharge not found.");

    const allowedKeys = ["clinicallyReady", "documentationReady", "billingReady", "insuranceReady", "pharmacyReady", "transportReady"] as const;
    const flags: Partial<Record<(typeof allowedKeys)[number], boolean>> = {};
    for (const key of allowedKeys) {
      if (typeof body?.[key] === "boolean") flags[key] = body[key];
    }
    let updated = await updateDischargeReadiness(admission.discharge.id, flags);

    // Expected discharge date/time (brief §39) — tracked with an explicit reason for
    // each change, never silently overwritten, so expected-vs-actual LOS variance stays explainable.
    if (typeof body?.expectedDischargeAt === "string") {
      updated = await prisma.discharge.update({
        where: { id: admission.discharge.id },
        data: { expectedDischargeAt: new Date(body.expectedDischargeAt), expectedDischargeReason: body?.expectedDischargeReason ?? null },
      });
      await recordAuditEvent("hospital.discharge.expectedDateChanged", session.userId, {
        dischargeId: admission.discharge.id,
        expectedDischargeAt: body.expectedDischargeAt,
        reason: body?.expectedDischargeReason,
      });
    }

    if (Object.keys(flags).length > 0) {
      await recordAuditEvent("hospital.discharge.blockerChanged", session.userId, { dischargeId: admission.discharge.id, flags });
    }

    return { discharge: updated };
  });
}
