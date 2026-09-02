/**
 * Pure state-machine transition function. Given the full case (answer key
 * included, server-only), the current revealed state, and one action, it
 * returns the next revealed state plus whatever the action newly unlocked.
 * API routes are a thin wrapper: load from Prisma, call this, persist the
 * result. This function never talks to the network or the database, which
 * is what makes it unit-testable (see src/lib/caseEngine/__tests__).
 */
import { CASE_STAGE_ORDER } from "@/types/clinicalCase";
import type { CaseContent, CaseStage } from "@/types/clinicalCase";
import type { RevealedState, CaseActionInput } from "./types";

export interface EngineResult {
  revealed: RevealedState;
  stage: CaseStage;
  reveal?: { kind: "history" | "exam" | "investigation"; id: string | string[] };
  error?: string;
}

export function nextStage(current: CaseStage): CaseStage {
  const idx = CASE_STAGE_ORDER.indexOf(current);
  return CASE_STAGE_ORDER[Math.min(idx + 1, CASE_STAGE_ORDER.length - 1)];
}

export function applyAction(
  content: CaseContent,
  revealed: RevealedState,
  stage: CaseStage,
  action: CaseActionInput
): EngineResult {
  switch (action.type) {
    case "ask-history": {
      const node = content.historyTree.find((n) => n.id === action.historyNodeId);
      if (!node) return { revealed, stage, error: "Unknown history question." };
      if (revealed.revealedHistoryIds.includes(node.id)) return { revealed, stage };
      return {
        revealed: { ...revealed, revealedHistoryIds: [...revealed.revealedHistoryIds, node.id] },
        stage,
        reveal: { kind: "history", id: node.id },
      };
    }

    case "select-exam": {
      const findings = content.examFindings.filter((f) => f.system === action.system && !revealed.revealedExamIds.includes(f.id));
      if (findings.length === 0) return { revealed, stage };
      const ids = findings.map((f) => f.id);
      return {
        revealed: { ...revealed, revealedExamIds: [...revealed.revealedExamIds, ...ids] },
        stage,
        reveal: { kind: "exam", id: ids },
      };
    }

    case "order-investigation": {
      const inv = content.investigations.find((i) => i.id === action.investigationId);
      if (!inv) return { revealed, stage, error: "Unknown investigation." };
      if (revealed.orderedInvestigationIds.includes(inv.id)) return { revealed, stage };
      return {
        revealed: { ...revealed, orderedInvestigationIds: [...revealed.orderedInvestigationIds, inv.id] },
        stage,
        reveal: { kind: "investigation", id: inv.id },
      };
    }

    case "advance-stage":
      return { revealed, stage: action.to };

    case "hint":
    case "submit-differential":
    case "submit-diagnosis":
    case "submit-management":
    case "submit-prescription":
    case "submit-case":
      // These mutate attempt-level fields directly (handled by the route),
      // not the revealed-facts state — the engine still owns stage progression.
      return { revealed, stage: nextStage(stage) };

    default:
      return { revealed, stage, error: "Unknown action." };
  }
}
