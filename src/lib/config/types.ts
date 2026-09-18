import { z } from "zod";

/**
 * Phase D8 — configuration engine shared types & bounds.
 *
 * D8 separates a configuration DEFINITION (the registry), an EFFECTIVE VALUE
 * (resolved by scope + time, with provenance), and RUNTIME DOMAIN STATE (which
 * stays in canonical models). It never grants access — C4 stays authoritative.
 */

export const VALUE_TYPES = ["BOOLEAN", "NUMBER", "STRING", "ENUM", "DURATION", "JSON"] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

/** Scope levels a value can be set at (most specific first at resolution). */
export const SCOPES = ["ORGANIZATION", "FACILITY", "DEPARTMENT"] as const;
export type Scope = (typeof SCOPES)[number];

/** The full resolution chain, most specific first, then the system default. */
export const RESOLUTION_ORDER = ["DEPARTMENT", "FACILITY", "ORGANIZATION", "SYSTEM"] as const;
export type ResolutionSource = (typeof RESOLUTION_ORDER)[number] | "UNSET";

export const OVERRIDE_STATUS = ["DRAFT", "PUBLISHED", "RETIRED"] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUS)[number];

/** Conservative safety bounds (config explosion / poisoning). */
export const CONFIG_LIMITS = {
  MAX_JSON_BYTES: 8 * 1024,
  MAX_JSON_DEPTH: 6,
  MAX_ARRAY: 100,
  MAX_DURATION_SECONDS: 30 * 24 * 3600, // 30 days
  MAX_OVERRIDES_PER_SCOPE: 500,
} as const;

/** One registry entry: the closed definition of a legal configuration key. */
export interface KeySpec {
  valueType: ValueType;
  /** Scope levels at which this key may be set. */
  scopes: Scope[];
  /** Whether the registry supplies a system default at the bottom of the chain. */
  hasDefault: boolean;
  /** Canonical stored-string form of the system default (when hasDefault). */
  default: string;
  /** Human description (safe to surface). */
  description: string;
  sensitivity: "LOW" | "INTERNAL";
  /** Platform-only keys can never be set by an organization/facility admin. */
  platformOnly: boolean;
  /** Allowed values for ENUM. */
  enumValues?: readonly string[];
  /** Validate + coerce a stored string into its typed value (throws on invalid). */
  parse: (raw: string) => unknown;
  /** Canonicalize an input string for storage (e.g. "30m" → "1800"). */
  normalize: (raw: string) => string;
}

/** A single level's contribution to the resolution chain (for the explainer). */
export interface ChainEntry {
  source: ResolutionSource;
  sourceId: string | null;
  present: boolean;
  value: unknown | null;
  raw: string | null;
  version: number | null;
}

/** The effective configuration for a key at a scope + time. */
export interface EffectiveConfig {
  key: string;
  valueType: ValueType;
  value: unknown; // parsed, typed (null when UNSET and no default)
  raw: string | null;
  source: ResolutionSource;
  sourceId: string | null;
  version: number | null;
  /** The next level down that ALSO had a value (what it would fall back to). */
  inheritedFrom: ResolutionSource | null;
  atTime: string; // ISO
  /** Full chain, most specific → system, for the explainer / UI. */
  chain: ChainEntry[];
}

export class ConfigError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** JSON depth/size/array bound check + a re-export shim of the D6 sensitive guard. */
export function assertJsonBounds(value: unknown, depth = 1): void {
  if (depth > CONFIG_LIMITS.MAX_JSON_DEPTH) throw new ConfigError(`JSON config exceeds max depth ${CONFIG_LIMITS.MAX_JSON_DEPTH}.`);
  if (Array.isArray(value)) {
    if (value.length > CONFIG_LIMITS.MAX_ARRAY) throw new ConfigError(`JSON array exceeds ${CONFIG_LIMITS.MAX_ARRAY} items.`);
    value.forEach((v) => assertJsonBounds(v, depth + 1));
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) assertJsonBounds(v, depth + 1);
  }
}

export const escalationSchema = z
  .object({
    steps: z
      .array(
        z.object({
          afterSeconds: z.number().int().positive().max(CONFIG_LIMITS.MAX_DURATION_SECONDS),
          notifyRole: z.string().min(1).max(80),
          priority: z.enum(["ROUTINE", "URGENT", "STAT"]).optional(),
          intent: z.string().max(200).optional(),
        }).strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

export const formSchema = z
  .object({
    fields: z
      .array(
        z.object({
          key: z.string().min(1).max(80).regex(/^[a-z0-9_.-]+$/i),
          label: z.string().min(1).max(200),
          type: z.enum(["TEXT", "NUMBER", "BOOLEAN", "DATE", "SELECT", "TEXTAREA"]),
          required: z.boolean().optional(),
          order: z.number().int().min(0).max(1000).optional(),
          options: z.array(z.string().max(120)).max(50).optional(),
          sensitivity: z.enum(["LOW", "INTERNAL"]).optional(),
        }).strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
