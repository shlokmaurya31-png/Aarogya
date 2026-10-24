import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { revokeGrantAsMember, updateGrantAsMember } from "@/lib/household/grants";

/** PATCH { permissions?, categories?, sensitiveCategories? } — change what a proxy may do or see (Week 5b). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => updateGrantAsMember((await patientSession()).userId, (await params).id, await req.json().catch(() => ({}))));
}
/** DELETE — remove a proxy, at once. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => revokeGrantAsMember((await patientSession()).userId, (await params).id));
}
