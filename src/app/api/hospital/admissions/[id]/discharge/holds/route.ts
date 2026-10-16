import { NextRequest } from "next/server";
import { $Enums } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { parseEnum } from "@/lib/enumValue";
import { placeDischargeHold, listDischargeHolds } from "@/lib/hospital/dischargeHold";

async function dischargeOf(admissionId: string, facilityId: string) {
  const admission = await prisma.admission.findUnique({ where: { id: admissionId }, include: { encounter: true, discharge: true } });
  if (!admission || admission.encounter.facilityId !== facilityId || !admission.discharge) throw new NotFoundError("Discharge not found.");
  return admission.discharge;
}

/** Batch 6: the discharge's holds, active and cleared. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("encounter:read", searchParams.get("facilityId") ?? undefined);
    return { holds: await listDischargeHolds((await dischargeOf(id, facilityId)).id) };
  });
}

/** Place a manual hold: { reasonCode }. finalizeDischarge refuses while it is active. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("admission:discharge:initiate", body?.facilityId);
    const discharge = await dischargeOf(id, facilityId);
    const reasonCode = parseEnum($Enums.DischargeHoldReason, body?.reasonCode, "reasonCode");
    return { hold: await placeDischargeHold({ dischargeId: discharge.id, facilityId, reasonCode, byUserId: session.userId }) };
  });
}
