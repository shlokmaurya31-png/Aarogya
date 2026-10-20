import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { createHousehold, myHouseholds } from "@/lib/household/households";

/** GET — the caller's households (Week 5b). POST { name? } — create one, the caller its manager. */
export async function GET() {
  return withApiErrors(async () => ({ households: await myHouseholds((await patientSession()).userId) }));
}
export async function POST(req: NextRequest) {
  return withApiErrors(async () => createHousehold((await patientSession()).userId, (await req.json().catch(() => ({})))?.name));
}
