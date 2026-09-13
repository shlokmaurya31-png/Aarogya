import type { EntitlementType, EntitlementScope } from "@prisma/client";

/**
 * Phase D2 — the controlled entitlement registry and plan catalogue.
 *
 * This is the single source of truth for WHICH capabilities/limits exist and
 * WHAT each plan grants. It is CODE, not data a tenant can edit: an organization
 * administrator can never define an entitlement or invent a plan. The bootstrap
 * (src/lib/commercial/bootstrap.ts) materialises this registry into the
 * EntitlementDefinition / SubscriptionPlan / PlanEntitlement tables idempotently.
 *
 * Keys map to the ACTUAL Aarogya feature surface (Hospital OS modules, the India
 * interoperability integrations, and the enterprise control plane) plus the two
 * limits D2 enforces server-side. It is deliberately small — a controlled
 * registry, not 200 speculative flags.
 */

export interface EntitlementSpec {
  key: string;
  name: string;
  description: string;
  type: EntitlementType;
  scope: EntitlementScope;
  /** Safe default when neither a subscription snapshot nor an override supplies a value. */
  defaultBool?: boolean;
  defaultNumber?: number;
  defaultUnlimited?: boolean;
}

export const ENTITLEMENTS: EntitlementSpec[] = [
  // ── Core product (organization-wide) ──────────────────────────────────────
  { key: "hospital_os", name: "Hospital OS", description: "The core Hospital OS product.", type: "BOOLEAN", scope: "ORGANIZATION", defaultBool: false },
  { key: "enterprise_control_plane", name: "Enterprise control plane", description: "Multi-facility enterprise administration.", type: "BOOLEAN", scope: "ORGANIZATION", defaultBool: false },

  // ── India interoperability (organization-wide integrations) ───────────────
  { key: "interoperability_abdm", name: "ABDM / FHIR interoperability", description: "ABDM and FHIR health information exchange.", type: "BOOLEAN", scope: "ORGANIZATION", defaultBool: false },
  { key: "nhcx_claims", name: "NHCX claims exchange", description: "NHCX digital insurance claims exchange.", type: "BOOLEAN", scope: "ORGANIZATION", defaultBool: false },

  // ── Facility-scoped clinical modules ──────────────────────────────────────
  { key: "advanced_pharmacy", name: "Advanced pharmacy", description: "Enterprise pharmacy & medication supply chain.", type: "BOOLEAN", scope: "FACILITY", defaultBool: false },
  { key: "advanced_diagnostics", name: "Advanced diagnostics", description: "LIS quality management & PACS boundary.", type: "BOOLEAN", scope: "FACILITY", defaultBool: false },
  { key: "icu", name: "ICU", description: "Intensive care unit module.", type: "BOOLEAN", scope: "FACILITY", defaultBool: false },
  { key: "operating_theatre", name: "Operating theatre", description: "Operating theatre & surgical workflow.", type: "BOOLEAN", scope: "FACILITY", defaultBool: false },
  { key: "blood_bank", name: "Blood bank", description: "Blood bank & transfusion management.", type: "BOOLEAN", scope: "FACILITY", defaultBool: false },
  { key: "emergency_department", name: "Emergency department", description: "Emergency department module.", type: "BOOLEAN", scope: "FACILITY", defaultBool: false },
  { key: "inventory_procurement", name: "Inventory & procurement", description: "Enterprise inventory & procurement.", type: "BOOLEAN", scope: "FACILITY", defaultBool: false },
  { key: "quality_workforce", name: "Quality & workforce", description: "Quality, patient safety, workforce & credentialing.", type: "BOOLEAN", scope: "FACILITY", defaultBool: false },

  // ── Limits (organization-wide, enforced server-side) ──────────────────────
  { key: "max_facilities", name: "Maximum facilities", description: "How many active facilities the organization may operate.", type: "LIMIT", scope: "ORGANIZATION", defaultNumber: 1 },
  { key: "max_users", name: "Maximum users", description: "How many members the organization may have.", type: "LIMIT", scope: "ORGANIZATION", defaultNumber: 10 },
];

export const ENTITLEMENT_KEYS = ENTITLEMENTS.map((e) => e.key);
export function isKnownEntitlement(key: string): boolean {
  return ENTITLEMENT_KEYS.includes(key);
}
export function getEntitlementSpec(key: string): EntitlementSpec | undefined {
  return ENTITLEMENTS.find((e) => e.key === key);
}

/** A plan's value for one entitlement. `unlimited` applies to LIMIT entitlements. */
export interface PlanEntitlementSpec {
  key: string;
  bool?: boolean;
  number?: number;
  unlimited?: boolean;
}

export interface PlanSpec {
  code: string;
  name: string;
  description: string;
  billingInterval: "MONTHLY" | "QUARTERLY" | "YEARLY" | "NONE";
  isDefault?: boolean;
  entitlements: PlanEntitlementSpec[];
}

const ALL_MODULES_TRUE: PlanEntitlementSpec[] = [
  { key: "hospital_os", bool: true },
  { key: "enterprise_control_plane", bool: true },
  { key: "interoperability_abdm", bool: true },
  { key: "nhcx_claims", bool: true },
  { key: "advanced_pharmacy", bool: true },
  { key: "advanced_diagnostics", bool: true },
  { key: "icu", bool: true },
  { key: "operating_theatre", bool: true },
  { key: "blood_bank", bool: true },
  { key: "emergency_department", bool: true },
  { key: "inventory_procurement", bool: true },
  { key: "quality_workforce", bool: true },
];

export const PLANS: PlanSpec[] = [
  {
    code: "starter",
    name: "Starter",
    description: "A single facility with the core Hospital OS.",
    billingInterval: "MONTHLY",
    entitlements: [
      { key: "hospital_os", bool: true },
      { key: "enterprise_control_plane", bool: false },
      { key: "interoperability_abdm", bool: false },
      { key: "nhcx_claims", bool: false },
      { key: "advanced_pharmacy", bool: false },
      { key: "advanced_diagnostics", bool: false },
      { key: "icu", bool: false },
      { key: "operating_theatre", bool: false },
      { key: "blood_bank", bool: false },
      { key: "emergency_department", bool: false },
      { key: "inventory_procurement", bool: false },
      { key: "quality_workforce", bool: false },
      { key: "max_facilities", number: 1 },
      { key: "max_users", number: 25 },
    ],
  },
  {
    code: "professional",
    name: "Professional",
    description: "A multi-facility hospital group with clinical depth and ABDM.",
    billingInterval: "MONTHLY",
    entitlements: [
      { key: "hospital_os", bool: true },
      { key: "enterprise_control_plane", bool: true },
      { key: "interoperability_abdm", bool: true },
      { key: "nhcx_claims", bool: false },
      { key: "advanced_pharmacy", bool: true },
      { key: "advanced_diagnostics", bool: true },
      { key: "icu", bool: true },
      { key: "operating_theatre", bool: true },
      { key: "blood_bank", bool: true },
      { key: "emergency_department", bool: true },
      { key: "inventory_procurement", bool: true },
      { key: "quality_workforce", bool: true },
      { key: "max_facilities", number: 5 },
      { key: "max_users", number: 500 },
    ],
  },
  {
    code: "enterprise",
    name: "Enterprise",
    description: "An unlimited multi-facility enterprise with the full integration surface.",
    billingInterval: "YEARLY",
    entitlements: [
      ...ALL_MODULES_TRUE,
      { key: "max_facilities", unlimited: true },
      { key: "max_users", unlimited: true },
    ],
  },
  {
    // The internal grandfather / development default. NOT a sold contract — it is
    // assigned by the bootstrap to organizations that predate D2 so they keep
    // functioning exactly as they did, and is flagged isDefault everywhere.
    code: "aarogya-default",
    name: "Aarogya default (grandfather)",
    description: "Internal default that preserves pre-D2 access. Not a commercial contract.",
    billingInterval: "NONE",
    isDefault: true,
    entitlements: [
      ...ALL_MODULES_TRUE,
      { key: "max_facilities", unlimited: true },
      { key: "max_users", unlimited: true },
    ],
  },
];

export const DEFAULT_PLAN_CODE = "aarogya-default";

export function getPlanSpec(code: string): PlanSpec | undefined {
  return PLANS.find((p) => p.code === code);
}
