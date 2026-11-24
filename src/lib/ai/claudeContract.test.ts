import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AI_MODEL_DEFAULTS, aiModel } from "./models";
import { MODEL_CAPABILITIES, requestShapeProblems, schemaProblems } from "./modelCapabilities";
import { claudeRecordAnswer, recordAnswerParams } from "./record/claude";
import { issueAiPermit } from "./record/permit";
import { ClaudeDocumentClient, claudeExtraction, claudeOcr, claudeTagging, claudeTranslation } from "./documents/claude";
import { issuePermit } from "./documents/permit";
import { AI_MODES } from "@/lib/rag/modes";

/**
 * RAG Phase 5, checklist item 31 — the request-shape contract. Every request
 * the app sends to Anthropic is built by the real code and serialised by the
 * real SDK (a fetch that records the body and answers like the API), for
 * every mode and every model the configuration can choose; the body must
 * break none of the rules Anthropic's documentation gives for that model
 * (modelCapabilities.ts). No mock answerer is involved, and no network.
 */
type Body = Record<string, unknown>;
const sent: Body[] = [];

function recordingClient(reply: (body: Body) => Body): Anthropic {
  return new Anthropic({
    apiKey: "contract-test", maxRetries: 0,
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      sent.push(body);
      return new Response(JSON.stringify(reply(body)), { status: 200, headers: { "content-type": "application/json", "request-id": "req_contract" } });
    }) as typeof fetch,
  });
}

const message = (body: Body, content: unknown[]) => ({ id: "msg_contract", type: "message", role: "assistant", model: body.model, content, stop_reason: content.some((c) => (c as { type: string }).type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });

const SOURCES = [{ n: 1, chunkId: "c1", context: "[Lab result · Hemoglobin · 2026-10-01 · verified]", text: "Hemoglobin 11.2 g/dL (reference 12.0 - 15.5), low." }];

afterEach(() => { sent.length = 0; });

describe("the documented rules themselves", () => {
  it("reject the shapes the docs reject (the old forced answer tool on Sonnet 5.5 among them)", () => {
    const old = { model: "claude-sonnet-5-5", max_tokens: 2048, messages: [{ role: "user", content: "x" }], tools: [{ name: "answer", input_schema: { type: "object" } }], tool_choice: { type: "tool", name: "answer" } };
    expect(requestShapeProblems(old)).toEqual(['tool_choice "tool" returns a 400 on claude-sonnet-5-5']);
    expect(requestShapeProblems({ ...old, model: "claude-opus-5-5", tool_choice: { type: "any" } })).toHaveLength(1);
    expect(requestShapeProblems({ ...old, model: "claude-haiku-5-5" })).toEqual([]);
    expect(requestShapeProblems({ model: "claude-sonnet-5-5", thinking: { type: "enabled", budget_tokens: 1024 }, messages: [] }).length).toBe(2);
    expect(requestShapeProblems({ model: "claude-sonnet-5-5", thinking: { type: "disabled" }, messages: [] })).toHaveLength(1);
    expect(requestShapeProblems({ model: "claude-haiku-5-5", thinking: { type: "disabled" }, messages: [] })).toEqual([]);
    expect(requestShapeProblems({ model: "claude-sonnet-5-5", temperature: 0, messages: [] })).toHaveLength(1);
    expect(requestShapeProblems({ model: "claude-sonnet-5-5", messages: [{ role: "user" }, { role: "assistant" }] })).toHaveLength(1);
    expect(requestShapeProblems({ model: "claude-sonnet-5-5", output_format: {}, messages: [] })).toHaveLength(1);
    expect(requestShapeProblems({ model: "claude-sonnet-4-0", messages: [] })).toHaveLength(1);
    expect(schemaProblems({ type: "object", properties: { a: { type: "string", maxLength: 5 } } })).toHaveLength(2);
  });
});

describe("record answers (every mode, every allowed model)", () => {
  for (const model of Object.keys(MODEL_CAPABILITIES)) {
    for (const mode of AI_MODES) {
      it(`${mode} on ${model}: a body the docs accept, answered and parsed`, async () => {
        const client = recordingClient((b) => message(b, [{ type: "text", text: JSON.stringify({ outcome: "ANSWERED", sentences: [{ text: "Hemoglobin 11.2 g/dL (reference 12.0 - 15.5), low.", citations: [1], kind: "FACT" }] }) }]));
        const provider = claudeRecordAnswer("contract-test", { model, client });
        const a = await provider.answerFromRecord({ mode, audience: "STAFF", language: "en", question: "Latest hemoglobin?", sources: SOURCES }, issueAiPermit("synthetic", false));
        expect(sent).toHaveLength(1);
        expect(requestShapeProblems(sent[0])).toEqual([]);
        expect(sent[0]).not.toHaveProperty("tool_choice");
        expect(a.outcome).toBe("ANSWERED");
        expect(a.sentences[0].citations).toEqual([1]);
      });
    }
  }
  it("the configured default model for every mode is an allowed one", () => {
    for (const mode of AI_MODES) expect(requestShapeProblems(recordAnswerParams({ mode, audience: "STAFF", language: "en", sources: SOURCES }, aiModel(mode === "KNOWLEDGE_QA" ? "knowledge_qa" : (mode.toLowerCase() as never))) as unknown as Body)).toEqual([]);
  });
  it("a refusal stop is a REFUSED_SAFETY answer; a cut-off answer is a provider error, never a part of one", async () => {
    const refuse = claudeRecordAnswer("contract-test", { model: "claude-sonnet-5-5", client: recordingClient((b) => ({ ...message(b, [{ type: "text", text: "" }]), stop_reason: "refusal" })) });
    expect((await refuse.answerFromRecord({ mode: "CHART_QA", audience: "STAFF", language: "en", question: "x", sources: SOURCES }, issueAiPermit("s", false))).outcome).toBe("REFUSED_SAFETY");
    const cut = claudeRecordAnswer("contract-test", { model: "claude-sonnet-5-5", client: recordingClient((b) => ({ ...message(b, [{ type: "text", text: '{"outcome":"ANSWERED","sentences":[' }]), stop_reason: "max_tokens" })) });
    await expect(cut.answerFromRecord({ mode: "CHART_QA", audience: "STAFF", language: "en", question: "x", sources: SOURCES }, issueAiPermit("s", false))).rejects.toThrow(/INTERNAL/);
  });
});

describe("document helpers (every helper, on its configured model and on every allowed model)", () => {
  const helpers = [
    { key: "ocr", tool: "page_transcription", run: (c: ClaudeDocumentClient) => claudeOcr(c).ocrPage({ bytes: Buffer.from("x"), contentType: "image/png" }, {}, issuePermit("p", false)), input: { lines: [{ text: "Hb 11.2", bbox: [0, 0, 1, 1], confidence: 0.9 }], language: "en", script: "Latn", handwritten: false, confidence: 0.9 } },
    { key: "ocr_retry", tool: "page_transcription", run: (c: ClaudeDocumentClient) => claudeOcr(c).ocrPage({ bytes: Buffer.from("x"), contentType: "image/png" }, { retry: true }, issuePermit("p", false)), input: { lines: [{ text: "Hb 11.2", bbox: [0, 0, 1, 1], confidence: 0.9 }], language: "en", script: "Latn", handwritten: false, confidence: 0.9 } },
    { key: "translation", tool: "translation", run: (c: ClaudeDocumentClient) => claudeTranslation(c).translate("⟦P1⟧ is low", "en", "hi", {}, issuePermit("p", false)), input: { text: "⟦P1⟧ कम है" } },
    { key: "extraction", tool: "facts", run: (c: ClaudeDocumentClient) => claudeExtraction(c).extract({ text: "Hb 11.2 g/dL", layout: [], language: "en" }, issuePermit("p", false)), input: { facts: [] } },
    { key: "tagging", tool: "medicine_names", run: (c: ClaudeDocumentClient) => claudeTagging(c).tagMedicines("Metformin 500 mg", issuePermit("p", false)), input: { names: ["Metformin"] } },
  ] as const;
  for (const h of helpers) {
    for (const model of [AI_MODEL_DEFAULTS[h.key], ...Object.keys(MODEL_CAPABILITIES)]) {
      it(`${h.key} on ${model}`, async () => {
        const before = process.env[`AI_MODEL_${h.key.toUpperCase()}`];
        process.env[`AI_MODEL_${h.key.toUpperCase()}`] = model;
        try {
          const client = recordingClient((b) => message(b, [{ type: "tool_use", id: "toolu_1", name: (b.tools as { name: string }[])[0].name, input: h.input }]));
          await h.run(new ClaudeDocumentClient("contract-test", client)).catch((err) => { if (!/UNREADABLE|INTERNAL/.test(String(err))) throw err; });
          expect(sent.length).toBeGreaterThan(0);
          for (const b of sent) expect(requestShapeProblems(b)).toEqual([]);
          expect(sent[0].model).toBe(model);
        } finally {
          if (before === undefined) delete process.env[`AI_MODEL_${h.key.toUpperCase()}`];
          else process.env[`AI_MODEL_${h.key.toUpperCase()}`] = before;
        }
      });
    }
  }
});
