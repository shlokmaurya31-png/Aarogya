import { resolveEffectiveInternal } from "@/lib/config";
import type { Threshold } from "./types";

/**
 * Phase D10 — Command Center interpretation thresholds.
 *
 * Thresholds change only how a metric's STATUS is interpreted per hospital; they never
 * change the canonical computed number (§24/§25). Each configurable metric has a system
 * default which a hospital may override via the D8 configuration engine
 * (`commandCenter.<metric>.warning|.critical`), tenant-aware and versioned. Resolution
 * is server-internal (tenant already established by the caller's D1 context).
 */

interface Default {
  warning: number;
  critical: number;
  direction: "HIGHER_WORSE" | "LOWER_WORSE";
  unit: string;
}

export const THRESHOLD_DEFAULTS: Record<string, Default> = {
  bedOccupancy: { warning: 85, critical: 95, direction: "HIGHER_WORSE", unit: "%" },
  icuOccupancy: { warning: 80, critical: 90, direction: "HIGHER_WORSE", unit: "%" },
  edWaiting: { warning: 10, critical: 20, direction: "HIGHER_WORSE", unit: "patients" },
  edLongestWait: { warning: 60, critical: 120, direction: "HIGHER_WORSE", unit: "min" },
  labTat: { warning: 240, critical: 480, direction: "HIGHER_WORSE", unit: "min" },
  radiologyTat: { warning: 480, critical: 720, direction: "HIGHER_WORSE", unit: "min" },
  otDelayed: { warning: 1, critical: 3, direction: "HIGHER_WORSE", unit: "cases" },
  dischargeBlocked: { warning: 5, critical: 15, direction: "HIGHER_WORSE", unit: "patients" },
  criticalResultsPending: { warning: 1, critical: 3, direction: "HIGHER_WORSE", unit: "results" },
  staffingGaps: { warning: 1, critical: 3, direction: "HIGHER_WORSE", unit: "shifts" },
  pharmacyBacklog: { warning: 10, critical: 25, direction: "HIGHER_WORSE", unit: "orders" },
  claimsExceptions: { warning: 5, critical: 15, direction: "HIGHER_WORSE", unit: "claims" },
  infectionActive: { warning: 1, critical: 5, direction: "HIGHER_WORSE", unit: "incidents" },
  incidentsHigh: { warning: 1, critical: 3, direction: "HIGHER_WORSE", unit: "incidents" },
};

export type ThresholdMap = Record<string, Threshold>;

export interface ThresholdScope {
  organizationId: string;
  facilityId: string;
  departmentId?: string | null;
}

async function resolveOne(scope: ThresholdScope, metric: string, def: Default): Promise<Threshold> {
  const read = async (kind: "warning" | "critical", fallback: number) => {
    const eff = await resolveEffectiveInternal({
      key: `commandCenter.${metric}.${kind}`,
      organizationId: scope.organizationId,
      facilityId: scope.facilityId ?? null,
      departmentId: scope.departmentId ?? null,
      fallbackRaw: String(fallback),
    });
    return { value: typeof eff.value === "number" ? eff.value : fallback, overridden: eff.source !== "SYSTEM" };
  };
  const [w, c] = await Promise.all([read("warning", def.warning), read("critical", def.critical)]);
  return { warning: w.value, critical: c.value, direction: def.direction, unit: def.unit, source: w.overridden || c.overridden ? "D8_CONFIG" : "DEFAULT" };
}

/** Resolve all configurable Command Center thresholds for a scope, in parallel. */
export async function buildThresholds(scope: ThresholdScope): Promise<ThresholdMap> {
  const entries = await Promise.all(
    Object.entries(THRESHOLD_DEFAULTS).map(async ([metric, def]) => [metric, await resolveOne(scope, metric, def)] as const),
  );
  return Object.fromEntries(entries);
}
