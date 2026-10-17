import { NextRequest } from "next/server";
import { requireSession, withApiErrors, BadRequestError, ForbiddenError } from "@/lib/auth/rbac";
import { rateLimit } from "@/lib/auth/rateLimit";
import { connectFacilityRecord } from "@/lib/patient/selfRegistration";

/**
 * Phase 0: connect your record at a facility. Body: { facilityId, fullName,
 * sex, dob?, phone? }. No match creates a record there; a match opens a link
 * request (second factor + code, or in-person verification). Never links on
 * a match by itself.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const rl = await rateLimit(`patient-connect:${session.userId}`, 5, 60 * 60_000);
    if (!rl.allowed) throw new BadRequestError("Too many attempts. Try again later.");
    const b = await req.json().catch(() => null);
    if (typeof b?.facilityId !== "string" || typeof b?.fullName !== "string" || b.fullName.trim().length < 2 || typeof b?.sex !== "string" || !b.sex) {
      throw new BadRequestError("facilityId, fullName and sex are required.");
    }
    const dob = typeof b.dob === "string" ? new Date(b.dob) : undefined;
    if (dob && Number.isNaN(dob.getTime())) throw new BadRequestError("Invalid date of birth.");
    return connectFacilityRecord(session.userId, {
      facilityId: b.facilityId, fullName: b.fullName.trim().slice(0, 200), sex: b.sex, dob,
      phone: typeof b.phone === "string" ? b.phone.slice(0, 40) : undefined,
    });
  });
}
