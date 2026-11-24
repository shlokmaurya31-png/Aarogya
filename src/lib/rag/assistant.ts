import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { getAIProvider } from "@/lib/ai/getAIProvider";
import { issueAssistantPermit } from "@/lib/ai/assistantPermit";
import { realDataEnabled } from "@/lib/ai/dataPolicy";
import { mayUseAiOver } from "@/lib/ai/realData";
import { identifierSpans, personIdentifiers } from "@/lib/documents/identifiers";
import { ownedPersonId } from "@/lib/person/access";
import { askAi, AskError, checkLimits, holdSlot, type AskResult, type Citation, type Outcome } from "./ask";
import { askKnowledge } from "./knowledgeAsk";
import { askOps, opsReadersFor } from "./opsAsk";
import { routeQuestion } from "./router";
import { roleHasPermission } from "@/lib/auth/permissions";
import { estimateTokens } from "./chunk";
import { logAssistantInteraction, logRateLimited } from "./interactions";
import { ADVISORY_LABEL } from "./modes";
import { phrase } from "./phrases";
import { patientSafety } from "./safety";

/**
 * RAG Phase 1 — the portal assistant's gateway (POST /api/chat). Until this
 * phase /api/chat built a record context itself and sent it to the provider
 * with no real-data switch, AI consent, permit, masking, citation or log.
 * Now there are two paths, and both pass the same checks as /api/ai/ask:
 *
 *   A record question   staff naming a patient: answered by the record
 *                       gateway (askAi, mode CHART_QA): the access resolver,
 *                       the real-data switch and the person's AI consent,
 *                       masked sources, validated citations, the interaction
 *                       log, the provider's data-policy flag.
 *   RAG Phase 5 (5.7)   staff asking, with no patient, about the hospital's
 *                       documents or its live state: the knowledge gateway
 *                       (askKnowledge) or the operational one (askOps),
 *                       under their own permissions, as if asked there.
 *   Everything else     a record-free reply. The assistant is given NO
 *                       record (a patient has no free-form mode over their
 *                       record, docs/RAG_DESIGN.md §14: Explain, the timeline
 *                       and pre-visit questions are theirs). Still: rate
 *                       limits on the interaction log; the real-data switch
 *                       and the person's AI consent (the same refusals as
 *                       askAi); the patient safety rules before any model;
 *                       identifiers masked out of the message; a permit the
 *                       provider demands; the provider's data-policy flag;
 *                       an interaction logged (metadata only, never text).
 */
export type ChatActor =
  | { kind: "STAFF"; userId: string; role: Role; facilityId: string }
  | { kind: "PATIENT"; userId: string }
  /** Scholar and every other signed-in role: no hospital or person data at all. */
  | { kind: "OTHER"; userId: string; role: Role };

export interface ChatResult { text: string; outcome: Outcome; label: string; interactionId: string; citations: Citation[] }

export const CHAT_LIMITS = { messageChars: 2000, recordQuestionChars: 1000, pageChars: 100 } as const;

function mask(text: string, ids: readonly string[]): string {
  let out = text;
  for (const s of identifierSpans(text, ids).sort((a, b) => b.start - a.start)) out = `${out.slice(0, s.start)}[redacted]${out.slice(s.end)}`;
  return out;
}

/** Staff asking about one patient: the record gateway, as CHART_QA. */
export async function chatAboutRecord(actor: Extract<ChatActor, { kind: "STAFF" }>, input: { patientId: string; message: string }): Promise<ChatResult> {
  if (input.message.length > CHAT_LIMITS.recordQuestionChars) throw new AskError(400, "QUESTION_TOO_LONG");
  const r = await askAi(actor, { mode: "CHART_QA", patientId: input.patientId, question: input.message }, { module: "CHAT" });
  const text = r.sentences.map((s) => (s.citations.length ? `${s.text} [${s.citations.join(", ")}]` : s.text)).join("\n");
  return { text: text || phrase("en", "noRecord"), outcome: r.outcome, label: r.meta.label, interactionId: r.meta.interactionId, citations: r.citations };
}

/**
 * RAG Phase 5, step 5.7 — a staff message with no patient: a question about the hospital's approved documents goes to
 * the knowledge gateway, one about its live state to the operational one, each only for a caller who may use it there;
 * anything else is the record-free reply. The same router decides as everywhere else (router.ts).
 */
export async function chatStaff(actor: Extract<ChatActor, { kind: "STAFF" }>, input: { message: string; page?: string }): Promise<ChatResult> {
  const plan = routeQuestion(input.message, "KNOWLEDGE_QA");
  const intent = plan.kind === "PLAN" ? plan.plan.intent : "AMBIGUOUS";
  const asResult = (r: AskResult): ChatResult => ({ text: r.sentences.map((x) => (x.citations.length ? `${x.text} [${x.citations.join(", ")}]` : x.text)).join("\n") || phrase("en", "noRecord"), outcome: r.outcome, label: r.meta.label, interactionId: r.meta.interactionId, citations: r.citations });
  if (intent === "OPERATIONAL" && opsReadersFor(input.message).length) return asResult(await askOps(actor, { question: input.message }, { module: "CHAT" }));
  if (intent === "KNOWLEDGE" && plan.kind === "PLAN" && plan.plan.confidence === "RULE" && roleHasPermission(actor.role, "ai:knowledge:ask")) {
    if (input.message.length > CHAT_LIMITS.recordQuestionChars) throw new AskError(400, "QUESTION_TOO_LONG");
    return asResult(await askKnowledge(actor, { question: input.message }, { module: "CHAT" }));
  }
  return chatGeneral(actor, input);
}

/** Whose data would this be, and may the AI be used at all? The same refusals as the record gateway (403 AI_<reason>). */
async function gate(actor: ChatActor): Promise<{ real: boolean; personId: string | null; organizationId: string | null; facilityId: string | null; language: string }> {
  if (actor.kind === "PATIENT") {
    const personId = await ownedPersonId(actor.userId);
    // An account with no Person can't have consented, and has no classification: treated as real data.
    if (!personId) {
      if (!realDataEnabled()) throw new AskError(403, "AI_REAL_DATA_DISABLED");
      throw new AskError(403, "AI_CONSENT_REQUIRED");
    }
    const g = await mayUseAiOver({ personId });
    if (!g.allowed) throw new AskError(403, `AI_${g.reason}`);
    const language = (await prisma.person.findUnique({ where: { id: personId }, select: { preferredLanguage: true } }))?.preferredLanguage ?? "en";
    return { real: g.real, personId, organizationId: null, facilityId: null, language };
  }
  if (actor.kind === "STAFF") {
    const fac = await prisma.facility.findUnique({ where: { id: actor.facilityId }, select: { organizationId: true, dataClassification: true } });
    if (!fac) throw new AskError(403, "NO_FACILITY");
    const enabled = await resolveEffectiveInternal({ key: "ai.enabled", organizationId: fac.organizationId, facilityId: actor.facilityId, fallbackRaw: "false" });
    if (enabled.value !== true) throw new AskError(403, "AI_NOT_ENABLED");
    const real = fac.dataClassification !== "SYNTHETIC";
    if (real && !realDataEnabled()) throw new AskError(403, "AI_REAL_DATA_DISABLED");
    return { real, personId: null, organizationId: fac.organizationId, facilityId: actor.facilityId, language: "en" };
  }
  return { real: false, personId: null, organizationId: null, facilityId: null, language: "en" };
}

/** The record-free assistant. */
export async function chatGeneral(actor: ChatActor, input: { message: string; page?: string }): Promise<ChatResult> {
  const started = Date.now();
  const limitActor = actor.kind === "STAFF" ? actor : { kind: "PATIENT" as const, userId: actor.userId };
  try {
    await checkLimits(limitActor);
  } catch (err) {
    if (err instanceof AskError && err.status === 429) await logRateLimited(limitActor, "ASSISTANT");
    throw err;
  }
  const release = holdSlot(actor.userId);
  try {
    const g = await gate(actor);
    const id = randomUUID();
    const role = actor.kind === "PATIENT" ? "PATIENT" : actor.role;
    const log = (outcome: "ANSWERED" | "REFUSED_SAFETY" | "ERROR", model: string, inputTokens: number, outputTokens: number) =>
      logAssistantInteraction({ id, userId: actor.userId, role, organizationId: g.organizationId, facilityId: g.facilityId, personId: g.personId, language: g.language, outcome, model, inputTokens, outputTokens, started });
    const done = (text: string, outcome: Outcome): ChatResult => ({ text, outcome, label: ADVISORY_LABEL, interactionId: id, citations: [] });

    // Patient safety rules before any model: an urgent symptom gets the emergency line and nothing else.
    if (actor.kind === "PATIENT") {
      const v = patientSafety(input.message);
      if (v !== "OK") {
        await log("REFUSED_SAFETY", "none", 0, 0);
        return done(phrase(g.language, v === "URGENT" ? "emergency" : "askCareTeam"), "REFUSED_SAFETY");
      }
    }
    // Minimum necessary: the caller's own identifiers, and anything ABHA- or mobile-shaped, never reach a provider.
    const message = mask(input.message, g.personId ? await personIdentifiers(g.personId) : []);
    const provider = getAIProvider();
    let text: string;
    try {
      text = await provider.assistantReply({ audience: actor.kind === "PATIENT" ? "patient" : "clinician", page: input.page, message }, issueAssistantPermit(g.real));
    } catch {
      // A provider failure, or its data-policy flag: never another provider, never the mock.
      await log("ERROR", provider.id, 0, 0);
      throw new AskError(503, "PROVIDER_UNAVAILABLE");
    }
    await log("ANSWERED", provider.id, estimateTokens(message), estimateTokens(text));
    return done(text, "ANSWERED");
  } finally {
    release();
  }
}
