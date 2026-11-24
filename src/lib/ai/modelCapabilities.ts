/**
 * RAG Phase 5, checklist item 31 — which request shapes each configured
 * Claude model accepts, from Anthropic's official API documentation, read on
 * 2026-11-24 (docs/adr/0005-rag-embeddings-providers-and-tables.md, addendum):
 *
 *   forced tool use  "Define tools" → Forcing tool use: tool_choice "any" and
 *                    "tool" return a 400 on Claude Opus 5.5, Sonnet 5.5,
 *                    Fable 5.1/5.2 and Mythos 5.1/5.2; accepted by Haiku 5.5
 *                    (thinking on by default; a forced call skips thinking).
 *                    https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
 *   thinking         "Thinking" (per-model table): Sonnet 5.5 — adaptive by
 *                    default, "between_tools" accepted at effort ≤ high,
 *                    "enabled" with budget_tokens and "disabled" are 400s;
 *                    Haiku 5.5 — adaptive by default, "disabled" accepted at
 *                    effort ≤ high, budget_tokens a 400; Opus 5.5 — thinking
 *                    can't be turned off. Thinking counts toward max_tokens.
 *                    https://platform.claude.com/docs/en/build-with-claude/thinking
 *   sampling         non-default temperature, top_p or top_k: a 400 on every
 *                    request for these models (and any value from API version
 *                    2026-10-21 on).
 *   prefill          a final assistant turn: a 400 on Claude 4.6 and later.
 *   structured       output_config.format {type: "json_schema"} on every
 *                    model; schemas must set additionalProperties false on
 *                    objects and may not use numerical constraints, string
 *                    length constraints, or array constraints beyond minItems
 *                    0 or 1 (a 400 otherwise). The old top-level
 *                    output_format is deprecated (a 400 without its beta
 *                    header). Incompatible with citations and prefill.
 *                    https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 *
 * The contract test (claudeContract.test.ts) builds every request the app
 * sends, through the real SDK, and fails on any shape listed here as
 * rejected for the model it goes to. A model missing from this table is not
 * an allowed model (models.ts falls back to the default).
 */
export type ThinkingType = "adaptive" | "enabled" | "disabled" | "between_tools";

export interface ModelCapabilities {
  /** tool_choice {type: "any" | "tool"}. */
  forcedToolChoice: boolean;
  /** output_config.format with a JSON schema. */
  structuredOutputs: boolean;
  /** thinking.type values the model accepts (omitting `thinking` means adaptive on all three). */
  thinking: ThinkingType[];
  /** temperature / top_p / top_k at all. */
  samplingParams: false;
  /** A final assistant turn. */
  prefill: false;
  /** output_config.effort levels. */
  effort: ("low" | "medium" | "high" | "xhigh" | "max")[];
  /** The documentation's prices are in prices.ts; the tier the registry may use it for (§12.1). */
  tier: 1 | 2;
}

const EFFORT_ALL = ["low", "medium", "high", "xhigh", "max"] as ModelCapabilities["effort"];

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "claude-sonnet-5-5": { forcedToolChoice: false, structuredOutputs: true, thinking: ["adaptive", "between_tools"], samplingParams: false, prefill: false, effort: EFFORT_ALL, tier: 2 },
  "claude-opus-5-5": { forcedToolChoice: false, structuredOutputs: true, thinking: ["adaptive"], samplingParams: false, prefill: false, effort: EFFORT_ALL, tier: 2 },
  "claude-haiku-5-5": { forcedToolChoice: true, structuredOutputs: true, thinking: ["adaptive", "disabled"], samplingParams: false, prefill: false, effort: EFFORT_ALL, tier: 1 },
};

export const DOCS_CHECKED_ON = "2026-11-24";

/** The capabilities of an allowed model, or null for a model the app doesn't send to. */
export function capabilitiesOf(model: string): ModelCapabilities | null {
  return MODEL_CAPABILITIES[model] ?? null;
}

const UNSUPPORTED_SCHEMA_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems", "minProperties", "maxProperties"];

/** Problems the docs name for a JSON schema used with structured outputs (empty when it is accepted). */
export function schemaProblems(schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Record<string, unknown>;
  const out: string[] = [];
  for (const k of UNSUPPORTED_SCHEMA_KEYWORDS) if (k in s) out.push(`${path}: "${k}" is not supported in structured outputs`);
  if (typeof s.minItems === "number" && s.minItems > 1) out.push(`${path}: minItems above 1 is not supported`);
  if (s.type === "object" && s.additionalProperties !== false) out.push(`${path}: objects must set additionalProperties false`);
  for (const [k, v] of Object.entries(s)) {
    if (k === "properties" && v && typeof v === "object") for (const [p, sub] of Object.entries(v)) out.push(...schemaProblems(sub, `${path}.${p}`));
    else if (k === "items" || k === "additionalProperties") out.push(...schemaProblems(v, `${path}[]`));
    else if ((k === "anyOf" || k === "allOf") && Array.isArray(v)) v.forEach((sub, i) => out.push(...schemaProblems(sub, `${path}.${k}[${i}]`)));
  }
  return out;
}

/**
 * Every reason the docs give for rejecting this Messages API request body on
 * its model (empty when the docs say it is accepted). Used by the contract
 * test on the bodies the SDK actually sends.
 */
export function requestShapeProblems(body: Record<string, unknown>): string[] {
  const model = String(body.model ?? "");
  const cap = capabilitiesOf(model);
  if (!cap) return [`model "${model}" is not an allowed model`];
  const out: string[] = [];
  const tc = body.tool_choice as { type?: string } | undefined;
  if (tc && (tc.type === "any" || tc.type === "tool") && !cap.forcedToolChoice) out.push(`tool_choice "${tc.type}" returns a 400 on ${model}`);
  const thinking = body.thinking as { type?: ThinkingType; budget_tokens?: number } | undefined;
  if (thinking?.type && !cap.thinking.includes(thinking.type)) out.push(`thinking "${thinking.type}" returns a 400 on ${model}`);
  if (thinking && "budget_tokens" in thinking) out.push(`thinking.budget_tokens returns a 400 on ${model}`);
  if (tc && (tc.type === "any" || tc.type === "tool") && thinking?.type === "enabled") out.push("forced tool use is incompatible with manual extended thinking");
  for (const k of ["temperature", "top_p", "top_k"]) if (k in body) out.push(`"${k}" returns a 400 on ${model}`);
  const messages = (body.messages as { role: string }[] | undefined) ?? [];
  if (messages.at(-1)?.role === "assistant") out.push(`a prefilled final assistant turn returns a 400 on ${model}`);
  if ("output_format" in body) out.push("the top-level output_format is deprecated (a 400 without its beta header); use output_config.format");
  const oc = body.output_config as { format?: { type?: string; schema?: unknown }; effort?: string } | undefined;
  if (oc?.effort && !cap.effort.includes(oc.effort as never)) out.push(`effort "${oc.effort}" is not accepted on ${model}`);
  if (oc?.effort && (oc.effort === "xhigh" || oc.effort === "max") && (thinking?.type === "between_tools" || thinking?.type === "disabled")) out.push(`thinking "${thinking.type}" is accepted only at effort high or below`);
  if (oc?.format) {
    if (!cap.structuredOutputs) out.push(`structured outputs are not available on ${model}`);
    if (oc.format.type !== "json_schema") out.push(`output_config.format.type must be "json_schema"`);
    out.push(...schemaProblems(oc.format.schema));
    if ((body as { citations?: unknown }).citations) out.push("structured outputs are incompatible with citations");
  }
  for (const t of (body.tools as { strict?: boolean; input_schema?: unknown }[] | undefined) ?? []) if (t.strict) out.push(...schemaProblems(t.input_schema, "tool"));
  return out;
}
