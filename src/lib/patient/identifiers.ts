import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { IDENTIFIER_SYSTEMS } from "@/lib/hospital/interoperability/shared";
import { linkExternalIdentifier } from "@/lib/hospital/interoperability/externalIdentity";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

/**
 * D1: one home per kind of patient identifier.
 *
 * - PatientIdentifier holds only identifiers Aarogya issues (UHID, MRN). A
 *   CHECK constraint (PatientIdentifier_aarogya_issued_only) enforces it.
 * - Everything issued outside Aarogya (ABHA number/address, insurer member IDs,
 *   another hospital's MRN) is an ExternalIdentifier mapping on the patient,
 *   with its own verification state.
 *
 * The patient API, the FHIR export and the NHCX claim bundle all read external
 * identifiers through activePatientExternalIdentifiers.
 */

export const AAROGYA_IDENTIFIER_TYPES = ["UHID", "MRN"] as const;
export const EXTERNAL_IDENTIFIER_TYPES = ["ABHA", "ABHA_NUMBER", "ABHA_ADDRESS", "INSURANCE_MEMBER_ID", "EXTERNAL_MRN", "LEGACY", "OTHER"] as const;
/** What staff can add by hand. UHID is issued at registration, never typed in. */
export const ADDABLE_IDENTIFIER_TYPES = ["MRN", ...EXTERNAL_IDENTIFIER_TYPES] as const;

/** System prefixes for issuer-specific identifiers; the issuer slug completes them. */
export const ISSUER_SYSTEM_PREFIXES = {
  INSURANCE_MEMBER_ID: "https://aarogya.local/insurer-member/",
  EXTERNAL_MRN: "https://aarogya.local/external-mrn/",
  OTHER: "https://aarogya.local/other-identifier/",
} as const;

/**
 * Must match the slug in migration 20261014180000_external_patient_identifiers:
 * lowercase, runs of anything but [a-z0-9] collapsed to "-", trimmed of "-".
 */
export function issuerSlug(issuer: string | null | undefined): string {
  const s = (issuer ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "unspecified";
}

/** The ExternalIdentifier system for a typed identifier. */
export function externalSystemFor(type: string, value: string, issuer?: string | null): string {
  switch (type) {
    case "ABHA":
      return value.includes("@") ? IDENTIFIER_SYSTEMS.ABHA_ADDRESS : IDENTIFIER_SYSTEMS.ABHA_NUMBER;
    case "ABHA_NUMBER":
      return IDENTIFIER_SYSTEMS.ABHA_NUMBER;
    case "ABHA_ADDRESS":
      return IDENTIFIER_SYSTEMS.ABHA_ADDRESS;
    case "INSURANCE_MEMBER_ID":
      if (!issuer?.trim()) throw new BadRequestError("An insurer member ID needs the insurer (issuer).");
      return ISSUER_SYSTEM_PREFIXES.INSURANCE_MEMBER_ID + issuerSlug(issuer);
    case "EXTERNAL_MRN":
      return ISSUER_SYSTEM_PREFIXES.EXTERNAL_MRN + issuerSlug(issuer);
    case "LEGACY":
    case "OTHER":
      return ISSUER_SYSTEM_PREFIXES.OTHER + issuerSlug(issuer);
    default:
      throw new BadRequestError(`Unknown identifier type ${type}.`);
  }
}

/** A readable label for an external identifier's system. */
export function externalIdentifierLabel(system: string): string {
  if (system === IDENTIFIER_SYSTEMS.ABHA_NUMBER) return "ABHA number";
  if (system === IDENTIFIER_SYSTEMS.ABHA_ADDRESS) return "ABHA address";
  for (const [type, prefix] of Object.entries(ISSUER_SYSTEM_PREFIXES)) {
    if (system.startsWith(prefix)) {
      const issuer = system.slice(prefix.length);
      const name = type === "INSURANCE_MEMBER_ID" ? "Insurer member ID" : type === "EXTERNAL_MRN" ? "External MRN" : "Identifier";
      return issuer === "unspecified" ? name : `${name} (${issuer})`;
    }
  }
  return system;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** The single read path for a patient's live external identifiers (FHIR export, NHCX, patient API). */
export function activePatientExternalIdentifiers(db: Db, facilityId: string, patientId: string) {
  return db.externalIdentifier.findMany({
    where: { facilityId, entityType: "PATIENT", entityId: patientId, status: "ACTIVE" },
    select: { system: true, value: true, use: true, status: true },
    orderBy: [{ system: "asc" }, { id: "asc" }],
  });
}

/** Everything the patient API shows: Aarogya-issued identifiers and external mappings, labelled. */
export async function listPatientIdentifiers(facilityId: string, patientId: string) {
  const [aarogya, external] = await Promise.all([
    prisma.patientIdentifier.findMany({ where: { patientId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma.externalIdentifier.findMany({
      where: { facilityId, entityType: "PATIENT", entityId: patientId },
      select: { id: true, system: true, value: true, use: true, status: true, verificationStatus: true, verifiedAt: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  return {
    identifiers: aarogya,
    externalIdentifiers: external.map((e) => ({ ...e, label: externalIdentifierLabel(e.system) })),
  };
}

/**
 * Add an identifier by type: Aarogya-issued types to PatientIdentifier,
 * everything else as an (unverified) ExternalIdentifier mapping.
 */
export async function addPatientIdentifier(input: {
  facilityId: string; patientId: string; type: string; value: string; issuer?: string; byUserId: string;
}) {
  const value = input.value.trim();
  if (!value) throw new BadRequestError("An identifier value is required.");
  if (!(ADDABLE_IDENTIFIER_TYPES as readonly string[]).includes(input.type)) {
    throw new BadRequestError(`type must be one of ${ADDABLE_IDENTIFIER_TYPES.join(", ")}.`);
  }
  const patient = await prisma.patient.findUnique({ where: { id: input.patientId }, select: { facilityId: true } });
  if (!patient || patient.facilityId !== input.facilityId) throw new NotFoundError("Patient not found.");

  if ((AAROGYA_IDENTIFIER_TYPES as readonly string[]).includes(input.type)) {
    const identifier = await prisma.$transaction(async (tx) => {
      const created = await tx.patientIdentifier.create({
        data: { patientId: input.patientId, type: input.type, value, issuer: input.issuer },
      });
      // The type only, never the value. (External identifiers emit their own event at 9c.)
      await emitFacilityEvent(tx, {
        type: "PatientDemographicsUpdated", aggregateId: input.patientId, facilityId: input.facilityId, actorUserId: input.byUserId,
        payload: { patientId: input.patientId, changeKind: "IDENTIFIER_ADDED", identifierType: created.type as "UHID" | "MRN" },
      });
      return created;
    });
    await recordAuditEvent(
      "hospital.patient.identifierAdded",
      input.byUserId,
      { patientId: input.patientId, identifierId: identifier.id, type: identifier.type },
      { facilityId: input.facilityId, patientId: input.patientId }
    );
    return { kind: "AAROGYA" as const, identifier };
  }

  // linkExternalIdentifier proves facility ownership, rejects collisions with
  // another patient, records provenance and audits.
  const identifier = await linkExternalIdentifier({
    facilityId: input.facilityId,
    entityType: "PATIENT",
    entityId: input.patientId,
    system: externalSystemFor(input.type, value, input.issuer),
    value,
    byUserId: input.byUserId,
  });
  return { kind: "EXTERNAL" as const, identifier };
}

/** Patient ids in a facility whose external identifiers contain `q` (for search). */
export async function patientIdsByExternalIdentifier(facilityId: string, q: string): Promise<string[]> {
  const rows = await prisma.externalIdentifier.findMany({
    where: { facilityId, entityType: "PATIENT", value: { contains: q, mode: "insensitive" } },
    select: { entityId: true },
    take: 50,
  });
  return [...new Set(rows.map((r) => r.entityId))];
}
