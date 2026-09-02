import { NextRequest } from "next/server";
import { CaseStage } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireVerifiedStudent } from "@/lib/auth/currentStudent";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { getActiveCaseProvider } from "@/lib/clinical/gateway";
import { applyAction, nextStage } from "@/lib/caseEngine/engine";
import { toPublicView } from "@/lib/caseEngine/publicView";
import type { RevealedState, CaseActionInput } from "@/lib/caseEngine/types";
import type { CaseStage as TsCaseStage } from "@/types/clinicalCase";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session } = await requireVerifiedStudent("student:case:attempt");
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const attemptId = body?.attemptId as string | undefined;
    const action = body?.action as CaseActionInput | undefined;
    if (!attemptId || !action) throw new BadRequestError("attemptId and action are required.");

    const attempt = await prisma.caseAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.caseId !== id || attempt.studentId !== session.userId) {
      throw new NotFoundError("Attempt not found.");
    }
    if (attempt.submittedAt) throw new BadRequestError("This attempt has already been submitted.");

    const provider = getActiveCaseProvider();
    const full = await provider.getCaseFull(id);
    if (!full) throw new NotFoundError("Case not found.");

    const revealed = attempt.revealedState as unknown as RevealedState;
    const currentStage = attempt.stage as unknown as TsCaseStage;

    const result = applyAction(full.content, revealed, currentStage, action);

    const updateData: Record<string, unknown> = {
      revealedState: result.revealed as object,
      stage: result.stage,
    };

    switch (action.type) {
      case "submit-differential":
        updateData.differential = action.entries as object;
        break;
      case "submit-diagnosis":
        updateData.diagnosis = action.diagnosis;
        break;
      case "submit-management":
        updateData.managementPlan = { selectedStepIds: action.selectedStepIds } as object;
        break;
      case "submit-prescription":
        updateData.prescriptions = action.drugs as object;
        break;
      case "hint":
        updateData.hintsUsed = attempt.hintsUsed + 1;
        updateData.stage = currentStage; // hints don't advance stage
        break;
      case "advance-stage":
        updateData.stage = action.to as unknown as CaseStage;
        break;
      default:
        break;
    }

    const updated = await prisma.caseAttempt.update({ where: { id: attempt.id }, data: updateData });

    await prisma.caseAction.create({
      data: { attemptId: attempt.id, stage: currentStage as unknown as CaseStage, type: action.type, payload: action as object },
    });
    await recordAuditEvent("student.case.action", session.userId, { caseId: id, attemptId: attempt.id, type: action.type });

    const newRevealed = updated.revealedState as unknown as RevealedState;
    const view = toPublicView(full, newRevealed, updated.stage as unknown as TsCaseStage, updated.hintsUsed);

    return { view, reveal: result.reveal ?? null, error: result.error ?? null, nextStagePreview: nextStage(updated.stage as unknown as TsCaseStage) };
  });
}
