import { NextRequest } from "next/server";
import { VerificationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission, withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function GET() {
  return withApiErrors(async () => {
    await requirePermission("admin:verification:manage");
    const profiles = await prisma.studentProfile.findMany({
      include: { user: true, institution: true },
      orderBy: { createdAt: "desc" },
    });
    return {
      applications: profiles.map((p) => ({
        id: p.id,
        userId: p.userId,
        name: p.fullLegalName,
        email: p.user.email,
        institution: p.institution?.name ?? p.institutionNameFreeText,
        course: p.course,
        academicYear: p.academicYear,
        verificationMethod: p.verificationMethod,
        status: p.verificationStatus,
        submittedAt: p.createdAt,
      })),
    };
  });
}

export async function PATCH(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requirePermission("admin:verification:manage");
    const body = await req.json().catch(() => null);
    const id = body?.id as string | undefined;
    const action = body?.action as "approve" | "reject" | undefined;
    if (!id || !action) throw new BadRequestError("id and action are required.");

    const status = action === "approve" ? VerificationStatus.VERIFIED : VerificationStatus.REJECTED;
    const profile = await prisma.studentProfile.update({
      where: { id },
      data: { verificationStatus: status, verifiedAt: status === VerificationStatus.VERIFIED ? new Date() : null },
    });

    await recordAuditEvent(
      status === VerificationStatus.VERIFIED ? "student.verification.approved" : "student.verification.rejected",
      session.userId,
      { studentProfileId: id }
    );
    await recordAuditEvent("admin.verification.reviewed", session.userId, { studentProfileId: id, action });

    return { status: profile.verificationStatus };
  });
}
