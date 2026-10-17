import { openCaseAttempt } from "@/lib/student/cases";
import { NextRequest } from "next/server";
import { AttemptMode } from "@prisma/client";
import { requireVerifiedStudent } from "@/lib/auth/currentStudent";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { getActiveCaseProvider } from "@/lib/clinical/gateway";
import { toPublicView } from "@/lib/caseEngine/publicView";
import { type RevealedState } from "@/lib/caseEngine/types";
import { recordAuditEvent } from "@/lib/auth/audit";
import type { CaseStage as TsCaseStage } from "@/types/clinicalCase";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session, profile } = await requireVerifiedStudent("student:case:view");
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const restart = searchParams.get("restart") === "true";
    const mode = searchParams.get("mode") === "exam" ? AttemptMode.EXAM : AttemptMode.PRACTICE;

    const provider = getActiveCaseProvider();
    const full = await provider.getCaseFull(id);
    if (!full) throw new NotFoundError("Case not found.");

    const { attempt, created } = await openCaseAttempt({ caseId: id, studentId: session.userId, mode: mode === AttemptMode.EXAM ? "EXAM" : "PRACTICE", restart });
    if (created) await recordAuditEvent("student.case.opened", session.userId, { caseId: id, attemptId: attempt.id });

    const revealed = attempt.revealedState as unknown as RevealedState;
    const view = toPublicView(full, revealed, attempt.stage as unknown as TsCaseStage, attempt.hintsUsed);

    return {
      attemptId: attempt.id,
      mode: attempt.mode,
      view,
      studentTrack: profile.learningTrack,
    };
  });
}
