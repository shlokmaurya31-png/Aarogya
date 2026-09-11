/**
 * Phase C1 — external system adapter boundary.
 *
 * Every call that leaves Aarogya goes through one of these. The interface exists
 * so that external systems stay REPLACEABLE and so that the rest of the codebase
 * never imports a vendor SDK or hardcodes an endpoint.
 *
 * CRITICAL HONESTY RULE: an adapter must never manufacture a successful-looking
 * response. If it is not configured, or the operation is not implemented against
 * a verified official specification, it returns an explicit
 * NOT_CONFIGURED / NOT_IMPLEMENTED outcome. Nothing in this codebase may report
 * "verified", "synchronised" or "delivered" on the strength of a mock.
 */

export type AdapterOutcome =
  | "OK"
  /** No credentials/endpoint, or the system is switched off for this facility. */
  | "NOT_CONFIGURED"
  /** Boundary exists but the real contract is not implemented yet. */
  | "NOT_IMPLEMENTED"
  /** The external system was reached and refused. */
  | "REJECTED"
  /** Transport/timeout/5xx — safe to retry. */
  | "TRANSIENT_ERROR"
  /** The external system was reached and returned something unusable. */
  | "PERMANENT_ERROR";

export interface AdapterResult<T = unknown> {
  outcome: AdapterOutcome;
  /** Present only when outcome is OK. */
  data?: T;
  /** Operator-facing explanation. Never contains a credential. */
  message: string;
  /** Identifier returned by the external system, when one was issued. */
  externalRequestId?: string;
  /** Only TRANSIENT_ERROR is retryable; everything else must not be retried blindly. */
  retryable: boolean;
}

export function ok<T>(data: T, message = "OK", externalRequestId?: string): AdapterResult<T> {
  return { outcome: "OK", data, message, externalRequestId, retryable: false };
}

export function notConfigured(system: string, missing: string[] = []): AdapterResult<never> {
  const detail = missing.length ? ` Missing configuration: ${missing.join(", ")}.` : "";
  return {
    outcome: "NOT_CONFIGURED",
    message: `${system} is not configured for this facility, so no external call was attempted.${detail}`,
    retryable: false,
  };
}

export function notImplemented(system: string, operation: string): AdapterResult<never> {
  return {
    outcome: "NOT_IMPLEMENTED",
    message:
      `${system}.${operation} is not implemented. The adapter boundary exists, but the operation ` +
      `requires the official specification and onboarding credentials before it can be built.`,
    retryable: false,
  };
}

export interface ExchangePayload {
  facilityId: string;
  patientId?: string | null;
  correlationId?: string | null;
  idempotencyKey: string;
  /** FHIR Bundle or other representation composed from canonical records. */
  body: unknown;
}

/**
 * The contract every external health-system integration implements.
 * Deliberately small: send, poll, cancel, plus registry lookup/verification.
 */
export interface HealthInteroperabilityAdapter {
  readonly system: string;

  /** Is this adapter able to make a real call right now? */
  capabilities(): Promise<{
    configured: boolean;
    environment: string;
    operations: string[];
    missing: string[];
  }>;

  send(payload: ExchangePayload): Promise<AdapterResult<{ externalRequestId: string }>>;

  getStatus(externalRequestId: string): Promise<AdapterResult<{ status: string }>>;

  cancel(externalRequestId: string): Promise<AdapterResult<{ cancelled: boolean }>>;
}

/**
 * Registry adapters (HFR/HPR/ABHA) resolve and verify identifiers. Verification
 * is the ONLY path allowed to mark an ExternalIdentifier VERIFIED, and it can
 * only do so from a genuine registry response.
 */
export interface RegistryAdapter {
  readonly system: string;

  capabilities(): Promise<{
    configured: boolean;
    environment: string;
    operations: string[];
    missing: string[];
  }>;

  /** Look up an identifier in the external registry. */
  lookup(args: { system: string; value: string }): Promise<AdapterResult<{ value: string; display?: string; updatedAt?: string }>>;

  /** Confirm that an identifier exists and is active in the external registry. */
  verify(args: { system: string; value: string }): Promise<AdapterResult<{ verified: boolean; externalUpdatedAt?: string }>>;
}
