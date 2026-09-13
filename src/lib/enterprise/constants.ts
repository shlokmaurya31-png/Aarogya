import type { OrganizationStatus, FacilityStatus } from "@prisma/client";

/**
 * Phase D1 — enterprise lifecycle and configuration constants.
 *
 * Lifecycle transitions are declared here as an explicit allow-list. A
 * transition that is not listed is refused. Reactivating a DEACTIVATED tenant
 * is deliberately marked platform-only: deactivation is the end state for a
 * tenant, and bringing one back is a support/recovery action, not something an
 * organization or facility administrator does casually (brief §15).
 */

export interface Transition<S extends string> {
  from: S;
  to: S;
  /** Only the platform administrator may perform this transition. */
  platformOnly?: boolean;
}

export const ORGANIZATION_TRANSITIONS: Transition<OrganizationStatus>[] = [
  { from: "ACTIVE", to: "SUSPENDED" },
  { from: "SUSPENDED", to: "ACTIVE" },
  { from: "ACTIVE", to: "DEACTIVATED" },
  { from: "SUSPENDED", to: "DEACTIVATED" },
  // Recovery from the end state is platform-only and never casual.
  { from: "DEACTIVATED", to: "ACTIVE", platformOnly: true },
];

export const FACILITY_TRANSITIONS: Transition<FacilityStatus>[] = [
  { from: "PROVISIONING", to: "ACTIVE" },
  { from: "PROVISIONING", to: "DEACTIVATED" },
  { from: "ACTIVE", to: "SUSPENDED" },
  { from: "SUSPENDED", to: "ACTIVE" },
  { from: "ACTIVE", to: "DEACTIVATED" },
  { from: "SUSPENDED", to: "DEACTIVATED" },
  { from: "DEACTIVATED", to: "ACTIVE", platformOnly: true },
];

export function findOrganizationTransition(from: OrganizationStatus, to: OrganizationStatus) {
  return ORGANIZATION_TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

export function findFacilityTransition(from: FacilityStatus, to: FacilityStatus) {
  return FACILITY_TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

/**
 * The known configuration keys. Configuration is a deliberately SMALL,
 * closed registry — not a generic settings engine (brief §13). Each key has a
 * hard-coded default that sits at the bottom of the resolution chain
 * (department → facility → organization → default), so a value always
 * resolves even with no override anywhere. Adding a setting is adding one entry
 * here; storing an unknown key is refused.
 */
export const CONFIG_KEYS = {
  "appointment.defaultDurationMinutes": {
    default: "15",
    description: "Default appointment slot length, in minutes.",
  },
  "appointment.maxAdvanceDays": {
    default: "90",
    description: "How many days ahead an appointment may be booked.",
  },
  "billing.currency": {
    default: "INR",
    description: "ISO currency code used for billing at this tenant.",
  },
} as const;

export type ConfigKey = keyof typeof CONFIG_KEYS;

export function isKnownConfigKey(key: string): key is ConfigKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_KEYS, key);
}

export const CONFIG_SCOPES = ["department", "facility", "organization", "default"] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];
