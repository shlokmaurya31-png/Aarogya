import { capabilitiesOf, MODEL_CAPABILITIES } from "@/lib/ai/modelCapabilities";
import { aiModel } from "@/lib/ai/models";
import { providerMayReceive } from "@/lib/ai/dataPolicy";
import { MODES, type AiMode } from "@/lib/rag/modes";
import { claudeRecordAnswer } from "./claude";
import { mockRecordAnswer } from "./mock";
import { overriddenRecordAnswerProvider, recordAiProviderKind } from "./index";
import { RecordAiUnavailableError, type AiPermit, type AnswerRequest, type RecordAnswer, type RecordAnswerProvider } from "./types";

/**
 * RAG Phase 5, steps 5.3 and 5.4 — the provider registry of the
 * record-answer family (docs/RAG_ARCHITECTURE.md §12): its providers, their
 * models and capabilities, their data policy; the route for one request by
 * tier, risk and policy; failover.
 *
 *   tiers     0  no model (templates, readers; ask.ts)
 *             1  a small model: short knowledge answers of low or clinical
 *                risk may use one (Haiku 5.5) when `ai.model.knowledge_qa`
 *                names it; the default stays Sonnet 5.5 (Tier 2) until a
 *                real-provider evaluation shows Haiku holds the quality
 *             2  a strong model: record synthesis, every chart question,
 *                every patient-facing mode, any high-risk question
 *                (Sonnet 5.5; Opus 5.5 its failover)
 *             A cheaper tier never lowers a safety requirement: the validator,
 *             labels and refusals are the same on every tier, and a
 *             patient-facing mode never routes below Tier 2.
 *   models    a mode's configured model (`ai.model.*`, models.ts) when it is
 *             an allowed model of at least the required tier; otherwise the
 *             tier's default. Anything outside the allow-list
 *             (modelCapabilities.ts) falls back to the default.
 *   policy    IN_PROCESS (the mock: synthetic data only, never real) and
 *             EXTERNAL (Anthropic: real data only with the switch and its own
 *             flag, AI_PHI_ALLOWED_ANTHROPIC; ADR 0005 part C). A request
 *             with a real permit is never routed to a provider whose flag is
 *             off: it is refused (503 DATA_POLICY) before any call, and each
 *             provider checks again inside.
 *   failover  only to another model of the same tier and the same or a
 *             stricter data policy, and only after an availability failure
 *             (unavailable, rate limited). A real provider's failure never
 *             falls back to the mock: the request is a 503.
 */
export type Tier = 1 | 2;
export type DataPolicy = "IN_PROCESS" | "EXTERNAL";
/** Higher is stricter: data that stays in the process is the strictest. */
const STRICTNESS: Record<DataPolicy, number> = { IN_PROCESS: 2, EXTERNAL: 1 };

export interface RegisteredProvider {
  id: "claude" | "mock";
  policy: DataPolicy;
  /** The flag that lets real data reach it (none for the mock, which never takes real data). */
  phiFlag: "ANTHROPIC" | null;
  models: { id: string; tier: Tier }[];
}

export const PROVIDERS: readonly RegisteredProvider[] = [
  { id: "claude", policy: "EXTERNAL", phiFlag: "ANTHROPIC", models: Object.entries(MODEL_CAPABILITIES).map(([id, c]) => ({ id, tier: c.tier })) },
  { id: "mock", policy: "IN_PROCESS", phiFlag: null, models: [{ id: "mock-record-1", tier: 2 }] },
];

/** The default model per tier, and the failover order within it. */
export const TIER_MODELS: Record<Tier, string[]> = { 1: ["claude-haiku-5-5"], 2: ["claude-sonnet-5-5", "claude-opus-5-5"] };

/** The lowest tier a request may use: patient-facing modes and high-risk questions Tier 2; short knowledge answers Tier 1. */
export function requiredTier(mode: AiMode, risk?: "LOW" | "CLINICAL" | "HIGH_RISK"): Tier {
  if (MODES[mode].audience === "PATIENT") return 2;
  if (mode === "KNOWLEDGE_QA" && risk !== "HIGH_RISK") return 1;
  return 2;
}

const tierOf = (model: string): Tier | null => capabilitiesOf(model)?.tier ?? null;

export interface AnswerRoute {
  tier: Tier;
  provider: RecordAnswerProvider;
  policy: DataPolicy;
  /** The model the request goes to (the one the mock stands in for, while the mock answers). */
  model: string;
  /** Same tier, same or stricter policy; tried in order after an availability failure. */
  failover: { provider: RecordAnswerProvider; model: string; policy: DataPolicy }[];
}

type Env = Record<string, string | undefined>;

/**
 * The route for one request. A provider set by a test (setRecordAnswerProviderForTest) is used as it is, on the
 * tier's model, with no failover. `real` is the permit's: real data goes only to a provider whose flag allows it.
 */
export function routeAnswer(input: { mode: AiMode; risk?: "LOW" | "CLINICAL" | "HIGH_RISK"; real: boolean; env?: Env }): AnswerRoute {
  const env = input.env ?? process.env;
  const required = requiredTier(input.mode, input.risk);
  const configured = aiModel(MODES[input.mode].model, env);
  // The configured model if it is allowed and strong enough; otherwise the required tier's default. Never below it.
  const model = (tierOf(configured) ?? 0) >= required ? configured : TIER_MODELS[required][0];
  const tier = tierOf(model) ?? required;
  const test = overriddenRecordAnswerProvider();
  if (test) return { tier, provider: test, policy: test.id === "mock" ? "IN_PROCESS" : "EXTERNAL", model, failover: [] };
  if (recordAiProviderKind(env) === "mock") {
    if (input.real) throw new RecordAiUnavailableError("DATA_POLICY");
    return { tier, provider: mockRecordAnswer, policy: "IN_PROCESS", model, failover: [] };
  }
  const claude = PROVIDERS.find((p) => p.id === "claude")!;
  if (input.real && !providerMayReceive(claude.phiFlag!, true, env)) throw new RecordAiUnavailableError("DATA_POLICY");
  const key = env.ANTHROPIC_API_KEY!;
  const failover = TIER_MODELS[tier].filter((m) => m !== model).map((m) => ({ provider: claudeRecordAnswer(key, { model: m }), model: m, policy: claude.policy }));
  return { tier, provider: claudeRecordAnswer(key, { model }), policy: claude.policy, model, failover };
}

/** Whether a failover target may take over from a primary: same tier, same or stricter policy, never the mock for a real provider. */
export function failoverAllowed(primary: { tier: Tier; policy: DataPolicy }, target: { tier: Tier; policy: DataPolicy; id: string }): boolean {
  if (target.tier !== primary.tier) return false;
  if (STRICTNESS[target.policy] < STRICTNESS[primary.policy]) return false;
  if (primary.policy === "EXTERNAL" && target.id === "mock") return false;
  return true;
}

/**
 * The answer through the route: the primary, then each failover target after an availability failure only. A data
 * policy or internal failure is never retried elsewhere; when every target is unavailable, the last error stands
 * (the API's 503).
 */
export async function answerWithFailover(route: AnswerRoute, req: AnswerRequest, permit: AiPermit): Promise<RecordAnswer & { failedOver: number }> {
  const targets = [{ provider: route.provider, model: route.model, policy: route.policy }, ...route.failover.filter((t) => failoverAllowed(route, { tier: tierOf(t.model) ?? route.tier, policy: t.policy, id: t.provider.id }))];
  let last: unknown;
  for (const [i, t] of targets.entries()) {
    try {
      return { ...(await t.provider.answerFromRecord(req, permit)), failedOver: i };
    } catch (err) {
      last = err;
      if (!(err instanceof RecordAiUnavailableError) || (err.code !== "PROVIDER_UNAVAILABLE" && err.code !== "RATE_LIMITED")) throw err;
    }
  }
  throw last;
}
