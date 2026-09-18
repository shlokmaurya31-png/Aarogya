import { z } from "zod";
import { assertNoSensitiveData } from "@/lib/events/sensitiveGuard";
import {
  ConfigError, CONFIG_LIMITS, assertJsonBounds, escalationSchema, formSchema,
  type KeySpec, type Scope, type ValueType,
} from "./types";

/**
 * Phase D8 — the configuration key registry (§6/§7).
 *
 * The CLOSED set of legal configuration keys. Arbitrary keys are refused. Each key
 * has a value type, the scopes it may be set at, an optional system default, a
 * strict validator, and a canonicalizer. Keys are either EXACT or belong to a small
 * number of TEMPLATED families (e.g. `workflow.{key}.sla`) whose dynamic segment is
 * a bounded slug. No key stores executable content or secrets.
 */

const ALL: Scope[] = ["ORGANIZATION", "FACILITY", "DEPARTMENT"];
const slug = "[a-z0-9][a-z0-9_.-]{0,80}";

// ── Spec builders ────────────────────────────────────────────────────────────
function boolean(opts: { scopes?: Scope[]; default?: boolean; description: string; platformOnly?: boolean }): KeySpec {
  return {
    valueType: "BOOLEAN", scopes: opts.scopes ?? ALL, hasDefault: opts.default !== undefined,
    default: opts.default === undefined ? "" : String(opts.default), description: opts.description,
    sensitivity: "LOW", platformOnly: opts.platformOnly ?? false,
    parse: (raw) => { if (raw !== "true" && raw !== "false") throw new ConfigError(`Expected boolean, got "${raw}".`); return raw === "true"; },
    normalize: (raw) => { const v = raw.trim().toLowerCase(); if (v !== "true" && v !== "false") throw new ConfigError("Boolean must be true or false."); return v; },
  };
}
function number(opts: { scopes?: Scope[]; default?: number; min?: number; max?: number; description: string; platformOnly?: boolean }): KeySpec {
  const schema = z.number().int().min(opts.min ?? 0).max(opts.max ?? 1_000_000_000);
  return {
    valueType: "NUMBER", scopes: opts.scopes ?? ALL, hasDefault: opts.default !== undefined,
    default: opts.default === undefined ? "" : String(opts.default), description: opts.description,
    sensitivity: "LOW", platformOnly: opts.platformOnly ?? false,
    parse: (raw) => { const n = Number(raw); const r = schema.safeParse(n); if (!r.success) throw new ConfigError(`Invalid number: ${r.error.issues[0]?.message}`); return n; },
    normalize: (raw) => { const n = Number(raw.trim()); const r = schema.safeParse(n); if (!r.success) throw new ConfigError(`Invalid number: ${r.error.issues[0]?.message}`); return String(n); },
  };
}
function str(opts: { scopes?: Scope[]; default?: string; maxLen?: number; description: string; platformOnly?: boolean }): KeySpec {
  const max = opts.maxLen ?? 200;
  return {
    valueType: "STRING", scopes: opts.scopes ?? ALL, hasDefault: opts.default !== undefined,
    default: opts.default ?? "", description: opts.description, sensitivity: "LOW", platformOnly: opts.platformOnly ?? false,
    parse: (raw) => { if (raw.length > max) throw new ConfigError(`String exceeds ${max} chars.`); assertNoSensitiveData({ value: raw }); return raw; },
    normalize: (raw) => { if (raw.length > max) throw new ConfigError(`String exceeds ${max} chars.`); assertNoSensitiveData({ value: raw }); return raw; },
  };
}
function enumSpec(values: readonly string[], opts: { scopes?: Scope[]; default?: string; description: string; platformOnly?: boolean }): KeySpec {
  return {
    valueType: "ENUM", scopes: opts.scopes ?? ALL, hasDefault: opts.default !== undefined,
    default: opts.default ?? "", description: opts.description, sensitivity: "LOW", platformOnly: opts.platformOnly ?? false, enumValues: values,
    parse: (raw) => { if (!values.includes(raw)) throw new ConfigError(`Expected one of ${values.join("|")}.`); return raw; },
    normalize: (raw) => { const v = raw.trim(); if (!values.includes(v)) throw new ConfigError(`Expected one of ${values.join("|")}.`); return v; },
  };
}
const DURATION_RE = /^(\d+)(s|m|h|d)?$/;
function toSeconds(raw: string): number {
  const m = DURATION_RE.exec(raw.trim());
  if (!m) throw new ConfigError(`Invalid duration "${raw}" (use e.g. 30, 30s, 15m, 4h, 1d).`);
  const n = Number(m[1]);
  const mult = m[2] === "m" ? 60 : m[2] === "h" ? 3600 : m[2] === "d" ? 86400 : 1;
  const secs = n * mult;
  if (secs <= 0 || secs > CONFIG_LIMITS.MAX_DURATION_SECONDS) throw new ConfigError(`Duration must be 1..${CONFIG_LIMITS.MAX_DURATION_SECONDS} seconds.`);
  return secs;
}
function duration(opts: { scopes?: Scope[]; default?: number; description: string; platformOnly?: boolean }): KeySpec {
  return {
    valueType: "DURATION", scopes: opts.scopes ?? ALL, hasDefault: opts.default !== undefined,
    default: opts.default === undefined ? "" : String(opts.default), description: opts.description, sensitivity: "LOW", platformOnly: opts.platformOnly ?? false,
    parse: (raw) => toSeconds(raw), // returns seconds (number)
    normalize: (raw) => String(toSeconds(raw)),
  };
}
function json(schema: z.ZodTypeAny, opts: { scopes?: Scope[]; description: string; platformOnly?: boolean }): KeySpec {
  const validate = (raw: string): unknown => {
    if (raw.length > CONFIG_LIMITS.MAX_JSON_BYTES) throw new ConfigError(`JSON config exceeds ${CONFIG_LIMITS.MAX_JSON_BYTES} bytes.`);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new ConfigError("Value is not valid JSON."); }
    assertJsonBounds(parsed);
    assertNoSensitiveData(parsed); // no secrets/PHI/blobs, at any depth
    const r = schema.safeParse(parsed);
    if (!r.success) throw new ConfigError(`Invalid JSON config: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    return r.data;
  };
  return {
    valueType: "JSON", scopes: opts.scopes ?? ALL, hasDefault: false, default: "",
    description: opts.description, sensitivity: "LOW", platformOnly: opts.platformOnly ?? false,
    parse: validate,
    normalize: (raw) => JSON.stringify(validate(raw)),
  };
}

// ── Exact keys ───────────────────────────────────────────────────────────────
const EXACT: Record<string, KeySpec> = {
  // A representative concrete SLA metric (mirrors hospital/sla.ts metrics) with a
  // registry-level system default.
  "sla.critical_result_ack": duration({ default: 900, description: "SLA to acknowledge a critical result (default 15m)." }),
  "sla.admission_assessment": duration({ default: 3600, description: "SLA to complete an admission assessment (default 60m)." }),
  "queue.triage.max_wait": duration({ default: 1800, description: "Max triage queue wait before attention (default 30m)." }),
  "billing.auto_write_off.enabled": boolean({ default: false, description: "Whether small-balance auto write-off is enabled." }),
};

// ── Templated families ───────────────────────────────────────────────────────
const TEMPLATES: { pattern: RegExp; spec: KeySpec }[] = [
  { pattern: new RegExp(`^workflow\\.${slug}\\.enabled$`), spec: boolean({ default: true, description: "Whether this workflow is enabled at this scope." }) },
  { pattern: new RegExp(`^workflow\\.${slug}\\.sla$`), spec: duration({ description: "Effective SLA (seconds) for this workflow's SLA step; falls back to the workflow version's own SLA when unset." }) },
  { pattern: new RegExp(`^workflow\\.${slug}\\.priority$`), spec: enumSpec(["ROUTINE", "URGENT", "STAT"], { default: "ROUTINE", description: "Default priority for tasks this workflow creates." }) },
  { pattern: new RegExp(`^workflow\\.${slug}\\.escalation$`), spec: json(escalationSchema, { description: "Declarative escalation policy (who/when/intent). Delivery is a later phase." }) },
  { pattern: new RegExp(`^sla\\.${slug}$`), spec: duration({ description: "A named operational SLA (seconds)." }) },
  { pattern: new RegExp(`^escalation\\.${slug}$`), spec: json(escalationSchema, { description: "A named declarative escalation policy." }) },
  { pattern: new RegExp(`^alert\\.${slug}\\.enabled$`), spec: boolean({ default: true, description: "Whether this alert is enabled at this scope." }) },
  { pattern: new RegExp(`^alert\\.${slug}\\.severity$`), spec: enumSpec(["INFO", "WARNING", "CRITICAL"], { default: "WARNING", description: "Configured severity for this alert." }) },
  { pattern: new RegExp(`^alert\\.${slug}\\.cooldown$`), spec: duration({ default: 3600, description: "Minimum time between repeats of this alert." }) },
  { pattern: new RegExp(`^queue\\.${slug}\\.default_priority$`), spec: enumSpec(["ROUTINE", "URGENT", "STAT"], { default: "ROUTINE", description: "Default priority for entries in this queue." }) },
  { pattern: new RegExp(`^queue\\.${slug}\\.max_wait$`), spec: duration({ description: "Max wait for this queue before escalation/attention." }) },
  { pattern: new RegExp(`^billing\\.${slug}\\.enabled$`), spec: boolean({ default: false, description: "Whether this billing rule is enabled." }) },
  { pattern: new RegExp(`^billing\\.${slug}\\.param$`), spec: number({ description: "A bounded numeric parameter for an approved billing rule (never a formula)." }) },
  { pattern: new RegExp(`^tariff\\.${slug}\\.override_minor$`), spec: number({ description: "Facility-specific tariff override in minor currency units; canonical calculation stays in Billing." }) },
  { pattern: new RegExp(`^package\\.${slug}\\.enabled$`), spec: boolean({ default: true, description: "Whether this package is available at this scope." }) },
  { pattern: new RegExp(`^form\\.${slug}\\.definition$`), spec: json(formSchema, { description: "A strict declarative form definition (fields/labels/types/validation)." }) },
  { pattern: new RegExp(`^department\\.${slug}\\.param$`), spec: number({ description: "A bounded department-level operational parameter." }) },
  { pattern: new RegExp(`^role\\.${slug}\\.responsible$`), spec: str({ scopes: ALL, maxLen: 80, description: "The responsible role mapping for a workflow/queue/escalation (final authorization stays with C4)." }) },
];

/** Resolve a key to its spec, or undefined if the key is not in the registry. */
export function resolveKeySpec(key: string): KeySpec | undefined {
  if (typeof key !== "string" || key.length === 0 || key.length > 200) return undefined;
  if (EXACT[key]) return EXACT[key];
  for (const t of TEMPLATES) if (t.pattern.test(key)) return t.spec;
  return undefined;
}

export function isKnownConfigKey(key: string): boolean {
  return resolveKeySpec(key) !== undefined;
}

/** For the UI: exact keys + template descriptors (never used to write). */
export function listRegistry(): { exact: { key: string; valueType: ValueType; scopes: Scope[]; description: string; default: string | null }[]; templates: { pattern: string; valueType: ValueType; description: string }[] } {
  return {
    exact: Object.entries(EXACT).map(([key, s]) => ({ key, valueType: s.valueType, scopes: s.scopes, description: s.description, default: s.hasDefault ? s.default : null })),
    templates: TEMPLATES.map((t) => ({ pattern: t.pattern.source, valueType: t.spec.valueType, description: t.spec.description })),
  };
}
