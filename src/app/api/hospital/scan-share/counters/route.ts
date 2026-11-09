import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { countersWithQr, createCounter } from "@/lib/hospital/scanShare/service";

/** GET: the facility's Scan and Share counters, each with its QR (the desk shows them). Flagship 6. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { facilityId } = await requireFacilityStaff("queue:manage", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    return { counters: await countersWithQr(facilityId, req.nextUrl.origin) };
  });
}

/** POST { code, label }: a new counter (the hospital admin). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("hospital:admin:manage", body?.facilityId);
    const c = await createCounter({ userId: session.userId, facilityId }, body);
    return { counter: { id: c.id, code: c.code, label: c.label } };
  });
}
