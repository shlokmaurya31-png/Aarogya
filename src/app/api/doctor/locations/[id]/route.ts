import { NextRequest } from "next/server";
import { ForbiddenError, requireSession, withApiErrors } from "@/lib/auth/rbac";
import { updateLocation } from "@/lib/doctors/locations";

/** PATCH — { modes?, feeMinor? (clinic only), active?, lat?, lng?, pincode?, addressLine? } (Week 5a). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const s = await requireSession();
    if (s.role !== "DOCTOR") throw new ForbiddenError("doctor:profile:manage");
    return updateLocation(s.userId, (await params).id, (await req.json().catch(() => ({}))) as Record<string, unknown>);
  });
}
