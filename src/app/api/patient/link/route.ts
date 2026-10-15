import { NextRequest } from "next/server";
import { requireSession, withApiErrors, BadRequestError, NotFoundError, ForbiddenError } from "@/lib/auth/rbac";
import { rateLimit } from "@/lib/auth/rateLimit";
import { linkStatusFor, verifyLinkOtp } from "@/lib/patient/selfRegistration";

/** The caller's record-link request: its status, and where the code went (masked). */
export async function GET() {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:read");
    const status = await linkStatusFor(session.userId);
    if (!status) throw new NotFoundError("No record-link request for this account.");
    return status;
  });
}

/** Body: { code }. Links the account to the matched record when the code is right. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const rl = await rateLimit(`patient-link:${session.userId}`, 10, 10 * 60_000);
    if (!rl.allowed) throw new BadRequestError("Too many attempts. Try again in a few minutes.");
    const body = await req.json().catch(() => null);
    if (typeof body?.code !== "string" || !/^\s*\d{6}\s*$/.test(body.code)) throw new BadRequestError("Enter the 6-digit code.");
    return verifyLinkOtp(session.userId, body.code);
  });
}
