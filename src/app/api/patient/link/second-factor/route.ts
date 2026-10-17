import { NextRequest } from "next/server";
import { requireSession, withApiErrors, BadRequestError, ForbiddenError } from "@/lib/auth/rbac";
import { rateLimit } from "@/lib/auth/rateLimit";
import { submitSecondFactor } from "@/lib/person/linking";

/** Phase 0. Body: { kind: "DOB" | "UHID", value }. Must match the record exactly; then a code goes to the record's phone. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const rl = await rateLimit(`patient-link:${session.userId}`, 10, 10 * 60_000);
    if (!rl.allowed) throw new BadRequestError("Too many attempts. Try again in a few minutes.");
    const body = await req.json().catch(() => null);
    if (typeof body?.kind !== "string" || typeof body?.value !== "string" || body.value.length > 64) throw new BadRequestError("Give kind (DOB or UHID) and value.");
    return submitSecondFactor(session.userId, { kind: body.kind, value: body.value });
  });
}
