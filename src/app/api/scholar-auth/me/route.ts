import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ user: null });

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { studentProfile: { include: { institution: true } } },
  });
  if (!user) return NextResponse.json({ user: null });

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.displayName,
      studentProfile: user.studentProfile
        ? {
            fullLegalName: user.studentProfile.fullLegalName,
            preferredName: user.studentProfile.preferredName,
            institutionName: user.studentProfile.institution?.name ?? user.studentProfile.institutionNameFreeText,
            course: user.studentProfile.course,
            learningTrack: user.studentProfile.learningTrack,
            academicYear: user.studentProfile.academicYear,
            currentRotation: user.studentProfile.currentRotation,
            verificationStatus: user.studentProfile.verificationStatus,
            streakDays: user.studentProfile.streakDays,
            clinicalXp: user.studentProfile.clinicalXp,
            clinicalInterests: JSON.parse(user.studentProfile.clinicalInterests || "[]"),
          }
        : null,
    },
  });
}
