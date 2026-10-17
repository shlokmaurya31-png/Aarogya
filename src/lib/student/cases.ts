import { AttemptMode, CaseStage, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { emptyRevealedState } from "@/lib/caseEngine/types";

/**
 * Scholar case attempts (batch 7, item 5; previously written by the routes).
 * The learning product, outside the hospital workflow spine: audited, no
 * domain events (SCHOLAR in emitExemptions.ts).
 */

/** The student's open attempt at a case, or a new one (restart: always new). */
export async function openCaseAttempt(input: { caseId: string; studentId: string; mode: "EXAM" | "PRACTICE"; restart: boolean }) {
  const open = input.restart ? null : await prisma.caseAttempt.findFirst({ where: { caseId: input.caseId, studentId: input.studentId, submittedAt: null }, orderBy: { startedAt: "desc" } });
  if (open) return { attempt: open, created: false };
  const attempt = await prisma.caseAttempt.create({
    data: { caseId: input.caseId, studentId: input.studentId, mode: input.mode === "EXAM" ? AttemptMode.EXAM : AttemptMode.PRACTICE, stage: CaseStage.TRIAGE, revealedState: emptyRevealedState() as object },
  });
  return { attempt, created: true };
}

/** The student's own unsubmitted attempt at this case. */
export async function ownOpenAttempt(attemptId: string, caseId: string, studentId: string) {
  const attempt = await prisma.caseAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.caseId !== caseId || attempt.studentId !== studentId) throw new NotFoundError("Attempt not found.");
  if (attempt.submittedAt) throw new BadRequestError("This attempt has already been submitted.");
  return attempt;
}

/**
 * Records one action, guarded on the attempt still being unsubmitted (batch 7:
 * an action could land after submission). The attempt update and the action
 * row commit together.
 */
export async function recordCaseAction(input: { attemptId: string; data: Prisma.CaseAttemptUpdateManyMutationInput; action: { stage: CaseStage; type: string; payload: object } }) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.caseAttempt.updateMany({ where: { id: input.attemptId, submittedAt: null }, data: input.data });
    if (r.count !== 1) throw new BadRequestError("This attempt has already been submitted.");
    await tx.caseAction.create({ data: { attemptId: input.attemptId, stage: input.action.stage, type: input.action.type, payload: input.action.payload } });
    return tx.caseAttempt.findUniqueOrThrow({ where: { id: input.attemptId } });
  });
}

/**
 * Submits an attempt with its score, exactly once (batch 7: two concurrent
 * submits both scored and both added XP). The XP and streak update is atomic.
 */
export async function submitCaseAttempt(input: { attemptId: string; studentId: string; score: object; xpGain: number; consecutiveDay: boolean }) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const r = await tx.caseAttempt.updateMany({ where: { id: input.attemptId, submittedAt: null }, data: { stage: CaseStage.COMPLETE, submittedAt: now, score: input.score } });
    if (r.count !== 1) throw new BadRequestError("This attempt has already been submitted.");
    await tx.studentProfile.update({
      where: { userId: input.studentId },
      data: { clinicalXp: { increment: input.xpGain }, streakDays: input.consecutiveDay ? { increment: 1 } : 1, lastActiveAt: now },
    });
    return tx.caseAttempt.findUniqueOrThrow({ where: { id: input.attemptId } });
  });
}

/** An educator's draft case (never published here). */
export async function createClinicalCaseDraft(data: Prisma.ClinicalCaseUncheckedCreateInput) {
  return prisma.clinicalCase.create({ data: { ...data, isPublished: false } });
}
