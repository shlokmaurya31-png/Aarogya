import Anthropic from "@anthropic-ai/sdk";

/**
 * Before a manual real-provider run: one tiny request (no patient or fixture
 * content) to see whether the account can serve. Returns a closed reason,
 * never the provider's text or the key.
 */
export type PreflightResult = "OK" | "AUTHENTICATION_FAILED" | "INSUFFICIENT_CREDIT" | "MODEL_NOT_AVAILABLE" | "PROVIDER_UNAVAILABLE";

export async function anthropicPreflight(apiKey: string, model: string): Promise<PreflightResult> {
  const c = new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000 });
  try {
    await c.messages.create({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
    return "OK";
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return "AUTHENTICATION_FAILED";
    if (err instanceof Anthropic.NotFoundError) return "MODEL_NOT_AVAILABLE";
    if (err instanceof Anthropic.APIError && err.status === 400) {
      const reason = (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? "";
      return /credit balance|billing|purchase credits/i.test(reason) ? "INSUFFICIENT_CREDIT" : "PROVIDER_UNAVAILABLE";
    }
    return "PROVIDER_UNAVAILABLE";
  }
}
