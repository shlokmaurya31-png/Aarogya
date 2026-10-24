import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { addDependentAdult } from "@/lib/household/households";

/** POST { displayName, relationship, dateOfBirth?, phone? | email?, permissions?, categories? } — a dependent adult, pending their consent (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => addDependentAdult((await patientSession()).userId, (await params).id, await req.json().catch(() => ({}))));
}
