import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { clientIp, rateLimit } from "@/lib/auth/rateLimit";
import { BadRequestError } from "@/lib/auth/rbac";
import { registerPatientAccount } from "@/lib/patient/selfRegistration";

/**
 * Patient self-registration (src/lib/patient/selfRegistration.ts). Creates
 * the PATIENT account, then either a new Patient record or, when the person
 * likely already has a record at this facility, a link request that needs a
 * one-time code (sent to the phone ON THE RECORD) or front-desk review. A
 * likely match is never auto-linked, and nothing about the matched record is
 * returned beyond a masked phone number.
 */
const RegisterSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  sex: z.string().min(1),
  phone: z.string().optional(),
  dob: z.string().optional(),
  facilityId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const rl = await rateLimit(`patient-register:ip:${clientIp(req.headers)}`, 20, 60 * 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Too many registrations. Try again later." }, { status: 429 });

  const body = await req.json().catch(() => null);
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid registration data.", issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;
  const email = input.email.toLowerCase();
  const dob = input.dob ? new Date(input.dob) : undefined;
  if (dob && Number.isNaN(dob.getTime())) return NextResponse.json({ error: "Invalid date of birth." }, { status: 400 });

  if (await prisma.user.findUnique({ where: { email } })) {
    return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
  }

  let outcome;
  try {
    outcome = await registerPatientAccount({
      fullName: input.fullName, email, passwordHash: await hashPassword(input.password),
      sex: input.sex, phone: input.phone, dob, facilityId: input.facilityId,
    });
  } catch (err) {
    if (err instanceof BadRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  await createSession(outcome.userId, "PATIENT");

  if (outcome.status === "LINKED_NEW") return NextResponse.json({ ok: true, status: outcome.status, patientId: outcome.patientId });
  if (outcome.status === "VERIFICATION_REQUIRED") {
    return NextResponse.json({
      ok: true, status: outcome.status, maskedPhone: outcome.maskedPhone, next: outcome.next,
      message: `It looks like you already have a record with us. Confirm your date of birth or the UHID on your hospital card, and we'll send a code to ${outcome.maskedPhone} to connect it to your account.`,
    });
  }
  if (outcome.status === "IN_PERSON_REQUIRED") {
    return NextResponse.json({
      ok: true, status: outcome.status,
      message: "It looks like you may already have a record with us. To connect it, show a photo ID at the hospital's front desk.",
    });
  }
  return NextResponse.json({
    ok: true, status: outcome.status,
    message: "It looks like you may already have a record with us. The hospital will review it; you may be asked to show a photo ID at the front desk.",
  });
}
