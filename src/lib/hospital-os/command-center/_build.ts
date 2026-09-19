import type { CommandContext } from "./authz";
import { statusFromThreshold, worstStatus, type CommandSection, type Metric, type Driver, type CcStatus, type TimeSemantics, type Threshold } from "./types";

/**
 * Phase D10 — small builders shared by the domain metric modules. They keep each
 * section terse and consistent (status derivation, asOf stamping, section rollup).
 */

export function metric(input: {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  timeSemantics: TimeSemantics;
  explanation?: string;
  source: string;
  confidence?: "OBSERVED" | "DERIVED";
  threshold?: Threshold;
  status?: CcStatus;
  comparison?: Metric["comparison"];
}): Metric {
  const status = input.status ?? statusFromThreshold(input.value, input.threshold);
  return {
    key: input.key, label: input.label, value: input.value, unit: input.unit,
    status, timeSemantics: input.timeSemantics, threshold: input.threshold,
    comparison: input.comparison ?? null, explanation: input.explanation ?? "",
    source: input.source, confidence: input.confidence ?? "OBSERVED",
  };
}

export function driver(label: string, value: number | string, kind: Driver["kind"] = "DIRECT", drillDown?: string): Driver {
  return { label, value, kind, drillDown };
}

export function section(ctx: CommandContext, input: { key: string; label: string; metrics: Metric[]; drivers: Driver[]; drillDown?: string | null }): CommandSection {
  return {
    key: input.key, label: input.label,
    status: worstStatus(...input.metrics.map((m) => m.status)),
    asOf: ctx.now.toISOString(),
    metrics: input.metrics, drivers: input.drivers,
    drillDown: input.drillDown ?? null,
  };
}

/** A bounded percentage helper (0..100, integer), null-safe. */
export function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}
