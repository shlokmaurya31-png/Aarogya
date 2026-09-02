import { prisma } from "@/lib/db";
import type { CaseScoreBreakdown } from "./engine";
import type { ClinicalCaseSummary } from "@/types/clinicalCase";

/**
 * Achievement-granting logic evaluated after each case submission. Covers a
 * meaningful subset of the achievement catalog seeded in prisma/seed.ts;
 * HUNDRED_CASES and ECG_APPRENTICE are cataloged but not yet auto-granted in
 * this pass (see docs/STUDENT_PLATFORM_ARCHITECTURE.md §4 "deferred").
 */
export async function grantEarnedAchievements(
  userId: string,
  caseSummary: ClinicalCaseSummary,
  breakdown: CaseScoreBreakdown
) {
  const earned: string[] = [];

  async function grant(code: string) {
    const achievement = await prisma.achievement.findUnique({ where: { code } });
    if (!achievement) return;
    const already = await prisma.studentAchievement.findUnique({
      where: { userId_achievementId: { userId, achievementId: achievement.id } },
    });
    if (already) return;
    await prisma.studentAchievement.create({ data: { userId, achievementId: achievement.id } });
    earned.push(code);
  }

  const submittedCount = await prisma.caseAttempt.count({ where: { studentId: userId, submittedAt: { not: null } } });
  if (submittedCount === 1) await grant("FIRST_DIAGNOSIS");

  if (caseSummary.acuity === "EMERGENCY" && breakdown.passed) {
    const passedEmergencyCount = await prisma.caseAttempt.count({
      where: { studentId: userId, submittedAt: { not: null }, case: { acuity: "EMERGENCY" } },
    });
    if (passedEmergencyCount >= 3) await grant("EMERGENCY_READY");
  }

  if (caseSummary.specialty === "Cardiology") {
    const cardioCount = await prisma.caseAttempt.count({
      where: { studentId: userId, submittedAt: { not: null }, case: { specialty: "Cardiology" } },
    });
    if (cardioCount >= 5) await grant("CARDIOLOGY_EXPLORER");
  }

  const diffDim = breakdown.dimensions.find((d) => d.key === "differential");
  if (diffDim && diffDim.maxEarnable > 0 && diffDim.earned >= diffDim.maxEarnable * 0.95) {
    const fullMatchCount = await prisma.caseAction.count({
      where: { attempt: { studentId: userId }, type: "submit-differential" },
    });
    if (fullMatchCount >= 5) await grant("DIAGNOSTIC_DETECTIVE");
  }

  const rxDim = breakdown.dimensions.find((d) => d.key === "prescription");
  if (rxDim && breakdown.unsafeActionsChosen.length === 0 && rxDim.maxEarnable > 0 && rxDim.earned >= rxDim.maxEarnable * 0.9) {
    const safeRxCount = await prisma.caseAction.count({
      where: { attempt: { studentId: userId }, type: "submit-prescription" },
    });
    if (safeRxCount >= 10) await grant("SAFE_PRESCRIBER");
  }

  const profile = await prisma.studentProfile.findUnique({ where: { userId } });
  if (profile && profile.streakDays >= 7) await grant("SEVEN_DAY_STREAK");

  return earned;
}
