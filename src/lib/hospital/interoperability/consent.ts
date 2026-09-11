import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import {
  CONSENT_PURPOSES, CONSENT_SCOPES, CONSENT_RECIPIENT_TYPES, CONSENT_TRANSITIONS,
  assertOneOf, isTransitionAllowed, isConsentUsable, consentCoversAllScopes,
  assertPatientInFacility, assertStaffInFacility,
} from "./shared";

/**
 * Phase C1 — health information exchange consent.
 *
 * This is the LOCAL consent domain. It is not an implementation of any external
 * consent-manager protocol, and it does not pretend to be one: `externalConsentRef`
 * simply records an artefact identifier when a real consent manager issues one.
 *
 * Consent here is never a boolean. A usable consent always names a recipient, a
 * purpose, an explicit set of data scopes and a validity period. And consent
 * alone never authorises anything — see assertExchangeAuthorized().
 */

export class ConsentConcurrencyError extends ConflictError {
  constructor(message = "This consent changed concurrently. Refresh and try again.") {
    super(message);
  }
}

function normaliseScopes(scopes: string[] | undefined): string[] {
  if (!scopes || scopes.length === 0) throw new BadRequestError("At least one data scope is required.");
  const unique = [...new Set(scopes.map((s) => s.trim()).filter(Boolean))];
  unique.forEach((s) => assertOneOf(s, CONSENT_SCOPES, "consent scope"));
  return unique;
}

/**
 * Record a consent request. Created in REQUESTED — never straight to GRANTED,
 * so that granting is always a separate, separately-audited act.
 */
export async function requestConsent(input: {
  facilityId: string;
  patientId: string;
  purpose: string;
  scopes: string[];
  recipientType: string;
  recipientIdentifier: string;
  recipientSystem?: string;
  recipientName?: string;
  expiresAt?: Date;
  externalConsentRef?: string;
  createdByStaffId?: string;
  byUserId: string;
}) {
  assertOneOf(input.purpose, CONSENT_PURPOSES, "consent purpose");
  assertOneOf(input.recipientType, CONSENT_RECIPIENT_TYPES, "recipient type");
  const scopes = normaliseScopes(input.scopes);
  if (!input.recipientIdentifier?.trim()) throw new BadRequestError("A recipient identifier is required.");
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new BadRequestError("Consent expiry must be in the future.");
  }
  await assertPatientInFacility(prisma, input.patientId, input.facilityId);
  if (input.createdByStaffId) await assertStaffInFacility(prisma, input.createdByStaffId, input.facilityId);

  const consent = await prisma.interopConsent.create({
    data: {
      facilityId: input.facilityId,
      patientId: input.patientId,
      purpose: input.purpose,
      recipientType: input.recipientType,
      recipientIdentifier: input.recipientIdentifier.trim(),
      recipientSystem: input.recipientSystem,
      recipientName: input.recipientName,
      expiresAt: input.expiresAt,
      externalConsentRef: input.externalConsentRef,
      createdByStaffId: input.createdByStaffId,
      scopes: { create: scopes.map((scope) => ({ scope })) },
    },
    include: { scopes: true },
  });

  await recordAuditEvent(
    "hospital.interop.consentCreated",
    input.byUserId,
    { consentId: consent.id, purpose: consent.purpose, scopes, recipientType: consent.recipientType },
    { facilityId: input.facilityId, patientId: input.patientId }
  );
  return consent;
}

/**
 * Grant a requested consent.
 *
 * `grantedBy` distinguishes the patient granting it themselves from a staff
 * member recording a consent obtained offline. That distinction matters for
 * later patient-controlled sharing, and it is not inferable after the fact.
 */
export async function grantConsent(input: {
  facilityId: string;
  consentId: string;
  grantedBy: "PATIENT" | "STAFF_RECORDED" | "EXTERNAL_CONSENT_MANAGER";
  expiresAt?: Date;
  externalConsentRef?: string;
  byUserId: string;
}) {
  if (!["PATIENT", "STAFF_RECORDED", "EXTERNAL_CONSENT_MANAGER"].includes(input.grantedBy)) {
    throw new BadRequestError("grantedBy must be PATIENT, STAFF_RECORDED or EXTERNAL_CONSENT_MANAGER.");
  }
  return prisma.$transaction(async (tx) => {
    const consent = await tx.interopConsent.findUnique({ where: { id: input.consentId } });
    if (!consent || consent.facilityId !== input.facilityId) throw new NotFoundError("Consent not found.");
    if (!isTransitionAllowed(CONSENT_TRANSITIONS, consent.status, "GRANTED")) {
      throw new BadRequestError(`A consent in ${consent.status} cannot be granted.`);
    }
    const expiresAt = input.expiresAt ?? consent.expiresAt;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw new BadRequestError("Consent expiry must be in the future.");

    // Guarded on the status we read, so two concurrent grants cannot both win.
    const r = await tx.interopConsent.updateMany({
      where: { id: consent.id, status: consent.status, version: consent.version },
      data: {
        status: "GRANTED",
        grantedAt: new Date(),
        grantedBy: input.grantedBy,
        expiresAt,
        externalConsentRef: input.externalConsentRef ?? consent.externalConsentRef,
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ConsentConcurrencyError();

    await tx.auditEvent.create({
      data: {
        type: "hospital.interop.consentGranted",
        userId: input.byUserId,
        detail: { consentId: consent.id, grantedBy: input.grantedBy, expiresAt: expiresAt?.toISOString() ?? null },
        facilityId: consent.facilityId,
        patientId: consent.patientId,
      },
    });
    return tx.interopConsent.findUniqueOrThrow({ where: { id: consent.id }, include: { scopes: true } });
  });
}

/**
 * Revoke a consent.
 *
 * Revocation blocks all FUTURE exchange under this consent. It deliberately does
 * NOT attempt to delete anything already delivered to a recipient: Aarogya
 * cannot enforce erasure on a system it does not control, and pretending
 * otherwise would be a false assurance to the patient.
 */
export async function revokeConsent(input: {
  facilityId: string; consentId: string; reason?: string; revokedByStaffId?: string; byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const consent = await tx.interopConsent.findUnique({ where: { id: input.consentId } });
    if (!consent || consent.facilityId !== input.facilityId) throw new NotFoundError("Consent not found.");
    if (!isTransitionAllowed(CONSENT_TRANSITIONS, consent.status, "REVOKED")) {
      throw new BadRequestError(`A consent in ${consent.status} cannot be revoked.`);
    }
    if (input.revokedByStaffId) await assertStaffInFacility(tx, input.revokedByStaffId, input.facilityId);

    const r = await tx.interopConsent.updateMany({
      where: { id: consent.id, status: consent.status, version: consent.version },
      data: {
        status: "REVOKED", revokedAt: new Date(), revokedReason: input.reason,
        revokedByStaffId: input.revokedByStaffId, version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ConsentConcurrencyError();

    await tx.auditEvent.create({
      data: {
        type: "hospital.interop.consentRevoked",
        userId: input.byUserId,
        detail: { consentId: consent.id, reason: input.reason ?? null },
        facilityId: consent.facilityId,
        patientId: consent.patientId,
      },
    });
    return tx.interopConsent.findUniqueOrThrow({ where: { id: consent.id }, include: { scopes: true } });
  });
}

/** Decline or cancel a pending request; both are terminal. */
export async function closeConsentRequest(input: {
  facilityId: string; consentId: string; to: "DECLINED" | "CANCELLED"; byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const consent = await tx.interopConsent.findUnique({ where: { id: input.consentId } });
    if (!consent || consent.facilityId !== input.facilityId) throw new NotFoundError("Consent not found.");
    if (!isTransitionAllowed(CONSENT_TRANSITIONS, consent.status, input.to)) {
      throw new BadRequestError(`Illegal consent transition ${consent.status} -> ${input.to}.`);
    }
    const r = await tx.interopConsent.updateMany({
      where: { id: consent.id, status: consent.status, version: consent.version },
      data: {
        status: input.to, version: { increment: 1 },
        ...(input.to === "DECLINED" ? { declinedAt: new Date() } : { cancelledAt: new Date() }),
      },
    });
    if (r.count !== 1) throw new ConsentConcurrencyError();
    await tx.auditEvent.create({
      data: {
        type: "hospital.interop.consentClosed",
        userId: input.byUserId,
        detail: { consentId: consent.id, status: input.to },
        facilityId: consent.facilityId,
        patientId: consent.patientId,
      },
    });
    return tx.interopConsent.findUniqueOrThrow({ where: { id: consent.id }, include: { scopes: true } });
  });
}

export async function getConsent(facilityId: string, consentId: string) {
  const consent = await prisma.interopConsent.findUnique({
    where: { id: consentId },
    include: { scopes: true },
  });
  if (!consent || consent.facilityId !== facilityId) throw new NotFoundError("Consent not found.");
  return consent;
}

export async function listConsents(args: { facilityId: string; patientId?: string; status?: string }) {
  return prisma.interopConsent.findMany({
    where: {
      facilityId: args.facilityId,
      ...(args.patientId ? { patientId: args.patientId } : {}),
      ...(args.status ? { status: args.status } : {}),
    },
    include: { scopes: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export interface ExchangeAuthorizationRequest {
  facilityId: string;
  patientId: string;
  purpose: string;
  scopes: string[];
  consentId?: string | null;
  /** Recipient the caller intends to send to, for consent matching. */
  recipientIdentifier?: string | null;
}

/**
 * The authorization decision for an exchange.
 *
 * Consent is ONE input, not the whole equation. The caller has already passed
 * authentication, RBAC and facility isolation before reaching here; this adds
 * patient scoping, purpose matching, scope coverage, recipient matching and
 * consent validity. A valid consent for a different purpose, a different
 * recipient, or a narrower scope does not authorise this exchange.
 *
 * PATIENT_ACCESS is the one purpose that does not require a separate consent
 * artefact — a patient receiving their own record is not a third-party
 * disclosure — but it still requires the patient to be in this facility and the
 * requested scopes to be valid.
 */
export async function assertExchangeAuthorized(req: ExchangeAuthorizationRequest) {
  assertOneOf(req.purpose, CONSENT_PURPOSES, "purpose");
  const scopes = normaliseScopes(req.scopes);
  await assertPatientInFacility(prisma, req.patientId, req.facilityId);

  if (req.purpose === "PATIENT_ACCESS" && !req.consentId) {
    return { consent: null, scopes, basis: "PATIENT_ACCESS" as const };
  }

  if (!req.consentId) {
    throw new BadRequestError(`Purpose ${req.purpose} requires a valid consent.`);
  }

  const consent = await prisma.interopConsent.findUnique({
    where: { id: req.consentId },
    include: { scopes: true },
  });
  // Facility mismatch is reported as not-found so the endpoint does not confirm
  // that a consent exists in another facility.
  if (!consent || consent.facilityId !== req.facilityId) throw new NotFoundError("Consent not found.");

  if (consent.patientId !== req.patientId) {
    throw new BadRequestError("That consent belongs to a different patient.");
  }
  if (!isConsentUsable(consent)) {
    const why = consent.revokedAt ? "has been revoked" : consent.expiresAt && consent.expiresAt <= new Date() ? "has expired" : `is ${consent.status}`;
    throw new BadRequestError(`Consent ${why}; this exchange is not authorized.`);
  }
  if (consent.purpose !== req.purpose) {
    throw new BadRequestError(`Consent was granted for ${consent.purpose}, not ${req.purpose}.`);
  }
  if (req.recipientIdentifier && consent.recipientIdentifier !== req.recipientIdentifier) {
    throw new BadRequestError("Consent was granted for a different recipient.");
  }
  const granted = consent.scopes.map((s) => s.scope);
  if (!consentCoversAllScopes(granted, scopes)) {
    const missing = scopes.filter((s) => !consentCoversAllScopes(granted, [s]));
    throw new BadRequestError(`Consent does not cover the requested data scope(s): ${missing.join(", ")}.`);
  }

  return { consent, scopes, basis: "CONSENT" as const };
}

/**
 * Lazily transition consents whose expiry has passed. Expiry is DERIVED at read
 * time by isConsentUsable(), so an unswept row is never treated as usable; this
 * only tidies the stored status and is safe to skip entirely.
 */
export async function expireLapsedConsents(facilityId: string) {
  const now = new Date();
  const result = await prisma.interopConsent.updateMany({
    where: { facilityId, status: { in: ["GRANTED", "ACTIVE"] }, expiresAt: { not: null, lte: now } },
    data: { status: "EXPIRED" },
  });
  return { expired: result.count };
}
