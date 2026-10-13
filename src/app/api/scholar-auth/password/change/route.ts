import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { requireSession, UnauthorizedError } from "@/lib/auth/rbac";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/passwordReset";
import { invalidateSessionsOnCredentialChange } from "@/lib/auth/authorize/sessionControl";
import { rateLimit } from "@/lib/auth/rateLimit";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = (await requireSession()).userId;
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    throw err;
  }

  const limit = await rateLimit(`pwchange:${userId}`, 5, 15 * 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait and try again." }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, passwordHash: true } });
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
  }

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
  // Sign out every other device, then re-issue this device's cookie at the new version.
  await invalidateSessionsOnCredentialChange(user.id);
  await createSession(user.id, user.role);
  await recordAuditEvent("security.password.changed", user.id);

  return NextResponse.json({ ok: true });
}
