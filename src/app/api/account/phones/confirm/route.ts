import { NextRequest } from "next/server";
import { BadRequestError, requireSession, withApiErrors } from "@/lib/auth/rbac";
import { confirmLoginPhone } from "@/lib/auth/loginPhones";

/** POST { phoneId, code } — verifies the phone on your work login (5b follow-up). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const s = await requireSession();
    const body = (await req.json().catch(() => ({}))) as { phoneId?: unknown; code?: unknown };
    if (typeof body.phoneId !== "string") throw new BadRequestError("phoneId is required.");
    return confirmLoginPhone(s.userId, body.phoneId, body.code);
  });
}
