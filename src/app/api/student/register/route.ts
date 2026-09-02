import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Course, LearningTrack, VerificationMethod, VerificationStatus, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { decideInitialVerificationStatus } from "@/lib/verification/decide";
import { getVerificationProvider } from "@/lib/verification/provider";
import { recordAuditEvent } from "@/lib/auth/audit";

const RegisterSchema = z.object({
  fullLegalName: z.string().min(2),
  preferredName: z.string().optional(),
  email: z.string().email(),
  password: z.string().min(8),
  institutionName: z.string().min(2),
  course: z.nativeEnum(Course),
  learningTrack: z.nativeEnum(LearningTrack),
  academicYear: z.coerce.number().int().min(1).max(7),
  enrollmentYear: z.coerce.number().int().min(2015).max(2030),
  expectedGraduation: z.coerce.number().int().min(2020).max(2035),
  studentIdentifier: z.string().optional(),
  institutionEmail: z.string().email().optional().or(z.literal("")),
  clinicalInterests: z.string().optional(), // comma-separated
  verificationMethod: z.nativeEnum(VerificationMethod),
});

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const raw = Object.fromEntries(form.entries());
  const parsed = RegisterSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid registration data.", issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (existing) {
    return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
  }

  const passwordHash = await hashPassword(input.password);
  const status = await decideInitialVerificationStatus(input.verificationMethod, input.institutionEmail || undefined);

  const user = await prisma.user.create({
    data: {
      email: input.email.toLowerCase(),
      passwordHash,
      role: Role.STUDENT,
      displayName: input.preferredName || input.fullLegalName,
    },
  });

  const studentProfile = await prisma.studentProfile.create({
    data: {
      userId: user.id,
      fullLegalName: input.fullLegalName,
      preferredName: input.preferredName,
      institutionNameFreeText: input.institutionName,
      course: input.course,
      learningTrack: input.learningTrack,
      academicYear: input.academicYear,
      enrollmentYear: input.enrollmentYear,
      expectedGraduation: input.expectedGraduation,
      studentIdentifier: input.studentIdentifier,
      institutionEmail: input.institutionEmail || undefined,
      clinicalInterests: JSON.stringify(
        (input.clinicalInterests || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      ),
      verificationStatus: status,
      verificationMethod: input.verificationMethod,
      verifiedAt: status === VerificationStatus.VERIFIED ? new Date() : undefined,
    },
  });

  // Optional document upload for METHOD B/C — stored via the restricted VerificationProvider, never inline in the DB.
  const file = form.get("document");
  if (file instanceof File && file.size > 0) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const provider = getVerificationProvider();
    const stored = await provider.store(studentProfile.id, input.verificationMethod, bytes, file.name);
    await prisma.verificationDocument.create({
      data: { studentProfileId: studentProfile.id, kind: input.verificationMethod, storageRef: stored.storageRef, sha256: stored.sha256 },
    });
    await prisma.studentProfile.update({ where: { id: studentProfile.id }, data: { verificationStatus: VerificationStatus.UNDER_REVIEW } });
  }

  await recordAuditEvent("student.verification.submitted", user.id, { method: input.verificationMethod, status });
  await createSession(user.id, user.role);

  return NextResponse.json({ ok: true, verificationStatus: status });
}
