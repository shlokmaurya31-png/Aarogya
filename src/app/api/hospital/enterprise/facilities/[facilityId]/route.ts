import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { updateFacility } from "@/lib/enterprise/facilities";

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  city: z.string().optional().nullable(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ facilityId: string }> }) {
  return withApiErrors(async () => {
    const { facilityId } = await params;
    const m = await requireActorMemberships("enterprise:facility:manage");
    const parsed = updateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { facility: await updateFacility(m, facilityId, parsed.data) };
  });
}
