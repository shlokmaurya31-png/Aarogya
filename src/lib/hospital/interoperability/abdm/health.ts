import type { AbdmConfig } from "./config";
import { checkEnvironmentSafety, describeAbdmConfig } from "./config";
import { getAbdmSession, describeCachedSession } from "./session";
import { InteropError } from "./errors";
import type { FetchLike } from "./transport";
import { ABDM_CONTRACT_SOURCE } from "./contract";

/**
 * Phase C2 — ABDM adapter health check.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE RULE THAT DEFINES THIS FILE
 *
 * AVAILABLE is returned ONLY after a real session handshake has succeeded
 * against the configured environment. Code existing is not availability.
 * Configuration existing is not availability. A mock returning success is
 * certainly not availability.
 *
 * Every other outcome is reported as what it actually is, so a dashboard can
 * never render "connected" for a deployment that has never spoken to ABDM.
 * ════════════════════════════════════════════════════════════════════════════
 */

export type AbdmHealthState =
  /** Switched off by configuration. Not an error. */
  | "DISABLED"
  /** Enabled but the configuration is incomplete or unsafe. */
  | "MISCONFIGURED"
  /** Configured, but the gateway could not be reached. */
  | "UNREACHABLE"
  /** Reached, and it rejected our credentials. */
  | "AUTHENTICATION_FAILED"
  /** A real handshake succeeded. */
  | "AVAILABLE"
  /** Reached, but the failure does not fit the categories above. */
  | "UNKNOWN";

export interface AbdmHealthReport {
  state: AbdmHealthState;
  /** Operator-facing explanation. Never contains a credential. */
  message: string;
  environment: string;
  /** True only when a live handshake was actually performed in THIS check. */
  handshakePerformed: boolean;
  checkedAt: string;
  latencyMs: number | null;
  config: ReturnType<typeof describeAbdmConfig>;
  session: ReturnType<typeof describeCachedSession>;
  contractSource: typeof ABDM_CONTRACT_SOURCE;
}

function report(
  state: AbdmHealthState,
  message: string,
  config: AbdmConfig,
  extra: { handshakePerformed?: boolean; latencyMs?: number | null } = {}
): AbdmHealthReport {
  return {
    state,
    message,
    environment: config.environment,
    handshakePerformed: extra.handshakePerformed ?? false,
    checkedAt: new Date().toISOString(),
    latencyMs: extra.latencyMs ?? null,
    config: describeAbdmConfig(config),
    session: describeCachedSession(config),
    contractSource: ABDM_CONTRACT_SOURCE,
  };
}

/**
 * Check adapter health.
 *
 * `performHandshake` defaults to false so that rendering a dashboard does not
 * silently authenticate against a national gateway on every page load. The
 * administrative connection test opts in explicitly.
 */
export async function checkAbdmHealth(
  config: AbdmConfig,
  options: { performHandshake?: boolean; fetchImpl?: FetchLike } = {}
): Promise<AbdmHealthReport> {
  if (config.environment === "DISABLED") {
    return report("DISABLED", "ABDM is disabled for this deployment. No external calls are made.", config);
  }

  const safety = checkEnvironmentSafety(config);
  if (!safety.safe) {
    return report("MISCONFIGURED", safety.warning ?? "ABDM configuration is unsafe.", config);
  }
  if (!config.configured) {
    return report("MISCONFIGURED", `ABDM ${config.environment} is missing ${config.missing.join(", ")}.`, config);
  }

  if (!options.performHandshake) {
    // Configuration is complete, but nothing has been proven. This is
    // deliberately NOT "AVAILABLE".
    return report(
      "UNKNOWN",
      "Configuration is complete, but no handshake has been performed, so connectivity is unproven.",
      config
    );
  }

  const startedAt = Date.now();
  try {
    await getAbdmSession(config, { forceRefresh: true, fetchImpl: options.fetchImpl });
    const latencyMs = Date.now() - startedAt;
    return report(
      "AVAILABLE",
      `Session handshake with the ABDM ${config.environment} gateway succeeded.`,
      config,
      { handshakePerformed: true, latencyMs }
    );
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof InteropError) {
      switch (error.kind) {
        case "CONFIGURATION_ERROR":
          return report("MISCONFIGURED", error.message, config, { handshakePerformed: true, latencyMs });
        case "AUTHENTICATION_ERROR":
        case "AUTHORIZATION_ERROR":
          return report(
            "AUTHENTICATION_FAILED",
            "The ABDM gateway rejected the configured client credentials.",
            config,
            { handshakePerformed: true, latencyMs }
          );
        case "NETWORK_ERROR":
        case "TIMEOUT":
          return report("UNREACHABLE", error.message, config, { handshakePerformed: true, latencyMs });
        default:
          return report("UNKNOWN", error.message, config, { handshakePerformed: true, latencyMs });
      }
    }
    return report("UNKNOWN", "The health check failed for an unrecognised reason.", config, {
      handshakePerformed: true,
      latencyMs,
    });
  }
}

/** States a UI may render as a working connection. Exactly one qualifies. */
export const CONNECTED_STATES: AbdmHealthState[] = ["AVAILABLE"];

export function isConnected(state: AbdmHealthState): boolean {
  return CONNECTED_STATES.includes(state);
}
