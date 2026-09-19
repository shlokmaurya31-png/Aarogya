import type { FacilityContext } from "@/lib/auth/hospitalRbac";
import { buildThresholds } from "./thresholds";
import { resolveWindow, type TimeWindow } from "./filters";
import { canSeeSection, type CommandContext, type SectionKey } from "./authz";
import { worstStatus, type AttentionItem, type CommandCenterOverview, type CommandSection } from "./types";
import { getCapacity } from "./capacity";
import { getEmergency } from "./emergency";
import { getIcu } from "./icu";
import { getOt } from "./ot";
import { getLaboratory } from "./laboratory";
import { getRadiology } from "./radiology";
import { getDischarge } from "./discharge";
import { getCriticalResults } from "./criticalResults";
import { getStaffing } from "./staffing";
import { getPharmacy } from "./pharmacy";
import { getRevenue } from "./revenue";
import { getClaims } from "./claims";
import { getInfection } from "./infection";
import { getIncidents } from "./incidents";

/**
 * Phase D10 — the Command Center orchestrator. Runs every AUTHORIZED section in
 * parallel with per-section ERROR ISOLATION (a failed subsystem yields an explicit
 * UNAVAILABLE section, never a misleading 0), builds a deterministic attention queue
 * from metric statuses, and rolls up an overall status. Sections the caller may not see
 * are surfaced as `restrictedSections` (not errors, not fabricated).
 */

const RUNNERS: Record<SectionKey, (ctx: CommandContext) => Promise<CommandSection>> = {
  capacity: getCapacity, emergency: getEmergency, icu: getIcu, ot: getOt,
  laboratory: getLaboratory, radiology: getRadiology, discharge: getDischarge,
  criticalResults: getCriticalResults, staffing: getStaffing, pharmacy: getPharmacy,
  revenue: getRevenue, claims: getClaims, infection: getInfection, incidents: getIncidents,
};

const LABELS: Record<SectionKey, string> = {
  capacity: "Bed capacity", emergency: "ED pressure", icu: "ICU capacity", ot: "Operating theatre",
  laboratory: "Lab TAT", radiology: "Radiology TAT", discharge: "Discharge bottlenecks",
  criticalResults: "Critical results", staffing: "Staffing", pharmacy: "Pharmacy",
  revenue: "Revenue", claims: "Claims", infection: "Infection control", incidents: "Incidents",
};

async function safe(ctx: CommandContext, key: SectionKey, run: (c: CommandContext) => Promise<CommandSection>): Promise<CommandSection> {
  try {
    return await run(ctx);
  } catch (err) {
    // §37 — a failed subsystem is explicitly UNAVAILABLE, never a fabricated 0.
    return { key, label: LABELS[key], status: "UNAVAILABLE", asOf: ctx.now.toISOString(), metrics: [], drivers: [], drillDown: null, unavailable: { reason: err instanceof Error ? err.message.slice(0, 200) : "unavailable" } };
  }
}

function buildAttention(sections: CommandSection[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const s of sections) {
    for (const m of s.metrics) {
      if (m.status !== "CRITICAL" && m.status !== "WARNING" && m.status !== "WATCH") continue;
      const t = m.threshold;
      const reason = t && t.warning !== null
        ? `${m.value}${m.unit} vs ${m.status === "CRITICAL" ? t.critical : t.warning}${m.unit} threshold (${t.source === "D8_CONFIG" ? "configured" : "default"})`
        : m.explanation || `${m.value}${m.unit}`;
      items.push({ key: `${s.key}.${m.key}`, severity: m.status, title: `${s.label}: ${m.label}`, reason, source: m.source, asOf: s.asOf, drillDown: s.drillDown });
    }
  }
  const rank = { CRITICAL: 0, WARNING: 1, WATCH: 2 } as const;
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 25);
}

export interface OverviewOptions {
  window?: string | null;
  from?: string | null;
  to?: string | null;
  departmentId?: string | null;
  sections?: SectionKey[]; // optional subset (still authorized)
}

export async function getCommandCenterOverview(fctx: FacilityContext, opts: OverviewOptions = {}): Promise<CommandCenterOverview> {
  const now = new Date();
  const window: TimeWindow = resolveWindow(opts.window, opts.from, opts.to, now);
  const thresholds = await buildThresholds({ organizationId: fctx.organizationId, facilityId: fctx.facilityId, departmentId: opts.departmentId ?? null });
  const ctx: CommandContext = { session: fctx.session, organizationId: fctx.organizationId, facilityId: fctx.facilityId, departmentId: opts.departmentId ?? null, window, thresholds, now };

  const wanted = (opts.sections && opts.sections.length ? opts.sections : (Object.keys(RUNNERS) as SectionKey[]));
  const authorized: SectionKey[] = [];
  const restricted: string[] = [];
  for (const key of wanted) {
    if (canSeeSection(fctx.session, key)) authorized.push(key);
    else restricted.push(key);
  }

  const sections = await Promise.all(authorized.map((key) => safe(ctx, key, RUNNERS[key])));
  const attention = buildAttention(sections);
  const overallStatus = worstStatus(...sections.map((s) => s.status));

  return {
    facilityId: fctx.facilityId,
    organizationId: fctx.organizationId,
    departmentId: opts.departmentId ?? null,
    window: { key: window.key, from: window.from.toISOString(), to: window.to.toISOString(), label: window.label },
    asOf: now.toISOString(),
    overallStatus,
    sections,
    attention,
    restrictedSections: restricted,
  };
}

/** Run a single authorized section (for per-section routes). */
export async function getCommandCenterSection(fctx: FacilityContext, key: SectionKey, opts: OverviewOptions = {}): Promise<CommandSection> {
  const now = new Date();
  if (!canSeeSection(fctx.session, key)) {
    return { key, label: LABELS[key], status: "UNAVAILABLE", asOf: now.toISOString(), metrics: [], drivers: [], drillDown: null, unavailable: { reason: "restricted" } };
  }
  const window = resolveWindow(opts.window, opts.from, opts.to, now);
  const thresholds = await buildThresholds({ organizationId: fctx.organizationId, facilityId: fctx.facilityId, departmentId: opts.departmentId ?? null });
  const ctx: CommandContext = { session: fctx.session, organizationId: fctx.organizationId, facilityId: fctx.facilityId, departmentId: opts.departmentId ?? null, window, thresholds, now };
  return safe(ctx, key, RUNNERS[key]);
}
