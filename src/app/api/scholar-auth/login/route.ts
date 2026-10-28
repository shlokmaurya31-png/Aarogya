import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { clientIp, rateLimit, resetRateLimit } from "@/lib/auth/rateLimit";

// Brute-force bounds. Per-email stops guessing one account's password from
// many IPs; per-IP stops spraying many accounts from one IP. A successful
// login clears that email's counter.
const WINDOW_MS = 15 * 60_000;
const PER_EMAIL = 5;
const PER_IP = 30;

// Compared against when the email is unknown, so a miss costs the same scrypt
// time as a wrong password and response timing does not reveal which emails
// are registered.
let dummyHash: Promise<string> | null = null;
function getDummyHash() {
  dummyHash ??= hashPassword("aarogya-timing-equaliser");
  return dummyHash;
}

function tooMany(retryAfterMs: number) {
  return NextResponse.json(
    { error: "Too many sign-in attempts. Please wait and try again." },
    { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } }
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  const ipLimit = await rateLimit(`login:ip:${clientIp(req.headers)}`, PER_IP, WINDOW_MS);
  if (!ipLimit.allowed) return tooMany(ipLimit.retryAfterMs);
  const emailKey = `login:email:${email}`;
  const emailLimit = await rateLimit(emailKey, PER_EMAIL, WINDOW_MS);
  if (!emailLimit.allowed) return tooMany(emailLimit.retryAfterMs);

  const user = await prisma.user.findUnique({ where: { email }, omit: { passwordHash: false } });
  const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !ok) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  await resetRateLimit(emailKey);
  await createSession(user.id, user.role);
  return NextResponse.json({ id: user.id, role: user.role, displayName: user.displayName, email: user.email });
}
