import type { AssistantPermit } from "./provider";

/**
 * RAG Phase 1 — the portal assistant's permit. Issued only by the assistant
 * gateway (src/lib/rag/assistant.ts) once its checks passed (the real-data
 * switch, the person's AI consent, the safety rules, the masked message);
 * a provider rejects anything that merely looks like one. The same pattern
 * as the record-answer and document permits.
 */
const issued = new WeakSet<object>();

export function issueAssistantPermit(real: boolean): AssistantPermit {
  const p = Object.freeze({ real }) as unknown as AssistantPermit;
  issued.add(p);
  return p;
}

export function assertAssistantPermit(permit: AssistantPermit | undefined): asserts permit is AssistantPermit {
  if (!permit || !issued.has(permit)) throw new Error("The portal assistant was called without a permit.");
}
