import { afterEach, describe, expect, it } from "vitest";
import { AI_MODES, MODES } from "@/lib/rag/modes";
import { aiModel, AI_MODEL_DEFAULTS } from "@/lib/ai/models";
import { answerWithFailover, failoverAllowed, requiredTier, routeAnswer, type AnswerRoute } from "./registry";
import { issueAiPermit } from "./permit";
import { mockRecordAnswer } from "./mock";
import { setRecordAnswerProviderForTest } from "./index";
import { RecordAiUnavailableError, type AnswerRequest, type RecordAnswerProvider } from "./types";

/** RAG Phase 5, steps 5.3 and 5.4 — the registry's routing and failover (no network: routes are built, never called, unless a fake is). */
const CLAUDE_ENV = { RECORD_AI_PROVIDER: "claude", ANTHROPIC_API_KEY: "test-key-not-used" };
const REQ: AnswerRequest = { mode: "CHART_QA", audience: "STAFF", language: "en", question: "x", sources: [{ n: 1, chunkId: "c", context: "[c]", text: "Hb 11.2 g/dL" }] };
const failing = (code: RecordAiUnavailableError["code"], calls: string[], id: "claude" | "mock" = "claude"): RecordAnswerProvider => ({ id, async answerFromRecord() { calls.push(code); throw new RecordAiUnavailableError(code); } });

afterEach(() => setRecordAnswerProviderForTest(null));

describe("routing by tier, risk and policy (5.3)", () => {
  it("a patient-facing mode never routes below Tier 2, whatever the risk or the configured model", () => {
    for (const mode of AI_MODES.filter((m) => MODES[m].audience === "PATIENT")) {
      for (const risk of ["LOW", "CLINICAL", "HIGH_RISK"] as const) {
        expect(requiredTier(mode, risk)).toBe(2);
        const r = routeAnswer({ mode, risk, real: false, env: { ...CLAUDE_ENV, [`AI_MODEL_${MODES[mode].model.toUpperCase()}`]: "claude-haiku-5-5" } });
        expect(r.tier).toBe(2);
        expect(r.model).not.toBe("claude-haiku-5-5");
      }
    }
  });
  it("a short knowledge answer may use Tier 1 when configured; a high-risk one and every record mode never below Tier 2", () => {
    expect(routeAnswer({ mode: "KNOWLEDGE_QA", risk: "LOW", real: false, env: CLAUDE_ENV })).toMatchObject({ tier: 2, model: "claude-sonnet-5-5" });
    const haiku = { ...CLAUDE_ENV, AI_MODEL_KNOWLEDGE_QA: "claude-haiku-5-5" };
    expect(routeAnswer({ mode: "KNOWLEDGE_QA", risk: "LOW", real: false, env: haiku })).toMatchObject({ tier: 1, model: "claude-haiku-5-5" });
    expect(routeAnswer({ mode: "KNOWLEDGE_QA", risk: "HIGH_RISK", real: false, env: haiku })).toMatchObject({ tier: 2, model: "claude-sonnet-5-5" });
    for (const mode of ["CHART_QA", "VISIT_BRIEF"] as const) expect(routeAnswer({ mode, real: false, env: { ...CLAUDE_ENV, [`AI_MODEL_${MODES[mode].model.toUpperCase()}`]: "claude-haiku-5-5" } })).toMatchObject({ tier: 2, model: "claude-sonnet-5-5" });
    for (const mode of ["CHART_QA", "VISIT_BRIEF", "NURSE_HANDOFF"] as const) expect(routeAnswer({ mode, real: false, env: CLAUDE_ENV })).toMatchObject({ tier: 2, model: "claude-sonnet-5-5" });
  });
  it("a provider without its flag never receives a real permit: the route is refused before any call", () => {
    for (const env of [CLAUDE_ENV, { ...CLAUDE_ENV, AI_REAL_DATA_ENABLED: "true" }, { ...CLAUDE_ENV, AI_PHI_ALLOWED_ANTHROPIC: "true" }]) {
      expect(() => routeAnswer({ mode: "CHART_QA", real: true, env })).toThrow(/DATA_POLICY/);
    }
    expect(() => routeAnswer({ mode: "CHART_QA", real: true, env: {} })).toThrow(/DATA_POLICY/);
    expect(routeAnswer({ mode: "CHART_QA", real: true, env: { ...CLAUDE_ENV, AI_REAL_DATA_ENABLED: "true", AI_PHI_ALLOWED_ANTHROPIC: "true" } }).policy).toBe("EXTERNAL");
  });
  it("a model id outside the allow-list falls back to the default", () => {
    for (const bad of ["claude-sonnet-4-0", "gpt-5", "claude-sonnet-5-5; drop", "CLAUDE-SONNET-5-5", ""]) {
      expect(aiModel("chart_qa", { AI_MODEL_CHART_QA: bad })).toBe(AI_MODEL_DEFAULTS.chart_qa);
    }
    expect(routeAnswer({ mode: "CHART_QA", real: false, env: { ...CLAUDE_ENV, AI_MODEL_CHART_QA: "claude-fake-9" } }).model).toBe("claude-sonnet-5-5");
    expect(routeAnswer({ mode: "CHART_QA", real: false, env: { ...CLAUDE_ENV, AI_MODEL_CHART_QA: "claude-opus-5-5" } }).model).toBe("claude-opus-5-5");
  });
});

describe("failover (5.4)", () => {
  it("is allowed only to the same tier and the same or a stricter policy, never from a real provider to the mock", () => {
    expect(failoverAllowed({ tier: 2, policy: "EXTERNAL" }, { tier: 2, policy: "EXTERNAL", id: "claude" })).toBe(true);
    expect(failoverAllowed({ tier: 2, policy: "EXTERNAL" }, { tier: 1, policy: "EXTERNAL", id: "claude" })).toBe(false);
    expect(failoverAllowed({ tier: 2, policy: "IN_PROCESS" }, { tier: 2, policy: "EXTERNAL", id: "claude" })).toBe(false);
    expect(failoverAllowed({ tier: 2, policy: "EXTERNAL" }, { tier: 2, policy: "IN_PROCESS", id: "mock" })).toBe(false);
    const r = routeAnswer({ mode: "CHART_QA", real: false, env: CLAUDE_ENV });
    expect(r.failover.map((f) => f.model)).toEqual(["claude-opus-5-5"]);
    expect(routeAnswer({ mode: "KNOWLEDGE_QA", real: false, env: { ...CLAUDE_ENV, AI_MODEL_KNOWLEDGE_QA: "claude-haiku-5-5" } }).failover).toEqual([]);
  });
  it("moves on after an availability failure, to a same-tier target, and answers", async () => {
    const calls: string[] = [];
    const route: AnswerRoute = { tier: 2, provider: failing("PROVIDER_UNAVAILABLE", calls), policy: "EXTERNAL", model: "claude-sonnet-5-5",
      failover: [{ provider: { id: "claude", answerFromRecord: async () => ({ outcome: "NO_RECORD", sentences: [], model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1 }) }, model: "claude-opus-5-5", policy: "EXTERNAL" }] };
    const a = await answerWithFailover(route, REQ, issueAiPermit("s", false));
    expect(a).toMatchObject({ model: "claude-opus-5-5", failedOver: 1 });
    expect(calls).toEqual(["PROVIDER_UNAVAILABLE"]);
  });
  it("never retries a data-policy or internal failure elsewhere", async () => {
    for (const code of ["DATA_POLICY", "INTERNAL"] as const) {
      const calls: string[] = [];
      const route: AnswerRoute = { tier: 2, provider: failing(code, calls), policy: "EXTERNAL", model: "claude-sonnet-5-5", failover: [{ provider: failing("PROVIDER_UNAVAILABLE", calls), model: "claude-opus-5-5", policy: "EXTERNAL" }] };
      await expect(answerWithFailover(route, REQ, issueAiPermit("s", false))).rejects.toThrow(code);
      expect(calls).toEqual([code]);
    }
  });
  it("a real provider's failure is a 503 (the error stands), never the mock", async () => {
    const calls: string[] = [];
    const route: AnswerRoute = { tier: 2, provider: failing("PROVIDER_UNAVAILABLE", calls), policy: "EXTERNAL", model: "claude-sonnet-5-5",
      failover: [{ provider: failing("RATE_LIMITED", calls), model: "claude-opus-5-5", policy: "EXTERNAL" }, { provider: mockRecordAnswer, model: "mock-record-1", policy: "IN_PROCESS" }] };
    await expect(answerWithFailover(route, REQ, issueAiPermit("s", false))).rejects.toThrow(/RATE_LIMITED/);
    expect(calls).toEqual(["PROVIDER_UNAVAILABLE", "RATE_LIMITED"]);
  });
  it("a provider set by a test is used as it is, with no failover", () => {
    const fake: RecordAnswerProvider = { id: "claude", answerFromRecord: mockRecordAnswer.answerFromRecord };
    setRecordAnswerProviderForTest(fake);
    expect(routeAnswer({ mode: "CHART_QA", real: false, env: CLAUDE_ENV })).toMatchObject({ provider: fake, failover: [] });
  });
});
