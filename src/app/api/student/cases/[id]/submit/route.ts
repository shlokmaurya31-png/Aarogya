import { NextRequest } from "next/server";
import { CaseStage } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireVerifiedStudent } from "@/lib/auth/currentStudent";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { getActiveCaseProvider } from "@/lib/clinical/gateway";
import { scoreCaseAttempt } from "@/lib/scoring/engine";
import { toDebriefView } from "@/lib/caseEngine/publicView";
import { updateCompetencies } from "@/lib/scoring/competencies";
import { grantEarnedAchievements } from "@/lib/scoring/achievements";
import { recordAuditEvent } from "@/lib/auth/audit";
import type { RevealedState, DifferentialEntry, PrescriptionEntry } from "@/lib/caseEngine/types";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session, profile } = await requireVerifiedStudent("student:case:submit");
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const attemptId = body?.attemptId as string | undefined;
    if (!attemptId) throw new BadRequestError("attemptId is required.");

    const attempt = await prisma.caseAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.caseId !== id || attempt.studentId !== session.userId) {
      throw new NotFoundError("Attempt not found.");
    }
    if (attempt.submittedAt) throw new BadRequestError("This attempt has already been submitted.");

    const provider = getActiveCaseProvider();
    const full = await provider.getCaseFull(id);
    if (!full) throw new NotFoundError("Case not found.");

    const revealed = attempt.revealedState as unknown as RevealedState;
    const breakdown = scoreCaseAttempt({
      content: full.content,
      rubric: full.rubric,
      referenceDx: full.referenceDx,
      revealed,
      differential: (attempt.differential as unknown as DifferentialEntry[] | null) ?? null,
      diagnosis: attempt.diagnosis,
      managementSelectedStepIds:
        (attempt.managementPlan as unknown as { selectedStepIds: string[] } | null)?.selectedStepIds ?? null,
      prescriptions: (attempt.prescriptions as unknown as PrescriptionEntry[] | null) ?? null,
      hintsUsed: attempt.hintsUsed,
    });

    const updated = await prisma.caseAttempt.update({
      where: { id: attempt.id },
      data: { stage: CaseStage.COMPLETE, submittedAt: new Date(), score: breakdown as unknown as object },
    });

    await updateCompetencies(session.userId, breakdown);
    const newAchievements = await grantEarnedAchievements(session.userId, full, breakdown);

    const xpGain = Math.round(breakdown.total * 4);
    const now = new Date();
    const lastActive = profile.lastActiveAt;
    const isConsecutiveDay = lastActive ? now.getTime() - lastActive.getTime() < 1000 * 60 * 60 * 48 : false;
    await prisma.studentProfile.update({
      where: { userId: session.userId },
      data: {
        clinicalXp: profile.clinicalXp + xpGain,
        streakDays: isConsecutiveDay ? profile.streakDays + 1 : 1,
        lastActiveAt: now,
      },
    });

    await recordAuditEvent("student.case.submitted", session.userId, {
      caseId: id,
      attemptId: attempt.id,
      score: breakdown.total,
      passed: breakdown.passed,
    });

    return {
      attemptId: updated.id,
      score: breakdown,
      debrief: toDebriefView(full),
      newAchievements,
      xpGain,
    };
  });
}
