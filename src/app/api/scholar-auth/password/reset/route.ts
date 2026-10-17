import { replacePasswordHash } from "@/lib/auth/credentials";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { MIN_PASSWORD_LENGTH, readResetToken, resetTokenMatches } from "@/lib/auth/passwordReset";
import { invalidateSessionsOnCredentialChange } from "@/lib/auth/authorize/sessionControl";
import { clientIp, rateLimit, resetRateLimit } from "@/lib/auth/rateLimit";
import { recordAuditEvent } from "@/lib/auth/audit";

const INVALID = "This reset link is invalid or has expired. Request a new one.";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";
  const password = typeof body?.password === "string" ? body.password : "";

  const ip = await rateLimit(`pwreset:ip:${clientIp(req.headers)}`, 20, 15 * 60_000);
  if (!ip.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait and try again." }, { status: 429 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 });
  }

  const payload = readResetToken(token);
  if (!payload) return NextResponse.json({ error: INVALID }, { status: 400 });
  const user = await prisma.user.findUnique({ where: { id: payload.u }, select: { id: true, email: true, passwordHash: true } });
  if (!user || !resetTokenMatches(payload, user.passwordHash)) {
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }

  await replacePasswordHash(user.id, await hashPassword(password));
  // New hash already invalidates the token; this also signs out every device.
  await invalidateSessionsOnCredentialChange(user.id);
  await recordAuditEvent("security.password.reset", user.id);
  await resetRateLimit(`login:email:${user.email}`);

  return NextResponse.json({ ok: true });
}
