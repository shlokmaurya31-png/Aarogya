import { z } from "zod";
import { LIMITS, type WorkflowContext } from "./types";

/**
 * Phase D7 — SAFE declarative condition system (§6/§7).
 *
 * Conditions are structured data, never code. They can inspect ONLY the
 * allow-listed WorkflowContext (`event.*` and `payload.*`) and are evaluated in
 * memory against that context — values are never interpolated into SQL or any
 * query, so injection through condition values is structurally impossible. The
 * operator set is deliberately small and the grammar is not Turing-complete.
 */

export const OPERATORS = [
  "equals", "not_equals", "in", "not_in", "exists", "not_exists",
  "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal", "contains",
] as const;
export type Operator = (typeof OPERATORS)[number];

// A leaf compares one allow-listed field to a literal (or list, for in/not_in).
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const LeafSchema = z.object({
  field: z.string().min(1).max(120),
  operator: z.enum(OPERATORS),
  value: z.union([scalar, z.array(scalar).max(LIMITS.MAX_IN_VALUES)]).optional(),
}).strict();

// Bounded recursive grammar: all / any / not / leaf, capped at MAX_CONDITION_DEPTH.
export type ConditionNode =
  | z.infer<typeof LeafSchema>
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { not: ConditionNode };

export const ConditionSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    LeafSchema,
    z.object({ all: z.array(ConditionSchema).min(1).max(LIMITS.MAX_CONDITION_NODES) }).strict(),
    z.object({ any: z.array(ConditionSchema).min(1).max(LIMITS.MAX_CONDITION_NODES) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
  ]),
);

/** Reject dangerous keys and cap depth/node-count before a condition is trusted. */
export function assertConditionBounds(node: ConditionNode, depth = 1, counter = { n: 0 }): void {
  if (depth > LIMITS.MAX_CONDITION_DEPTH) throw new Error(`Condition nesting exceeds ${LIMITS.MAX_CONDITION_DEPTH}.`);
  if (++counter.n > LIMITS.MAX_CONDITION_NODES) throw new Error(`Condition has too many nodes (>${LIMITS.MAX_CONDITION_NODES}).`);
  if ("all" in node) node.all.forEach((c) => assertConditionBounds(c, depth + 1, counter));
  else if ("any" in node) node.any.forEach((c) => assertConditionBounds(c, depth + 1, counter));
  else if ("not" in node) assertConditionBounds(node.not, depth + 1, counter);
  else assertFieldPathSafe(node.field);
}

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** A field must address only the allow-listed `event.*` / `payload.*` roots. */
export function assertFieldPathSafe(field: string): void {
  const parts = field.split(".");
  if (parts[0] !== "event" && parts[0] !== "payload") {
    throw new Error(`Condition field "${field}" must start with event. or payload.`);
  }
  for (const p of parts) {
    if (!p || FORBIDDEN_SEGMENTS.has(p)) throw new Error(`Illegal field segment in "${field}".`);
  }
}

/** Resolve a dot-path against the context, walking only plain-object own keys. */
function resolve(ctx: WorkflowContext, field: string): unknown {
  const parts = field.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (FORBIDDEN_SEGMENTS.has(p)) return undefined;
    if (cur === null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function evalLeaf(ctx: WorkflowContext, leaf: z.infer<typeof LeafSchema>): boolean {
  const actual = resolve(ctx, leaf.field);
  const value = leaf.value;
  switch (leaf.operator) {
    case "exists": return actual !== undefined && actual !== null;
    case "not_exists": return actual === undefined || actual === null;
    case "equals": return actual === value;
    case "not_equals": return actual !== value;
    case "in": return Array.isArray(value) && value.some((v) => v === actual);
    case "not_in": return Array.isArray(value) && !value.some((v) => v === actual);
    case "contains":
      if (typeof actual === "string" && typeof value === "string") return actual.includes(value);
      if (Array.isArray(actual)) return actual.some((v) => v === value);
      return false;
    case "greater_than": { const a = asNumber(actual), b = asNumber(value); return a !== null && b !== null && a > b; }
    case "greater_than_or_equal": { const a = asNumber(actual), b = asNumber(value); return a !== null && b !== null && a >= b; }
    case "less_than": { const a = asNumber(actual), b = asNumber(value); return a !== null && b !== null && a < b; }
    case "less_than_or_equal": { const a = asNumber(actual), b = asNumber(value); return a !== null && b !== null && a <= b; }
    default: return false;
  }
}

/** Evaluate a condition against the allow-listed context. Pure, total, side-effect-free. */
export function evaluateCondition(ctx: WorkflowContext, node: ConditionNode): boolean {
  if ("all" in node) return node.all.every((c) => evaluateCondition(ctx, c));
  if ("any" in node) return node.any.some((c) => evaluateCondition(ctx, c));
  if ("not" in node) return !evaluateCondition(ctx, node.not);
  return evalLeaf(ctx, node);
}
