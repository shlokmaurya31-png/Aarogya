import { ClaudeDocumentClient, claudeExtraction, claudeOcr, claudeTagging, claudeTranslation } from "./claude";
import { mockExtraction, mockOcr, mockTagging, mockTranslation } from "./mock";
import type { DocumentProviders } from "./types";

export * from "./types";
export { mockControl } from "./mock";

/**
 * Week 4a — which document providers run (docs/DOCUMENT_PIPELINE_DESIGN.md §6).
 * Claude only when BOTH an API key is set AND DOCUMENT_AI_PROVIDER=claude: a key
 * present for other features never turns the pipeline on by itself. Otherwise
 * the deterministic mocks. Either way every call needs a ProcessingPermit, so
 * the real-data switch and consent decide whose documents reach a provider.
 */
export function documentProviderKind(env: Record<string, string | undefined> = process.env): "claude" | "mock" {
  return env.DOCUMENT_AI_PROVIDER === "claude" && !!env.ANTHROPIC_API_KEY ? "claude" : "mock";
}

let override: DocumentProviders | null = null;
let cached: { kind: "claude" | "mock"; providers: DocumentProviders } | null = null;

export function getDocumentProviders(env: Record<string, string | undefined> = process.env): DocumentProviders {
  if (override) return override;
  const kind = documentProviderKind(env);
  if (cached?.kind === kind) return cached.providers;
  let providers: DocumentProviders;
  if (kind === "claude") {
    const c = new ClaudeDocumentClient(env.ANTHROPIC_API_KEY!);
    providers = { ocr: claudeOcr(c), translation: claudeTranslation(c), extraction: claudeExtraction(c), tagging: claudeTagging(c) };
  } else {
    providers = { ocr: mockOcr, translation: mockTranslation, extraction: mockExtraction, tagging: mockTagging };
  }
  cached = { kind, providers };
  return providers;
}

/** Tests and gates only: replace the providers (null restores the configured ones). */
export function setDocumentProvidersForTest(p: DocumentProviders | null): void {
  override = p;
}
