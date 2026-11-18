import { describe, expect, it } from "vitest";
import { EXTERNAL_PROVIDERS, phiAllowed, providerMayReceive, realDataEnabled } from "./dataPolicy";
import { voyageEmbeddings } from "./embeddings/voyage";
import { issueAiPermit } from "./record/permit";
import { AnthropicAIProvider } from "./anthropicProvider";
import { issueAssistantPermit } from "./assistantPermit";

/** RAG Phase 1, step 1.2 — the per-provider data policy (ADR 0005 part C). */
describe("the data policy", () => {
  it("is off unless exactly 'true'", () => {
    for (const v of [undefined, "", "1", "yes", "TRUE", "on"]) {
      expect(realDataEnabled({ AI_REAL_DATA_ENABLED: v })).toBe(false);
      for (const p of EXTERNAL_PROVIDERS) expect(phiAllowed(p, { [`AI_PHI_ALLOWED_${p}`]: v })).toBe(false);
    }
  });
  it("lets synthetic data through, and real data only with the switch AND the provider's own flag", () => {
    for (const p of EXTERNAL_PROVIDERS) {
      expect(providerMayReceive(p, false, {})).toBe(true);
      expect(providerMayReceive(p, true, {})).toBe(false);
      expect(providerMayReceive(p, true, { AI_REAL_DATA_ENABLED: "true" })).toBe(false);
      expect(providerMayReceive(p, true, { [`AI_PHI_ALLOWED_${p}`]: "true" })).toBe(false);
      expect(providerMayReceive(p, true, { AI_REAL_DATA_ENABLED: "true", [`AI_PHI_ALLOWED_${p}`]: "true" })).toBe(true);
    }
  });
  it("one provider's flag never opens another", () => {
    expect(providerMayReceive("VOYAGE", true, { AI_REAL_DATA_ENABLED: "true", AI_PHI_ALLOWED_ANTHROPIC: "true" })).toBe(false);
    expect(providerMayReceive("ANTHROPIC", true, { AI_REAL_DATA_ENABLED: "true", AI_PHI_ALLOWED_VOYAGE: "true" })).toBe(false);
  });
});

describe("providers enforce it before any network call", () => {
  it("Voyage refuses a real permit while its flag is off, and sends nothing", async () => {
    let calls = 0;
    const v = voyageEmbeddings("not-a-key", { fetchImpl: (async () => { calls++; return new Response("{}"); }) as typeof fetch });
    const before = { ...process.env };
    process.env.AI_REAL_DATA_ENABLED = "true";
    delete process.env.AI_PHI_ALLOWED_VOYAGE;
    try {
      await expect(v.embed(["x"], "query", issueAiPermit("person:test", true))).rejects.toMatchObject({ code: "REAL_DATA_REFUSED" });
      await expect(v.rerank!("x", ["y"], issueAiPermit("person:test", true))).rejects.toMatchObject({ code: "REAL_DATA_REFUSED" });
      expect(calls).toBe(0);
    } finally {
      process.env = before;
    }
  });
  it("the portal assistant (Anthropic) refuses a real permit while its flag is off", async () => {
    const before = { ...process.env };
    process.env.AI_REAL_DATA_ENABLED = "true";
    delete process.env.AI_PHI_ALLOWED_ANTHROPIC;
    try {
      await expect(new AnthropicAIProvider("not-a-key").assistantReply({ audience: "patient", message: "hi" }, issueAssistantPermit(true))).rejects.toThrow("DATA_POLICY");
    } finally {
      process.env = before;
    }
  });
});
