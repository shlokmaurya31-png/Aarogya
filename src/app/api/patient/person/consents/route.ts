import { NextRequest } from "next/server";
import { requireSession, withApiErrors, BadRequestError, ForbiddenError } from "@/lib/auth/rbac";
import { decidePersonConsent, assertDecision } from "@/lib/person/consent";

/**
 * Week 4a: the person's own choices, one purpose at a time (DPDP: consent per
 * purpose). Body { purpose, decision: "GRANTED" | "DECLINED", scopes? }.
 * Purposes: SHARE_UPLOADS_WITH_TREATING, DOCUMENT_PROCESSING, AI_ASSISTANCE,
 * AI_TEXT_RETENTION (scope SAFETY_REVIEW). No defaults; changeable any time.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const b = await req.json().catch(() => null);
    if (typeof b?.purpose !== "string") throw new BadRequestError("purpose is required.");
    if (b.scopes !== undefined && !(Array.isArray(b.scopes) && b.scopes.every((x: unknown) => typeof x === "string"))) throw new BadRequestError("scopes must be a list.");
    return decidePersonConsent({ userId: session.userId, purpose: b.purpose, decision: assertDecision(b?.decision), scopes: b.scopes });
  });
}
