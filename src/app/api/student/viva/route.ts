import { NextRequest } from "next/server";
import { requireVerifiedStudent } from "@/lib/auth/currentStudent";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { getActiveCaseProvider } from "@/lib/clinical/gateway";
import { getAIProvider } from "@/lib/ai/getAIProvider";

interface TranscriptEntry {
  prompt: string;
  studentAnswer: string;
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    await requireVerifiedStudent("student:ai:tutor");
    const body = await req.json().catch(() => null);
    const caseId = body?.caseId as string | undefined;
    const type = body?.type === "feedback" ? "feedback" : "next";
    const transcript = (body?.transcript ?? []) as TranscriptEntry[];
    if (!caseId) throw new BadRequestError("caseId is required.");

    const provider = getActiveCaseProvider();
    const full = await provider.getCaseFull(caseId);
    if (!full) throw new NotFoundError("Case not found.");

    const ai = getAIProvider();

    if (type === "feedback") {
      const feedback = await ai.tutorFeedback({
        mode: "DEBRIEF",
        caseTitle: full.title,
        scoreSummary: `Viva covered ${transcript.length} question(s) on ${full.title}.`,
      });
      return { feedback };
    }

    // Bank-first: deterministic case-authored viva questions before any AI-adaptive follow-up.
    if (transcript.length < full.viva.length) {
      const next = full.viva[transcript.length];
      return { question: { id: next.id, prompt: next.prompt, stage: next.stage }, isFromBank: true, complete: false };
    }

    if (transcript.length >= full.viva.length + 3) {
      return { question: null, isFromBank: false, complete: true };
    }

    const performanceHint: "strong" | "average" | "struggling" =
      transcript.length > 0 && transcript[transcript.length - 1]?.studentAnswer.length > 40 ? "strong" : "average";

    const prompt = await ai.vivaExaminer({
      stage: "case",
      caseTitle: full.title,
      priorQuestions: transcript,
      performanceHint,
    });

    return { question: { id: `ai-${transcript.length}`, prompt, stage: "case" }, isFromBank: false, complete: false };
  });
}
