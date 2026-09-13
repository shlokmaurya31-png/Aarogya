import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { addFacilityMembership, listFacilityMembers } from "@/lib/enterprise/memberships";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ facilityId: string }> }) {
  return withApiErrors(async () => {
    const { facilityId } = await params;
    const m = await requireActorMemberships("enterprise:membership:manage");
    return { members: await listFacilityMembers(m, facilityId) };
  });
}

const addSchema = z.object({ userId: z.string().min(1), isAdmin: z.boolean().default(false) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ facilityId: string }> }) {
  return withApiErrors(async () => {
    const { facilityId } = await params;
    const m = await requireActorMemberships("enterprise:membership:manage");
    const parsed = addSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { membership: await addFacilityMembership(m, { facilityId, ...parsed.data }) };
  });
}
