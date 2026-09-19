/**
 * Phase D10 — Hospital Command Center 2.0 shared contract.
 *
 * The Command Center is a READ / intelligence layer over canonical domain truth. It
 * never owns state and performs no clinical/financial mutation. Every metric is
 * semantically complete: it answers what/how-much/normal?/why/driven-by/inspect-next/
 * when/source. A failed subsystem yields an explicit UNAVAILABLE (never a misleading 0).
 */

export const CC_STATUS = ["NORMAL", "WATCH", "WARNING", "CRITICAL", "UNKNOWN", "UNAVAILABLE"] as const;
export type CcStatus = (typeof CC_STATUS)[number];

/** How a metric relates to time — never compare incompatible periods. */
export type TimeSemantics = "POINT_IN_TIME" | "CURRENT_STATE" | "ROLLING" | "PERIOD_AGGREGATE" | "DERIVED_RATE";

/** The provenance strength of a WHY driver — correlation is never causation. */
export type DriverKind = "DIRECT" | "CONTRIBUTING" | "CORRELATION" | "UNAVAILABLE";

export interface Driver {
  label: string;
  value: number | string;
  kind: DriverKind;
  /** Optional bounded drill-down for this specific driver. */
  drillDown?: string;
}

export interface Threshold {
  warning: number | null;
  critical: number | null;
  /** Whether higher values are worse (occupancy) or lower are worse. */
  direction: "HIGHER_WORSE" | "LOWER_WORSE";
  unit: string;
  /** Where the threshold came from (D8 override vs system default). */
  source: "D8_CONFIG" | "DEFAULT";
}

export interface Metric {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  status: CcStatus;
  timeSemantics: TimeSemantics;
  threshold?: Threshold;
  /** Comparison against a prior period, where meaningful (bounded, never fabricated). */
  comparison?: { previous: number; delta: number; deltaLabel: string } | null;
  explanation: string;
  /** Canonical source table(s) that produced the value. */
  source: string;
  confidence: "OBSERVED" | "DERIVED";
}

export interface CommandSection {
  key: string;
  label: string;
  status: CcStatus;
  asOf: string; // ISO
  metrics: Metric[];
  /** The WHY layer: deterministic drivers backed by canonical data. */
  drivers: Driver[];
  /** Bounded drill-down entry point for this section. */
  drillDown: string | null;
  /** Present when the section could not be computed (error isolation, §37). */
  unavailable?: { reason: string };
}

export type AttentionSeverity = "CRITICAL" | "WARNING" | "WATCH";

export interface AttentionItem {
  key: string;
  severity: AttentionSeverity;
  title: string;
  reason: string;
  source: string;
  asOf: string;
  drillDown?: string | null;
  /** An existing authorized action a user MAY invoke (never auto-invoked). */
  action?: { label: string; route: string } | null;
}

export interface CommandCenterOverview {
  facilityId: string;
  organizationId: string;
  departmentId: string | null;
  window: { key: string; from: string; to: string; label: string };
  asOf: string;
  overallStatus: CcStatus;
  sections: CommandSection[];
  attention: AttentionItem[];
  /** Sections the caller is not authorized to see (surfaced as restricted, not errors). */
  restrictedSections: string[];
}

const RANK: Record<CcStatus, number> = { NORMAL: 0, UNKNOWN: 1, UNAVAILABLE: 1, WATCH: 2, WARNING: 3, CRITICAL: 4 };
/** The worst status among inputs (UNAVAILABLE does not mask a real CRITICAL elsewhere). */
export function worstStatus(...statuses: CcStatus[]): CcStatus {
  return statuses.reduce<CcStatus>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "NORMAL");
}

/** Map a value to a status against a threshold (higher/lower-worse aware). */
export function statusFromThreshold(value: number | null, t?: Threshold): CcStatus {
  if (value === null || !t || (t.warning === null && t.critical === null)) return value === null ? "UNKNOWN" : "NORMAL";
  const worseThan = (v: number, limit: number) => (t.direction === "HIGHER_WORSE" ? v >= limit : v <= limit);
  if (t.critical !== null && worseThan(value, t.critical)) return "CRITICAL";
  if (t.warning !== null && worseThan(value, t.warning)) return "WARNING";
  return "NORMAL";
}
