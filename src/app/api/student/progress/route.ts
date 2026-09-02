import { prisma } from "@/lib/db";
import { requireVerifiedStudent } from "@/lib/auth/currentStudent";
import { withApiErrors } from "@/lib/auth/rbac";

export async function GET() {
  return withApiErrors(async () => {
    const { session } = await requireVerifiedStudent("student:progress:view");

    const competencies = await prisma.studentCompetency.findMany({ where: { userId: session.userId } });
    const attempts = await prisma.caseAttempt.findMany({
      where: { studentId: session.userId, submittedAt: { not: null } },
      orderBy: { submittedAt: "asc" },
      include: { case: true },
    });

    type Breakdown = { total: number; passed: boolean; dimensions: { key: string; earned: number; maxEarnable: number }[] };
    const scored = attempts.map((a) => ({ attempt: a, breakdown: a.score as unknown as Breakdown }));

    const bySpecialty = new Map<string, { total: number; count: number }>();
    for (const { attempt, breakdown } of scored) {
      const acc = bySpecialty.get(attempt.case.specialty) ?? { total: 0, count: 0 };
      acc.total += breakdown?.total ?? 0;
      acc.count += 1;
      bySpecialty.set(attempt.case.specialty, acc);
    }

    const byDifficulty = new Map<string, { total: number; count: number }>();
    for (const { attempt, breakdown } of scored) {
      const acc = byDifficulty.get(attempt.case.difficulty) ?? { total: 0, count: 0 };
      acc.total += breakdown?.total ?? 0;
      acc.count += 1;
      byDifficulty.set(attempt.case.difficulty, acc);
    }

    const safetyScores = scored
      .map(({ breakdown }) => breakdown?.dimensions?.find((d) => d.key === "safety"))
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map((d) => (d.maxEarnable > 0 ? (d.earned / d.maxEarnable) * 100 : 100));
    const averageSafety = safetyScores.length ? Math.round(safetyScores.reduce((s, v) => s + v, 0) / safetyScores.length) : null;

    const prescriptionScores = scored
      .map(({ breakdown }) => breakdown?.dimensions?.find((d) => d.key === "prescription"))
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map((d) => (d.maxEarnable > 0 ? (d.earned / d.maxEarnable) * 100 : 100));
    const averagePrescription = prescriptionScores.length
      ? Math.round(prescriptionScores.reduce((s, v) => s + v, 0) / prescriptionScores.length)
      : null;

    const weeklyTrend = scored.slice(-10).map(({ attempt, breakdown }) => ({
      date: attempt.submittedAt!.toISOString().slice(0, 10),
      score: breakdown?.total ?? 0,
      title: attempt.case.title,
    }));

    const sortedCompetencies = [...competencies].sort((a, b) => b.score - a.score);
    const strongest = sortedCompetencies[0];
    const weakest = sortedCompetencies[sortedCompetencies.length - 1];

    return {
      competencyRadar: competencies.map((c) => ({ domain: c.domain, score: Math.round(c.score) })),
      specialtyPerformance: [...bySpecialty.entries()].map(([specialty, v]) => ({
        specialty,
        averageScore: Math.round(v.total / v.count),
        count: v.count,
      })),
      difficultyPerformance: [...byDifficulty.entries()].map(([difficulty, v]) => ({
        difficulty,
        averageScore: Math.round(v.total / v.count),
        count: v.count,
      })),
      averageSafetyScore: averageSafety,
      averagePrescriptionScore: averagePrescription,
      weeklyTrend,
      totalCompleted: attempts.length,
      strongestDomain: strongest ? { domain: strongest.domain, score: Math.round(strongest.score) } : null,
      weakestDomain: weakest ? { domain: weakest.domain, score: Math.round(weakest.score) } : null,
    };
  });
}
