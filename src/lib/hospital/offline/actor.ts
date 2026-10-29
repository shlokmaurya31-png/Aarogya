import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { BadRequestError } from "@/lib/auth/rbac";
import type { NurseActor } from "./service";

/** The nurse signed in on a ward device: a staff account that may give medicines at the facility. */
export async function requireNurse(facilityId?: string): Promise<NurseActor> {
  const ctx = await requireFacilityStaff("medication:administer", facilityId);
  if (!ctx.staff) throw new BadRequestError("Offline nursing needs a staff account.");
  return { userId: ctx.session.userId, staffId: ctx.staff.id, facilityId: ctx.facilityId };
}
