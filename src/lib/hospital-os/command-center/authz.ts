import type { SessionPayload } from "@/lib/auth/session";
import { roleHasPermission, type Permission } from "@/lib/auth/permissions";

type Session = SessionPayload;
import type { TimeWindow } from "./filters";
import type { ThresholdMap } from "./thresholds";
import { getDiagnosticsOperationalCounts } from "@/lib/hospital/diagnosticsSnapshot";

/**
 * Phase D10 — Command Center authorization + context.
 *
 * Tenant scope is resolved by the route via D1 `requireFacilityStaff` (the server-side
 * chokepoint — client facility/org/dept is never authoritative). The base gate is
 * `hospital:command-center:view`. Financial and incident sections require an ADDITIONAL
 * permission; a caller lacking it sees those sections as RESTRICTED (omitted), never as
 * an error, and never as fabricated zeros. C4 remains authoritative; the Command Center
 * grants nothing.
 */

export interface CommandContext {
  session: Session;
  organizationId: string;
  facilityId: string;
  departmentId: string | null;
  window: TimeWindow;
  thresholds: ThresholdMap;
  now: Date;
  /** The facility's time zone (Flagship 2a): "today" is its day. */
  timeZone: string;
}

/**
 * Flagship 1c: the diagnostics snapshot once per command-centre request (the
 * laboratory and radiology sections both read it; it was computed twice).
 */
const diagnosticsByContext = new WeakMap<CommandContext, ReturnType<typeof getDiagnosticsOperationalCounts>>();
export function diagnosticsFor(ctx: CommandContext): ReturnType<typeof getDiagnosticsOperationalCounts> {
  let p = diagnosticsByContext.get(ctx);
  if (!p) diagnosticsByContext.set(ctx, (p = getDiagnosticsOperationalCounts(ctx.facilityId)));
  return p;
}

export const BASE_PERMISSION: Permission = "hospital:command-center:view";

/** Extra permission required to VIEW a section beyond the base gate. */
const SECTION_PERMISSION: Record<string, Permission> = {
  revenue: "billing:view",
  claims: "billing:view",
  incidents: "quality:incident:read",
};

export const ALL_SECTIONS = [
  "capacity", "emergency", "icu", "ot", "laboratory", "radiology", "discharge",
  "criticalResults", "staffing", "pharmacy", "revenue", "claims", "infection", "incidents",
] as const;
export type SectionKey = (typeof ALL_SECTIONS)[number];

/** Whether the caller's role may see a section (base gate already passed). */
export function canSeeSection(session: Session, section: SectionKey): boolean {
  const extra = SECTION_PERMISSION[section];
  if (!extra) return true;
  return roleHasPermission(session.role, extra);
}

/** Whether the caller may see patient-level clinical detail in drill-downs. */
export function canSeeClinicalDetail(session: Session): boolean {
  return roleHasPermission(session.role, "clinical:chart:read") || roleHasPermission(session.role, "encounter:read");
}
