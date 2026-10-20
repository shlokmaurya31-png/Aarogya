import { NextRequest } from "next/server";
import { requirePermission, withApiErrors } from "@/lib/auth/rbac";
import { suspendDoctor } from "@/lib/doctors/verification";

/** POST { reasonCode } — the platform team suspends a doctor: out of search and new bookings at once (Week 5a). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const s = await requirePermission("doctor:verify");
    const b = await req.json().catch(() => ({}));
    return suspendDoctor(s.userId, (await params).id, b?.reasonCode);
  });
}
