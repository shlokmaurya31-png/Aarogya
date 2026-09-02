import { prisma } from "@/lib/db";
import { requireVerifiedStudent } from "@/lib/auth/currentStudent";
import { withApiErrors } from "@/lib/auth/rbac";
import { getActiveCaseProvider } from "@/lib/clinical/gateway";

export async function GET() {
  return withApiErrors(async () => {
    const { session, profile } = await requireVerifiedStudent("student:progress:view");
    const provider = getActiveCaseProvider();
    const allCases = await provider.listCases();

    const continueAttempt = await prisma.caseAttempt.findFirst({
      where: { studentId: session.userId, submittedAt: null },
      orderBy: { startedAt: "desc" },
      include: { case: true },
    });

    const recentAttempts = await prisma.caseAttempt.findMany({
      where: { studentId: session.userId, submittedAt: { not: null } },
      orderBy: { submittedAt: "desc" },
      take: 5,
      include: { case: true },
    });

    const competencies = await prisma.studentCompetency.findMany({ where: { userId: session.userId } });
    const achievements = await prisma.studentAchievement.findMany({
      where: { userId: session.userId },
      include: { achievement: true },
      orderBy: { earnedAt: "desc" },
    });

    // Rule-based recommendations: weakest competency domain -> map back to a specialty guess, else fall back to unattempted cases in the student's interests.
    const weakest = [...competencies].sort((a, b) => a.score - b.score)[0];
    const attemptedCaseIds = new Set(
      (await prisma.caseAttempt.findMany({ where: { studentId: session.userId }, select: { caseId: true } })).map(
        (a) => a.caseId
      )
    );
    const interests = JSON.parse(profile.clinicalInterests || "[]") as string[];
    const unattempted = allCases.filter((c) => !attemptedCaseIds.has(c.id));
    const recommended = [
      ...unattempted.filter((c) => interests.includes(c.specialty)),
      ...unattempted.filter((c) => !interests.includes(c.specialty)),
    ].slice(0, 3);

    // Case of the day: deterministic per calendar day so it's stable across refreshes.
    const dayIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
    const caseOfTheDay = allCases.length ? allCases[dayIndex % allCases.length] : null;

    const emergencyChallenge = allCases.find((c) => c.acuity === "EMERGENCY" && !attemptedCaseIds.has(c.id)) ?? null;

    return {
      profile: {
        fullLegalName: profile.fullLegalName,
        preferredName: profile.preferredName,
        course: profile.course,
        learningTrack: profile.learningTrack,
        academicYear: profile.academicYear,
        currentRotation: profile.currentRotation,
        verificationStatus: profile.verificationStatus,
        streakDays: profile.streakDays,
        clinicalXp: profile.clinicalXp,
      },
      continueCase: continueAttempt
        ? { attemptId: continueAttempt.id, caseId: continueAttempt.caseId, title: continueAttempt.case.title, stage: continueAttempt.stage }
        : null,
      caseOfTheDay,
      emergencyChallenge,
      recentAttempts: recentAttempts.map((a) => ({
        caseId: a.caseId,
        title: a.case.title,
        specialty: a.case.specialty,
        submittedAt: a.submittedAt,
        score: (a.score as unknown as { total: number; passed: boolean } | null)?.total ?? null,
        passed: (a.score as unknown as { total: number; passed: boolean } | null)?.passed ?? null,
      })),
      competencies: competencies.map((c) => ({ domain: c.domain, score: Math.round(c.score), attempts: c.attempts })),
      weakestDomain: weakest?.domain ?? null,
      achievements: achievements.map((a) => ({
        code: a.achievement.code,
        title: a.achievement.title,
        description: a.achievement.description,
        icon: a.achievement.icon,
        earnedAt: a.earnedAt,
      })),
      recommended,
      totalCasesAvailable: allCases.length,
      totalCasesCompleted: recentAttempts.length > 0 ? await prisma.caseAttempt.count({ where: { studentId: session.userId, submittedAt: { not: null } } }) : 0,
    };
  });
}
