import { createHash, randomInt } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { maskPhone, sendSms } from "@/lib/messaging/sms";
import { normalizePhone } from "@/lib/person/linking";

/**
 * Week 5b follow-up — verified phones of staff and doctor logins
 * (docs/DOCTOR_NETWORK_DESIGN.md §14). Their only use is the same-human check
 * (src/lib/doctors/self.ts): a doctor can't open their own record through
 * doctor tools, and a staff member reading their own chart is recorded as
 * SELF_ACCESS. Patients' phones are PersonContacts, never these. A phone is
 * verified by a code sent to it; it belongs to one login at a time. Audited
 * (security.loginPhone.*); no event, like other login credentials and
 * contact details of a login.
 */
const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const hash = (id: string, code: string) => createHash("sha256").update(`${id}:${code}`).digest("hex");

async function staffLogin(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!u) throw new NotFoundError();
  // Patients keep their phones as PersonContacts; students have no record access to check.
  if (u.role === "PATIENT" || u.role === "STUDENT") throw new NotFoundError();
  return u;
}

export function samePhone(a: string, b: string): boolean {
  // The last 10 digits: the same Indian mobile number however it was written.
  const da = a.replace(/\D/g, "").slice(-10), db = b.replace(/\D/g, "").slice(-10);
  return da.length === 10 && da === db;
}

/** Sends a code to a phone the login wants to add. */
export async function startLoginPhone(userId: string, raw: unknown) {
  await staffLogin(userId);
  if (typeof raw !== "string" || raw.replace(/\D/g, "").length < 10) throw new BadRequestError("Enter a 10-digit mobile number.");
  const phone = normalizePhone(raw);
  const mine = await prisma.loginPhone.findFirst({ where: { userId, phone, status: "VERIFIED" } });
  if (mine) throw new ConflictError("This phone is already verified on your login.");
  const taken = await prisma.loginPhone.findFirst({ where: { phone, status: "VERIFIED", userId: { not: userId } }, select: { id: true } });
  if (taken) throw new ConflictError("This phone is verified on another login. Remove it there first.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = await prisma.loginPhone.create({ data: { userId, phone } });
  await prisma.loginPhone.update({ where: { id: row.id }, data: { codeHash: hash(row.id, code), codeExpiresAt: new Date(Date.now() + CODE_TTL_MS) } });
  const sent = await sendSms(phone, `Aarogya: your code to verify this phone on your work login is ${code}. It expires in 10 minutes. Don't share it.`);
  if (!sent.delivered) throw new ConflictError("The code couldn't be sent. Try again later.");
  return { phoneId: row.id, sentTo: maskPhone(phone) };
}

/** Confirms the code: the phone is VERIFIED on this login. */
export async function confirmLoginPhone(userId: string, phoneId: string, code: unknown) {
  const row = await prisma.loginPhone.findUnique({ where: { id: phoneId } });
  if (!row || row.userId !== userId || row.status !== "PENDING") throw new NotFoundError();
  if (row.attempts >= MAX_ATTEMPTS) throw new ConflictError("Too many wrong codes. Start again.");
  if (!row.codeHash || !row.codeExpiresAt || row.codeExpiresAt < new Date() || typeof code !== "string" || hash(row.id, code.trim()) !== row.codeHash) {
    await prisma.loginPhone.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    throw new BadRequestError("That code isn't right or has expired.");
  }
  const taken = await prisma.loginPhone.findFirst({ where: { phone: row.phone, status: "VERIFIED", userId: { not: userId } }, select: { id: true } });
  if (taken) throw new ConflictError("This phone is verified on another login. Remove it there first.");
  const r = await prisma.loginPhone.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "VERIFIED", verifiedAt: new Date(), codeHash: null } });
  if (r.count !== 1) throw new ConflictError("Already confirmed.");
  await recordAuditEvent("security.loginPhone.verified", userId, { phoneId: row.id });
  return { phoneId: row.id, phone: maskPhone(row.phone), status: "VERIFIED" as const };
}

export async function listLoginPhones(userId: string) {
  await staffLogin(userId);
  const rows = await prisma.loginPhone.findMany({ where: { userId, status: "VERIFIED" }, orderBy: { verifiedAt: "asc" } });
  return rows.map((r) => ({ phoneId: r.id, phone: maskPhone(r.phone), verifiedAt: r.verifiedAt!.toISOString() }));
}

export async function removeLoginPhone(userId: string, phoneId: string) {
  const row = await prisma.loginPhone.findUnique({ where: { id: phoneId } });
  if (!row || row.userId !== userId || row.status !== "VERIFIED") throw new NotFoundError();
  await prisma.loginPhone.update({ where: { id: row.id }, data: { status: "REMOVED", removedAt: new Date() } });
  await recordAuditEvent("security.loginPhone.removed", userId, { phoneId: row.id });
  return { status: "REMOVED" as const };
}

/**
 * Every phone ever verified on the login (for the same-human check only).
 * A removed phone still counts: removing it can't take a doctor back into
 * their own record.
 */
export async function verifiedLoginPhones(userId: string): Promise<string[]> {
  return (await prisma.loginPhone.findMany({ where: { userId, verifiedAt: { not: null } }, select: { phone: true } })).map((r) => r.phone);
}
