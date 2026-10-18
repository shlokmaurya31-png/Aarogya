import type { AiPermit } from "./types";

/**
 * Week 4b — an answer provider is called only with a permit, issued only by
 * the real-data gate (src/lib/ai/realData.ts aiAssistancePermit) once the
 * switch, the data classification and the person's AI consent allow it. The
 * set of issued permits lets a provider reject an object that merely looks
 * like one (the same pattern as the document pipeline's ProcessingPermit).
 */
const issued = new WeakSet<object>();

export function issueAiPermit(subject: string, real: boolean): AiPermit {
  const p = Object.freeze({ subject, purpose: "AI_ASSISTANCE" as const, real }) as unknown as AiPermit;
  issued.add(p);
  return p;
}

export function assertAiPermit(permit: AiPermit | undefined): asserts permit is AiPermit {
  if (!permit || !issued.has(permit)) throw new Error("An answer provider was called without an AI permit.");
}
