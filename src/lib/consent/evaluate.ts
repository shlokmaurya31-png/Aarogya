import { prisma } from "@/lib/db";
import { isConsentUsable, consentCoversAllScopes } from "@/lib/hospital/interoperability/shared";

/**
 * Phase C4 — the single consent evaluation point (D2: part of src/lib/consent).
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
 * Evaluate whether a usable consent authorises this disclosure (decideConsent).
 *
 * When no consent id is supplied the most recently granted matching consent is
 * considered, so a caller is not forced to know the id — but matching is still
 * strict on purpose and recipient. A consent for a different purpose or a
 * different recipient is NOT a match, it is a denial.
 */
/** The fields of a consent the decision needs. */
export interface ConsentForDecision {
  id: string;
  facilityId: string;
  patientId: string;
  purpose: string;
  status: string;
  recipientIdentifier: string;
  grantedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  scopes: { scope: string }[];
}

/**
 * THE consent decision: does this consent authorise this disclosure? One pure
 * function, used by evaluateConsent (authorization engine, sharing policy) and
 * by assertExchangeAuthorized (exchanges, FHIR export), so two paths can never
 * disagree. Returns `notFound` for another facility's consent, so callers can
 * report it exactly like a missing one.
 */
export function decideConsent(
  consent: ConsentForDecision,
  req: { facilityId: string; patientId: string; purpose?: string | null; scopes?: string[]; recipientIdentifier?: string | null },
  now: Date = new Date()
): { usable: true; grantedScopes: string[] } | { usable: false; notFound?: true; reason: string; grantedScopes: string[] } {
  const requested = [...new Set(req.scopes ?? [])];
  if (consent.facilityId !== req.facilityId) return { usable: false, notFound: true, reason: "No matching consent was found.", grantedScopes: [] };
  if (consent.patientId !== req.patientId) return { usable: false, reason: "That consent belongs to a different patient.", grantedScopes: [] };
  if (!isConsentUsable(consent, now)) {
    const why = consent.revokedAt ? "has been revoked" : consent.expiresAt && consent.expiresAt <= now ? "has expired" : `is ${consent.status}`;
    return { usable: false, reason: `Consent ${why}.`, grantedScopes: [] };
  }
  // Purpose escalation: a TREATMENT consent does not authorise RESEARCH.
  if (req.purpose && consent.purpose !== req.purpose) {
    return { usable: false, reason: `Consent was granted for ${consent.purpose}, not ${req.purpose}.`, grantedScopes: [] };
  }
  // Recipient escalation: a consent naming organisation A does not authorise B.
  if (req.recipientIdentifier && consent.recipientIdentifier !== req.recipientIdentifier) {
    return { usable: false, reason: "Consent was granted for a different recipient.", grantedScopes: [] };
  }
  const grantedScopes = consent.scopes.map((s) => s.scope);
  // Scope escalation: requested must be a SUBSET of granted. Never expanded.
  if (requested.length && !consentCoversAllScopes(grantedScopes, requested)) {
    const missing = requested.filter((s) => !consentCoversAllScopes(grantedScopes, [s]));
    return { usable: false, reason: `Consent does not cover the requested data scope(s): ${missing.join(", ")}.`, grantedScopes };
  }
  return { usable: true, grantedScopes };
}

export async function evaluateConsent(input: EvaluateConsentInput): Promise<ConsentEvaluation> {
  const now = input.now ?? new Date();
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
        orderBy: [{ grantedAt: "desc" }, { id: "desc" }],
      });
  if (!consent) {
    return { usable: false, consentId: null, reason: "No matching consent was found.", grantedScopes: [] };
  }
  const d = decideConsent(consent, input, now);
  if (d.usable) return { usable: true, consentId: consent.id, reason: null, grantedScopes: d.grantedScopes };
  // Another facility's consent reads as "not found", so this can't confirm it exists.
  return { usable: false, consentId: d.notFound ? null : consent.id, reason: d.reason, grantedScopes: d.grantedScopes };
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
