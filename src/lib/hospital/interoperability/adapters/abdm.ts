import { getAbdmConfig, checkEnvironmentSafety, ABDM_ENV_VARS } from "../config";
import {
  type HealthInteroperabilityAdapter, type RegistryAdapter, type AdapterResult,
  type ExchangePayload, notConfigured, notImplemented,
} from "./types";

/**
 * Phase C1 — ABDM / HFR / HPR adapter BOUNDARY.
 *
 * READ THIS BEFORE EXTENDING: this is not an ABDM integration. It is the seam
 * where one will attach. Every operation currently returns NOT_CONFIGURED (no
 * credentials) or NOT_IMPLEMENTED (boundary present, official contract not yet
 * built against a verified specification).
 *
 * That is a deliberate, load-bearing choice. Implementing guessed request and
 * response shapes for a national health registry would produce code that looks
 * integrated, passes its own tests, and fails the moment it meets the real
 * gateway — while making every status field in the product a lie. The ABDM FHIR
 * Implementation Guide (NRCeS, FHIR R4) documents the DATA model, which is what
 * Phase C1 implements; the TRANSPORT contracts require sandbox onboarding,
 * client credentials, registered callback URLs and, for several flows, an X.509
 * certificate. Those are deployment prerequisites, documented in
 * docs/PHASE_C1_INTEROPERABILITY.md.
 *
 * When those prerequisites exist, the work is to fill in these method bodies.
 * Nothing else in the codebase should need to change.
 */

const OPERATIONS = ["capabilities"] as const;

function environmentGuard(): AdapterResult<never> | null {
  const config = getAbdmConfig();
  if (config.environment === "DISABLED") return notConfigured("ABDM", []);
  const safety = checkEnvironmentSafety(config);
  if (!safety.safe) {
    return {
      outcome: "NOT_CONFIGURED",
      message: safety.warning ?? "ABDM configuration is unsafe; refusing to call.",
      retryable: false,
    };
  }
  if (!config.configured) return notConfigured("ABDM", config.missing);
  return null;
}

async function describeCapabilities(system: string) {
  const config = getAbdmConfig();
  return {
    configured: config.configured,
    environment: config.environment,
    // Only operations that would genuinely execute are advertised. An
    // unconfigured adapter advertises none, so a dashboard cannot imply
    // connectivity that does not exist.
    operations: config.configured ? [...OPERATIONS] : [],
    missing: config.environment === "DISABLED" ? [ABDM_ENV_VARS.environment] : config.missing,
    system,
  };
}

export class AbdmAdapter implements HealthInteroperabilityAdapter {
  readonly system = "ABDM";

  async capabilities() {
    return describeCapabilities(this.system);
  }

  async send(payload: ExchangePayload): Promise<AdapterResult<{ externalRequestId: string }>> {
    const blocked = environmentGuard();
    if (blocked) return blocked;
    void payload;
    // Reached only when real credentials are present. The health-information
    // push contract is not implemented against a verified specification yet.
    return notImplemented(this.system, "send");
  }

  async getStatus(externalRequestId: string): Promise<AdapterResult<{ status: string }>> {
    const blocked = environmentGuard();
    if (blocked) return blocked;
    void externalRequestId;
    return notImplemented(this.system, "getStatus");
  }

  async cancel(externalRequestId: string): Promise<AdapterResult<{ cancelled: boolean }>> {
    const blocked = environmentGuard();
    if (blocked) return blocked;
    void externalRequestId;
    return notImplemented(this.system, "cancel");
  }
}

/**
 * HFR (facility registry) and HPR (professional registry) share the lookup /
 * verify shape, so one class covers both with the system name injected.
 */
export class AbdmRegistryAdapter implements RegistryAdapter {
  constructor(readonly system: "HFR" | "HPR" | "ABDM") {}

  async capabilities() {
    return describeCapabilities(this.system);
  }

  async lookup(args: { system: string; value: string }): Promise<AdapterResult<{ value: string; display?: string; updatedAt?: string }>> {
    const blocked = environmentGuard();
    if (blocked) return blocked;
    void args;
    return notImplemented(this.system, "lookup");
  }

  async verify(args: { system: string; value: string }): Promise<AdapterResult<{ verified: boolean; externalUpdatedAt?: string }>> {
    const blocked = environmentGuard();
    if (blocked) return blocked;
    void args;
    return notImplemented(this.system, "verify");
  }
}

/**
 * In-memory adapter used ONLY by tests to exercise the exchange state machine
 * without a network. It is not exported from the adapter registry below, so no
 * production code path can reach it, and its responses are explicitly labelled
 * so a stubbed result can never be mistaken for real connectivity.
 */
export class StubExchangeAdapter implements HealthInteroperabilityAdapter {
  readonly system = "STUB";
  constructor(private readonly script: AdapterResult<{ externalRequestId: string }>[] = []) {}
  private calls = 0;

  async capabilities() {
    return { configured: true, environment: "STUB", operations: ["send", "getStatus", "cancel"], missing: [] };
  }

  async send(payload: ExchangePayload): Promise<AdapterResult<{ externalRequestId: string }>> {
    void payload;
    const next = this.script[this.calls] ?? this.script[this.script.length - 1];
    this.calls += 1;
    if (!next) {
      return { outcome: "OK", data: { externalRequestId: `stub-${this.calls}` }, message: "STUB adapter — not a real exchange.", retryable: false };
    }
    return next;
  }

  async getStatus(): Promise<AdapterResult<{ status: string }>> {
    return { outcome: "OK", data: { status: "COMPLETED" }, message: "STUB adapter — not a real exchange.", retryable: false };
  }

  async cancel(): Promise<AdapterResult<{ cancelled: boolean }>> {
    return { outcome: "OK", data: { cancelled: true }, message: "STUB adapter — not a real exchange.", retryable: false };
  }

  get callCount() {
    return this.calls;
  }
}

/** Resolve the adapter for a configured external system. */
export function getExchangeAdapter(system: string): HealthInteroperabilityAdapter {
  switch (system) {
    case "ABDM":
      return new AbdmAdapter();
    default:
      // Unknown destinations get an adapter that refuses rather than one that
      // pretends. Callers surface NOT_CONFIGURED to the operator.
      return new (class implements HealthInteroperabilityAdapter {
        readonly system = system;
        async capabilities() {
          return { configured: false, environment: "DISABLED", operations: [], missing: ["adapter"] };
        }
        async send() { return notConfigured(system); }
        async getStatus() { return notConfigured(system); }
        async cancel() { return notConfigured(system); }
      })();
  }
}

export function getRegistryAdapter(system: "HFR" | "HPR" | "ABDM"): RegistryAdapter {
  return new AbdmRegistryAdapter(system);
}
