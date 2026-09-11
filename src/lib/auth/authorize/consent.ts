import { prisma } from "@/lib/db";
import { isConsentUsable, consentCoversAllScopes } from "@/lib/hospital/interoperability/shared";

/**
 * Phase C4 — the single consent evaluation point.
 *
 * C1 put consent logic in the interoperability layer; C4 makes it an
 * authorization input usable from anywhere. This deliberately DELEGATES to the
 * C1 primitives (`isConsentUsable`, `consentCoversAllScopes`) rather than
 * reimplementing them — two consent evaluators that disagree is strictly worse
 * than one, and the C1 versions are already covered by the interoperability
 * suite.
 *
 * What this adds is the surrounding decision: which consent applies, and does
 * it match the purpose, recipient and scope being asked for.
 */

export interface ConsentEvaluation {
  usable: boolean;
  consentId: string | null;
  reason: string | null;
  /** Scopes the consent actually grants, for a caller that wants to narrow. */
  grantedScopes: string[];
}

export interface EvaluateConsentInput {
  facilityId: string;
  patientId: string;
  purpose?: string | null;
  scopes?: string[];
  consentId?: string | null;
  recipientIdentifier?: string | null;
  now?: Date;
}

/**
 * Evaluate whether a usable consent authorises this disclosure.
 *
 * When no consent id is supplied the most recently granted matching consent is
 * considered, so a caller is not forced to know the id — but matching is still
 * strict on purpose and recipient. A consent for a different purpose or a
 * different recipient is NOT a match, it is a denial.
 */
export async function evaluateConsent(input: EvaluateConsentInput): Promise<ConsentEvaluation> {
  const now = input.now ?? new Date();
  const requested = [...new Set(input.scopes ?? [])];

  const consent = input.consentId
    ? await prisma.interopConsent.findUnique({ where: { id: input.consentId }, include: { scopes: true } })
    : await prisma.interopConsent.findFirst({
        where: {
          facilityId: input.facilityId,
          patientId: input.patientId,
          status: { in: ["GRANTED", "ACTIVE"] },
          ...(input.purpose ? { purpose: input.purpose } : {}),
          ...(input.recipientIdentifier ? { recipientIdentifier: input.recipientIdentifier } : {}),
        },
        include: { scopes: true },
        orderBy: { grantedAt: "desc" },
      });

  if (!consent) {
    return { usable: false, consentId: null, reason: "No matching consent was found.", grantedScopes: [] };
  }

  // Facility mismatch reads as "not found" so the endpoint cannot be used to
  // confirm that a consent exists in another facility.
  if (consent.facilityId !== input.facilityId) {
    return { usable: false, consentId: null, reason: "No matching consent was found.", grantedScopes: [] };
  }
  if (consent.patientId !== input.patientId) {
    return { usable: false, consentId: null, reason: "That consent belongs to a different patient.", grantedScopes: [] };
  }

  if (!isConsentUsable(consent, now)) {
    const why = consent.revokedAt
      ? "has been revoked"
      : consent.expiresAt && consent.expiresAt <= now
        ? "has expired"
        : `is ${consent.status}`;
    return { usable: false, consentId: consent.id, reason: `Consent ${why}.`, grantedScopes: [] };
  }

  // Purpose escalation: a TREATMENT consent does not authorise RESEARCH.
  if (input.purpose && consent.purpose !== input.purpose) {
    return {
      usable: false, consentId: consent.id, grantedScopes: [],
      reason: `Consent was granted for ${consent.purpose}, not ${input.purpose}.`,
    };
  }

  // Recipient escalation: a consent naming organisation A does not authorise B.
  if (input.recipientIdentifier && consent.recipientIdentifier !== input.recipientIdentifier) {
    return {
      usable: false, consentId: consent.id, grantedScopes: [],
      reason: "Consent was granted for a different recipient.",
    };
  }

  const grantedScopes = consent.scopes.map((s) => s.scope);

  // Scope escalation: requested must be a SUBSET of granted. Never expanded.
  if (requested.length && !consentCoversAllScopes(grantedScopes, requested)) {
    const missing = requested.filter((s) => !consentCoversAllScopes(grantedScopes, [s]));
    return {
      usable: false, consentId: consent.id, grantedScopes,
      reason: `Consent does not cover: ${missing.join(", ")}.`,
    };
  }

  return { usable: true, consentId: consent.id, reason: null, grantedScopes };
}

/**
 * Central sharing policy. The one function every disclosure path funnels
 * through, so "may this data leave the facility?" has exactly one answer.
 */
export async function canSharePatientData(input: {
  facilityId: string;
  patientId: string;
  purpose: string;
  scopes: string[];
  recipientIdentifier?: string | null;
  consentId?: string | null;
  now?: Date;
}): Promise<{ allowed: boolean; reason: string | null; consentId: string | null; grantedScopes: string[] }> {
  const patient = await prisma.patient.findUnique({
    where: { id: input.patientId },
    select: { facilityId: true },
  });
  // Tenant isolation is checked BEFORE consent: a valid-looking consent must
  // never be able to reach across a facility boundary.
  if (!patient || patient.facilityId !== input.facilityId) {
    return { allowed: false, reason: "Not found.", consentId: null, grantedScopes: [] };
  }

  const verdict = await evaluateConsent({ ...input, now: input.now });
  return {
    allowed: verdict.usable,
    reason: verdict.reason,
    consentId: verdict.consentId,
    grantedScopes: verdict.grantedScopes,
  };
}
