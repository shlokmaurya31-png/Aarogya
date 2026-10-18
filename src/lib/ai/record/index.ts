import { claudeRecordAnswer } from "./claude";
import { mockRecordAnswer } from "./mock";
import type { RecordAnswerProvider } from "./types";

export * from "./types";
export { issueAiPermit } from "./permit";

/**
 * Week 4b — which answer provider runs (docs/RAG_DESIGN.md §6.1). Claude only
 * with BOTH an API key AND RECORD_AI_PROVIDER=claude (a key set for other
 * features never turns this on); otherwise the deterministic mock. The mock
 * refuses a permit for real data, so real data is only ever answered by the
 * configured model, and a provider failure is a 503, never the mock.
 */
export function recordAiProviderKind(env: Record<string, string | undefined> = process.env): "claude" | "mock" {
  return env.RECORD_AI_PROVIDER === "claude" && !!env.ANTHROPIC_API_KEY ? "claude" : "mock";
}

let override: RecordAnswerProvider | null = null;
let cached: { kind: "claude" | "mock"; provider: RecordAnswerProvider } | null = null;

export function getRecordAnswerProvider(env: Record<string, string | undefined> = process.env): RecordAnswerProvider {
  if (override) return override;
  const kind = recordAiProviderKind(env);
  if (cached?.kind === kind) return cached.provider;
  const provider = kind === "claude" ? claudeRecordAnswer(env.ANTHROPIC_API_KEY!) : mockRecordAnswer;
  cached = { kind, provider };
  return provider;
}

/** Tests and gates only: replace the provider (null restores the configured one). */
export function setRecordAnswerProviderForTest(p: RecordAnswerProvider | null): void {
  override = p;
}
