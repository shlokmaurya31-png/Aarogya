import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { startAddMinor } from "@/lib/household/households";

/** POST { displayName, dateOfBirth, sex?, relationship, declaration: true } — parental consent, step 1: a code to your verified phone (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => startAddMinor((await patientSession()).userId, (await params).id, await req.json().catch(() => ({}))));
}
