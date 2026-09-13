import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { transitionFacility } from "@/lib/enterprise/facilities";

const schema = z.object({
  to: z.enum(["PROVISIONING", "ACTIVE", "SUSPENDED", "DEACTIVATED"]),
  reason: z.string().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ facilityId: string }> }) {
  return withApiErrors(async () => {
    const { facilityId } = await params;
    const m = await requireActorMemberships("enterprise:facility:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { facility: await transitionFacility(m, facilityId, parsed.data.to, parsed.data.reason) };
  });
}
