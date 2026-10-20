import { NextRequest } from "next/server";
import { ForbiddenError, requireSession, withApiErrors } from "@/lib/auth/rbac";
import { addClinicLocation, addHospitalLocation } from "@/lib/doctors/locations";

/**
 * POST — a practice location (Week 5a): { kind: "HOSPITAL", facilityId, modes, lat?, lng?, pincode?, addressLine? }
 * (the hospital's fee applies) or { kind: "CLINIC", name, feeMinor, modes, lat, lng, pincode?, addressLine?, city? }.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const s = await requireSession();
    if (s.role !== "DOCTOR") throw new ForbiddenError("doctor:profile:manage");
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return b.kind === "CLINIC" ? addClinicLocation(s.userId, b) : addHospitalLocation(s.userId, b);
  });
}
