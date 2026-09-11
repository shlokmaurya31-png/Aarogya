import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import type { Prisma } from "@prisma/client";

/**
 * Phase C1 — shared vocabulary, state machines and facility guards for the
 * interoperability boundary.
 *
 * Everything here is deliberately documentary and closed-set. The canonical
 * clinical domain remains authoritative: nothing in this layer writes a clinical
 * fact, and nothing in it may be reached without the caller already having
 * passed RBAC and facility isolation.
 */

export type Tx = Prisma.TransactionClient;
export type Db = Tx | typeof prisma;

// ── Entities that can carry an external registry identifier ──────────────────
export const EXTERNAL_ENTITY_TYPES = [
  "PATIENT", "FACILITY", "STAFF", "ENCOUNTER", "ORGANIZATION", "DOCUMENT",
] as const;
export type ExternalEntityType = (typeof EXTERNAL_ENTITY_TYPES)[number];

/**
 * Canonical identifier systems. ABHA is the national health identifier for a
 * PATIENT, HFR for a FACILITY, HPR for a STAFF member — each is a MAPPING onto
 * the canonical record, never a replacement for its primary key.
 *
 * System URIs follow the ABDM FHIR Implementation Guide (NRCeS, FHIR R4).
 */
export const IDENTIFIER_SYSTEMS = {
  ABHA_NUMBER: "https://healthid.abdm.gov.in",
  ABHA_ADDRESS: "https://healthid.abdm.gov.in/address",
  HFR: "https://facility.abdm.gov.in",
  HPR: "https://hpr.abdm.gov.in",
  LOCAL_UHID: "https://aarogya.local/uhid",
  LOCAL_MRN: "https://aarogya.local/mrn",
} as const;

/** Which entity type each known system is allowed to identify. */
const SYSTEM_ENTITY_RULES: Record<string, ExternalEntityType> = {
  [IDENTIFIER_SYSTEMS.ABHA_NUMBER]: "PATIENT",
  [IDENTIFIER_SYSTEMS.ABHA_ADDRESS]: "PATIENT",
  [IDENTIFIER_SYSTEMS.HFR]: "FACILITY",
  [IDENTIFIER_SYSTEMS.HPR]: "STAFF",
};

export const IDENTIFIER_STATUSES = ["ACTIVE", "SUPERSEDED", "REVOKED", "INVALID"] as const;
export const VERIFICATION_STATUSES = ["UNVERIFIED", "VERIFIED", "FAILED"] as const;

// ── Consent ─────────────────────────────────────────────────────────────────
export const CONSENT_PURPOSES = [
  "TREATMENT", "REFERRAL", "SECOND_OPINION", "INSURANCE", "PATIENT_ACCESS", "RESEARCH", "OTHER",
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_SCOPES = [
  "ALL_CLINICAL", "DIAGNOSIS", "LAB", "IMAGING", "MEDICATION",
  "DOCUMENTS", "ENCOUNTER", "ALLERGY", "VITALS", "CARE_PLAN", "BILLING",
] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export const CONSENT_RECIPIENT_TYPES = [
  "FACILITY", "ORGANIZATION", "PRACTITIONER", "PATIENT", "EXTERNAL_SYSTEM",
] as const;

/**
 * REQUESTED -> GRANTED -> ACTIVE -> EXPIRED, with DECLINED/CANCELLED/REVOKED as
 * terminal branches. REVOKED is reachable from any live state because a patient
 * may withdraw consent at any moment; nothing may transition OUT of it.
 */
export const CONSENT_TRANSITIONS: Record<string, string[]> = {
  REQUESTED: ["GRANTED", "DECLINED", "CANCELLED"],
  GRANTED: ["ACTIVE", "REVOKED", "EXPIRED"],
  ACTIVE: ["EXPIRED", "REVOKED"],
  EXPIRED: [],
  REVOKED: [],
  DECLINED: [],
  CANCELLED: [],
};

/** A consent only authorises exchange while GRANTED/ACTIVE and inside its period. */
export function isConsentUsable(
  consent: { status: string; expiresAt: Date | null; revokedAt: Date | null; grantedAt: Date | null },
  now = new Date()
): boolean {
  if (consent.revokedAt) return false;
  if (!["GRANTED", "ACTIVE"].includes(consent.status)) return false;
  if (consent.expiresAt && consent.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Scope satisfaction. ALL_CLINICAL covers every clinical class but deliberately
 * NOT billing — financial data is a separate disclosure decision and must be
 * consented to explicitly.
 */
const CLINICAL_SCOPES: ConsentScope[] = [
  "DIAGNOSIS", "LAB", "IMAGING", "MEDICATION", "DOCUMENTS", "ENCOUNTER", "ALLERGY", "VITALS", "CARE_PLAN",
];

export function consentCoversScope(granted: string[], requested: string): boolean {
  if (granted.includes(requested)) return true;
  if (granted.includes("ALL_CLINICAL") && (CLINICAL_SCOPES as string[]).includes(requested)) return true;
  return false;
}

export function consentCoversAllScopes(granted: string[], requested: string[]): boolean {
  return requested.every((s) => consentCoversScope(granted, s));
}

// ── Exchange ────────────────────────────────────────────────────────────────
export const EXCHANGE_DIRECTIONS = ["OUTBOUND", "INBOUND"] as const;

export const EXCHANGE_TRANSITIONS: Record<string, string[]> = {
  REQUESTED: ["AUTHORIZED", "REJECTED", "CANCELLED"],
  AUTHORIZED: ["PROCESSING", "CANCELLED", "FAILED"],
  PROCESSING: ["COMPLETED", "FAILED"],
  // A failed exchange may be retried back into PROCESSING, or abandoned.
  FAILED: ["PROCESSING", "CANCELLED"],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

// ── Provenance ──────────────────────────────────────────────────────────────
/**
 * Aarogya must never present imported external data as locally authored
 * clinical data. Every representation carries exactly one of these origins.
 */
export const DATA_ORIGINS = ["LOCAL", "EXTERNAL", "IMPORTED", "MAPPED", "DERIVED"] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];

export const TERMINOLOGY_DOMAINS = [
  "DIAGNOSIS", "LAB", "MEDICATION", "OBSERVATION", "PROCEDURE", "UNIT",
] as const;

export const INTEROP_SYSTEMS = ["ABDM", "HFR", "HPR", "NHCX"] as const;
export const INTEROP_ENVIRONMENTS = ["DISABLED", "SANDBOX", "PRODUCTION"] as const;

export function isTransitionAllowed(map: Record<string, string[]>, from: string, to: string): boolean {
  return map[from]?.includes(to) ?? false;
}

export function assertOneOf<T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  if (!allowed.includes(value as T[number])) {
    throw new BadRequestError(`Unknown ${label}: must be one of ${allowed.join(", ")}.`);
  }
  return value as T[number];
}

/**
 * An identifier system that is known to belong to a particular entity type may
 * not be attached to a different one — an HPR number must never end up on a
 * patient, nor an ABHA on a facility. Unknown systems are permitted (local or
 * partner registries) but still fully facility-scoped.
 */
export function assertSystemMatchesEntity(system: string, entityType: string) {
  const expected = SYSTEM_ENTITY_RULES[system];
  if (expected && expected !== entityType) {
    throw new BadRequestError(`Identifier system ${system} identifies a ${expected}, not a ${entityType}.`);
  }
}

/**
 * Resolve the entity an external identifier points at, and prove it belongs to
 * the caller facility. This is the single chokepoint that stops facility A from
 * mapping an ABHA onto facility B patient, an HFR id onto another facility, or
 * an HPR id onto another facility staff member.
 */
export async function assertEntityInFacility(db: Db, entityType: string, entityId: string, facilityId: string) {
  switch (entityType) {
    case "PATIENT": {
      const row = await db.patient.findUnique({ where: { id: entityId }, select: { facilityId: true } });
      if (!row || row.facilityId !== facilityId) throw new NotFoundError("Patient not found in this facility.");
      return;
    }
    case "FACILITY": {
      // A facility may only ever carry its OWN registry identifier.
      if (entityId !== facilityId) throw new NotFoundError("Facility not found.");
      const row = await db.facility.findUnique({ where: { id: entityId }, select: { id: true } });
      if (!row) throw new NotFoundError("Facility not found.");
      return;
    }
    case "STAFF": {
      const row = await db.hospitalStaffProfile.findUnique({ where: { id: entityId }, select: { facilityId: true } });
      if (!row || row.facilityId !== facilityId) throw new NotFoundError("Staff member not found in this facility.");
      return;
    }
    case "ENCOUNTER": {
      const row = await db.encounter.findUnique({ where: { id: entityId }, select: { facilityId: true } });
      if (!row || row.facilityId !== facilityId) throw new NotFoundError("Encounter not found in this facility.");
      return;
    }
    case "DOCUMENT": {
      const row = await db.clinicalDocument.findUnique({ where: { id: entityId }, select: { facilityId: true } });
      if (!row || row.facilityId !== facilityId) throw new NotFoundError("Document not found in this facility.");
      return;
    }
    case "ORGANIZATION": {
      const facility = await db.facility.findUnique({ where: { id: facilityId }, select: { organizationId: true } });
      if (!facility || facility.organizationId !== entityId) throw new NotFoundError("Organization not found.");
      return;
    }
    default:
      throw new BadRequestError(`Unsupported entity type: ${entityType}.`);
  }
}

export async function assertPatientInFacility(db: Db, patientId: string, facilityId: string) {
  const p = await db.patient.findUnique({ where: { id: patientId }, select: { id: true, facilityId: true } });
  if (!p || p.facilityId !== facilityId) throw new NotFoundError("Patient not found in this facility.");
  return p;
}

export async function assertStaffInFacility(db: Db, staffId: string, facilityId: string) {
  const s = await db.hospitalStaffProfile.findUnique({ where: { id: staffId }, select: { id: true, facilityId: true, status: true } });
  if (!s || s.facilityId !== facilityId) throw new NotFoundError("Staff member not found in this facility.");
  if (s.status !== "ACTIVE") throw new BadRequestError("That staff member is not active.");
  return s;
}

/**
 * Mask a national identifier for display and logging. ABHA numbers and similar
 * identifiers should not be written to logs in full; callers that genuinely need
 * the value read it from the record, not from a log line.
 */
export function maskIdentifier(value: string): string {
  if (!value) return "";
  const visible = 4;
  if (value.length <= visible) return "*".repeat(value.length);
  return "*".repeat(value.length - visible) + value.slice(-visible);
}
