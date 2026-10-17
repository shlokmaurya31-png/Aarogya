import { setOwnVerificationStatusForDev } from "@/lib/student/accounts";
import { NextRequest, NextResponse } from "next/server";
import { VerificationStatus } from "@prisma/client";
import { requireSession } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * Dev-only shortcut so a local demo doesn't require standing up a full
 * admin review workflow to see the verified experience. Brief §66: "must
 * NOT appear in production builds." Gated on both NODE_ENV and the explicit
 * ENABLE_DEV_VERIFICATION flag — either being unset disables this route.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production" || process.env.ENABLE_DEV_VERIFICATION !== "true") {
    return NextResponse.json({ error: "Dev verification shortcuts are disabled." }, { status: 403 });
  }

  const session = await requireSession();
  const body = await req.json().catch(() => ({}));
  const action = body?.action === "reject" ? "reject" : body?.action === "pending" ? "pending" : "approve";

  const status =
    action === "approve" ? VerificationStatus.VERIFIED : action === "reject" ? VerificationStatus.REJECTED : VerificationStatus.UNDER_REVIEW;

  const profile = await setOwnVerificationStatusForDev(session.userId, status);

  await recordAuditEvent(
    status === VerificationStatus.VERIFIED ? "student.verification.approved" : "student.verification.rejected",
    session.userId,
    { via: "dev-shortcut" }
  );

  return NextResponse.json({ verificationStatus: profile.verificationStatus });
}
