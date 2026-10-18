import { NextRequest } from "next/server";
import { requireSession, withApiErrors, BadRequestError, ForbiddenError } from "@/lib/auth/rbac";
import { rateLimit } from "@/lib/auth/rateLimit";
import { startPersonMerge } from "@/lib/person/merge";

/**
 * Phase 0: combine two of your own accounts. Signed in as the account that
 * stays, give the other account's email and password; a code then goes to
 * each account's email. There is no staff route for this.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const rl = await rateLimit(`person-merge:${session.userId}`, 5, 60 * 60_000);
    if (!rl.allowed) throw new BadRequestError("Too many attempts. Try again later.");
    const b = await req.json().catch(() => null);
    if (typeof b?.otherEmail !== "string" || typeof b?.otherPassword !== "string") throw new BadRequestError("otherEmail and otherPassword are required.");
    return startPersonMerge(session.userId, { otherEmail: b.otherEmail, otherPassword: b.otherPassword, channel: b.channel === "PHONE" ? "PHONE" : b.channel === undefined ? "EMAIL" : b.channel });
  });
}
