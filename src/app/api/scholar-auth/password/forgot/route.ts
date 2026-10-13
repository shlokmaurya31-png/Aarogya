import { after, NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/auth/rateLimit";
import { appBaseUrl, createResetToken, RESET_TTL_MS } from "@/lib/auth/passwordReset";
import { sendEmail } from "@/lib/email/send";
import { recordAuditEvent } from "@/lib/auth/audit";

// Same answer whether or not the email has an account, and the lookup + send
// run after the response, so neither body nor timing reveals registration.
const GENERIC = { ok: true, message: "If that email has an account, a reset link is on its way." };

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });

  const ip = await rateLimit(`pwforgot:ip:${clientIp(req.headers)}`, 10, 15 * 60_000);
  const perEmail = await rateLimit(`pwforgot:email:${email}`, 3, 60 * 60_000);
  if (!ip.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait and try again." }, { status: 429 });
  }
  // Per-email overflow is silent (still GENERIC) so it can't be used to probe.
  if (!perEmail.allowed) return NextResponse.json(GENERIC);

  after(async () => {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, displayName: true, passwordHash: true },
    });
    if (!user) return;
    const link = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(createResetToken(user))}`;
    const result = await sendEmail({
      to: user.email,
      subject: "Reset your Aarogya password",
      text:
        `Hi ${user.displayName},\n\nUse this link to set a new Aarogya password. It works once and expires in ` +
        `${RESET_TTL_MS / 60_000} minutes:\n\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.`,
    });
    await recordAuditEvent("security.password.resetRequested", user.id, { delivered: result.delivered });
  });

  return NextResponse.json(GENERIC);
}
