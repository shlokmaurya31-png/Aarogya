import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * Real Role.PATIENT self-service account creation (brief §34 priority:
 * "patient identity -> patient retrieval..."). Deliberately narrow this
 * phase: registers into the single demo facility, links a new Patient row
 * via Patient.userId. Does NOT touch or migrate the original /dashboard
 * prototype — this is a new, additive, real vertical slice, same pattern
 * as Scholar/Hospital OS. See docs/CLINICAL_CORE.md §7.
 */
const RegisterSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  sex: z.string().min(1),
  phone: z.string().optional(),
  dob: z.string().optional(),
});

function generateUhid(facilityId: string) {
  const code = facilityId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `UHID-${code}-${rand}`;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid registration data.", issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (existing) {
    return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
  }

  const facility = await prisma.facility.findFirst({ orderBy: { createdAt: "asc" } });
  if (!facility) {
    return NextResponse.json({ error: "No facility is configured to register into yet." }, { status: 500 });
  }

  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: input.email.toLowerCase(), passwordHash, role: Role.PATIENT, displayName: input.fullName },
    });
    const patient = await tx.patient.create({
      data: {
        uhid: generateUhid(facility.id),
        facilityId: facility.id,
        fullName: input.fullName,
        sex: input.sex,
        phone: input.phone,
        dob: input.dob ? new Date(input.dob) : undefined,
        userId: user.id,
      },
    });
    return { user, patient };
  });

  await recordAuditEvent("patient.account.registered", result.user.id, { patientId: result.patient.id, facilityId: facility.id });
  await createSession(result.user.id, result.user.role);

  return NextResponse.json({ ok: true, patientId: result.patient.id });
}
