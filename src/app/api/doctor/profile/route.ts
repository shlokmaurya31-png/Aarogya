import { NextRequest } from "next/server";
import { ForbiddenError, requireSession, withApiErrors } from "@/lib/auth/rbac";
import { ownDoctorView, registerDoctor, updateOwnProfile } from "@/lib/doctors/profile";

async function doctorSession() {
  const s = await requireSession();
  if (s.role !== "DOCTOR") throw new ForbiddenError("doctor:profile:manage");
  return s;
}

/** GET — the doctor's own profile, cases (no documents), links and locations (Week 5a). */
export async function GET() {
  return withApiErrors(async () => ownDoctorView((await doctorSession()).userId));
}

/** POST — register: { registrationNumber, stateCouncil, registrationYear?, specialties[], primarySpecialty?, languages[], qualifications[] }. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => registerDoctor((await doctorSession()).userId, await req.json().catch(() => ({}))));
}

/** PATCH — { languages?, specialties?, primarySpecialty?, displayName?, listed? } (listing only once verified). */
export async function PATCH(req: NextRequest) {
  return withApiErrors(async () => updateOwnProfile((await doctorSession()).userId, await req.json().catch(() => ({}))));
}
