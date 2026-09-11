import { NHCX_CONTRACT_SOURCE, isTransportContractVerified } from "./contract";
import { NhcxError } from "./errors";

/**
 * Phase C5 — NHCX transport adapter BOUNDARY.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE EXTENDING.
 *
 * This is not an NHCX integration. It is the seam where one attaches.
 *
 * Every operation returns NOT_IMPLEMENTED, and that is a deliberate,
 * load-bearing decision rather than unfinished work. The HCX protocol
 * specification hosts returned HTTP 403 and the NHCX portal publishes no
 * specification content, so there is no primary source for endpoint paths,
 * protocol headers, the request envelope, the callback contract, the error
 * vocabulary or the crypto parameters.
 *
 * C2 committed ABDM endpoint constants only because the official PDF was read
 * directly. That standard is not met here. Implementing guessed request shapes
 * for a national claims network would produce code that looks integrated,
 * passes its own tests, and fails the moment it meets the real switch — while
 * making every status field in the product a lie.
 *
 * What IS implemented is everything downstream of transport: canonical package
 * composition, the verified FHIR collection-bundle representation, versioned
 * submissions, idempotency, state machines, reconciliation and audit. When the
 * specification and onboarding exist, the work is to fill in these method
 * bodies. Nothing else should need to change.
 * ════════════════════════════════════════════════════════════════════════════
 */

export type NhcxOutcome =
  | "OK"
  /** No credentials or environment configured. */
  | "NOT_CONFIGURED"
  /** Boundary exists; the verified contract to implement it does not. */
  | "NOT_IMPLEMENTED"
  | "REJECTED"
  | "TRANSIENT_ERROR"
  | "PERMANENT_ERROR";

export interface NhcxResult<T = unknown> {
  outcome: NhcxOutcome;
  data?: T;
  /** Operator-facing. Never contains a credential or a clinical payload. */
  message: string;
  externalReference?: string | null;
  retryable: boolean;
}

export interface NhcxSubmitPayload {
  facilityId: string;
  correlationId: string;
  idempotencyKey: string;
  exchangeType: string;
  /** FHIR collection bundle composed from canonical records. */
  bundle: unknown;
  recipientParticipantCode?: string | null;
}

export function notImplemented(operation: string): NhcxResult<never> {
  return {
    outcome: "NOT_IMPLEMENTED",
    message:
      `NHCX ${operation} is not implemented. The transport contract could not be verified against an ` +
      `official source (${NHCX_CONTRACT_SOURCE.transportBlockedReason}), and no endpoint, header or ` +
      `envelope has been guessed.`,
    retryable: false,
  };
}

export function notConfigured(operation: string, missing: string[] = []): NhcxResult<never> {
  const detail = missing.length ? ` Missing: ${missing.join(", ")}.` : "";
  return {
    outcome: "NOT_CONFIGURED",
    message: `NHCX is not configured, so ${operation} was not attempted.${detail}`,
    retryable: false,
  };
}

/** The contract every NHCX transport implementation satisfies. */
export interface NhcxAdapter {
  readonly name: string;
  capabilities(): Promise<{
    configured: boolean;
    environment: string;
    transportContractVerified: boolean;
    operations: string[];
    blockers: string[];
  }>;
  submit(payload: NhcxSubmitPayload): Promise<NhcxResult<{ externalReference: string }>>;
  checkStatus(correlationId: string): Promise<NhcxResult<{ status: string }>>;
}

/**
 * The only adapter that exists. Honest by construction: it advertises no
 * operations and every call refuses.
 */
export class UnverifiedNhcxAdapter implements NhcxAdapter {
  readonly name = "NHCX";

  async capabilities() {
    const { getNhcxConfig } = await import("./config");
    const config = getNhcxConfig();
    const blockers: string[] = [];
    if (!isTransportContractVerified()) blockers.push("Transport contract not verified against an official source.");
    if (config.environment === "DISABLED") blockers.push("NHCX_ENVIRONMENT is not set.");
    else if (!config.configured) blockers.push(`Missing configuration: ${config.missing.join(", ")}.`);
    return {
      configured: config.configured,
      environment: config.environment,
      transportContractVerified: isTransportContractVerified(),
      // Deliberately empty: an adapter that cannot make a real call must not
      // advertise operations a dashboard could render as capability.
      operations: [],
      blockers,
    };
  }

  async submit(payload: NhcxSubmitPayload): Promise<NhcxResult<{ externalReference: string }>> {
    const { getNhcxConfig } = await import("./config");
    const config = getNhcxConfig();
    if (config.environment === "DISABLED") return notConfigured("submit");
    if (!config.configured) return notConfigured("submit", config.missing);
    void payload;
    return notImplemented("submit");
  }

  async checkStatus(correlationId: string): Promise<NhcxResult<{ status: string }>> {
    const { getNhcxConfig } = await import("./config");
    const config = getNhcxConfig();
    if (config.environment === "DISABLED") return notConfigured("checkStatus");
    void correlationId;
    return notImplemented("checkStatus");
  }
}

/**
 * Deterministic contract TEST HARNESS. Tests only.
 *
 * It is not an adapter to a sandbox and must never be mistaken for one: the
 * name says Harness, every result carries `__harness: true`, and it is never
 * returned by getNhcxAdapter(). It exists to exercise OUR retry, idempotency
 * and error-classification code under failure modes a real network makes hard
 * to reproduce on demand.
 */
export type HarnessScenario =
  | "SUCCESS" | "VALIDATION_ERROR" | "AUTH_ERROR" | "FORBIDDEN"
  | "DUPLICATE" | "RATE_LIMITED" | "SERVER_ERROR" | "TIMEOUT" | "MALFORMED";

export class NhcxContractHarness implements NhcxAdapter {
  readonly name = "NHCX_TEST_HARNESS";
  private calls = 0;
  constructor(private readonly script: HarnessScenario | HarnessScenario[] = "SUCCESS") {}

  get callCount() { return this.calls; }

  async capabilities() {
    return {
      configured: true,
      environment: "TEST_HARNESS",
      transportContractVerified: false,
      operations: ["submit", "checkStatus"],
      blockers: ["This is a deterministic test harness, NOT an NHCX connection."],
    };
  }

  private next(): HarnessScenario {
    if (!Array.isArray(this.script)) return this.script;
    const s = this.script[Math.min(this.calls, this.script.length - 1)];
    return s ?? "SUCCESS";
  }

  async submit(payload: NhcxSubmitPayload): Promise<NhcxResult<{ externalReference: string }>> {
    const scenario = this.next();
    this.calls += 1;
    switch (scenario) {
      case "VALIDATION_ERROR":
        return { outcome: "REJECTED", message: "Harness: validation error.", retryable: false };
      case "AUTH_ERROR":
        return { outcome: "PERMANENT_ERROR", message: "Harness: authentication failed.", retryable: false };
      case "FORBIDDEN":
        return { outcome: "PERMANENT_ERROR", message: "Harness: forbidden.", retryable: false };
      case "DUPLICATE":
        // Not retryable: the far side already has it, and resending is exactly
        // what would create a second claim.
        return { outcome: "REJECTED", message: "Harness: duplicate request.", retryable: false };
      case "RATE_LIMITED":
        return { outcome: "TRANSIENT_ERROR", message: "Harness: rate limited.", retryable: true };
      case "SERVER_ERROR":
        return { outcome: "TRANSIENT_ERROR", message: "Harness: upstream error.", retryable: true };
      case "TIMEOUT":
        return { outcome: "TRANSIENT_ERROR", message: "Harness: timed out.", retryable: true };
      case "MALFORMED":
        return { outcome: "PERMANENT_ERROR", message: "Harness: malformed response.", retryable: false };
      case "SUCCESS":
      default:
        return {
          outcome: "OK",
          // Prefixed so a harness reference is recognisable if it ever surfaces.
          data: { externalReference: `HARNESS-${payload.idempotencyKey.slice(0, 12)}` },
          message: "Harness: accepted. NOT a real NHCX submission.",
          externalReference: `HARNESS-${payload.idempotencyKey.slice(0, 12)}`,
          retryable: false,
        };
    }
  }

  async checkStatus(): Promise<NhcxResult<{ status: string }>> {
    return { outcome: "OK", data: { status: "PENDING" }, message: "Harness: not a real status.", retryable: false };
  }
}

export function getNhcxAdapter(): NhcxAdapter {
  // Deliberately no switch to the harness: there is no environment flag that
  // can put a test double on a production code path.
  return new UnverifiedNhcxAdapter();
}

export function toNhcxError(result: NhcxResult, correlationId: string): NhcxError {
  const category =
    result.outcome === "NOT_CONFIGURED" ? "CONFIGURATION"
      : result.outcome === "NOT_IMPLEMENTED" ? "PROTOCOL"
        : result.outcome === "REJECTED" ? "VALIDATION"
          : result.outcome === "TRANSIENT_ERROR" ? "EXTERNAL_SYSTEM"
            : "UNKNOWN";
  return new NhcxError({ category, message: result.message, correlationId, retryable: result.retryable });
}
