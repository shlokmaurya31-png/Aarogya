import { NextRequest } from "next/server";
import { z } from "zod";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { admitToIcu, IcuBedCapabilityError } from "@/lib/hospital/icu";
import { BedNotAvailableError, InvalidEncounterTransitionError } from "@/lib/hospital/admission";
import { BedConcurrencyError } from "@/lib/hospital/bed";

const Schema = z.object({
  encounterId: z.string(),
  bedId: z.string(),
  reason: z.string().min(1),
  requireVentilator: z.boolean().optional(),
  requireIsolation: z.boolean().optional(),
  facilityId: z.string().optional(),
});

/** ICU admission — reuses the existing admission:create permission and guarded admitPatient. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("admission:create", body?.facilityId);
    if (!staff) throw new BadRequestError("ICU admission must be performed by a staff account.");
    const parsed = Schema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid ICU admission data.");

    try {
      const admission = await admitToIcu({
        encounterId: parsed.data.encounterId,
        bedId: parsed.data.bedId,
        facilityId,
        admittingStaffId: staff.id,
        reason: parsed.data.reason,
        requireVentilator: parsed.data.requireVentilator,
        requireIsolation: parsed.data.requireIsolation,
        byUserId: session.userId,
      });
      return { admission };
    } catch (err) {
      if (err instanceof IcuBedCapabilityError || err instanceof BedNotAvailableError || err instanceof InvalidEncounterTransitionError || err instanceof BedConcurrencyError) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }
  });
}
