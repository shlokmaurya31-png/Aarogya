import { NextRequest } from "next/server";
import { z } from "zod";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { callNext } from "@/lib/hospital/queue";

const CallNextSchema = z.object({
  queueType: z.enum(["REGISTRATION", "TRIAGE", "OPD_DOCTOR", "ED"]),
  practitionerStaffId: z.string().optional(),
  facilityId: z.string().optional(),
});

/** Calls the next patient for a queue — lowest priorityScore, then longest-waiting (brief §14). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("queue:manage", body?.facilityId);
    const parsed = CallNextSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid request.");

    const entry = await callNext(facilityId, parsed.data.queueType, parsed.data.practitionerStaffId, session.userId);
    return { entry };
  });
}
