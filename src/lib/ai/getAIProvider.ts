import type { AIProvider } from "./provider";
import { MockAIProvider } from "./mockProvider";
import { AnthropicAIProvider } from "./anthropicProvider";

let cached: AIProvider | null = null;

export function getAIProvider(): AIProvider {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const configured = process.env.AI_PROVIDER ?? "anthropic";
  if (configured === "anthropic" && apiKey) {
    cached = new AnthropicAIProvider(apiKey);
  } else {
    cached = new MockAIProvider();
  }
  return cached;
}
