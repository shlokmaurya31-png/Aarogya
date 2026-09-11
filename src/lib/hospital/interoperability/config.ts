/**
 * Phase C1 — interoperability configuration contract.
 *
 * This module defines WHICH environment variables an operator must supply. It
 * deliberately contains no credential, no endpoint default for production, and
 * no fallback that would let a misconfigured deployment start talking to a live
 * national registry by accident.
 *
 * The default is DISABLED. Aarogya is a fully functional hospital system with
 * every one of these switched off: admission, medication administration,
 * documentation, emergency care and discharge have no dependency on any
 * external system. Interoperability is an integration layer, not a
 * transactional dependency.
 */

export type InteropEnvironment = "DISABLED" | "SANDBOX" | "PRODUCTION";

export interface AbdmConfig {
  environment: InteropEnvironment;
  baseUrl: string | null;
  clientId: string | null;
  /** True only when every prerequisite for a real call is present. */
  configured: boolean;
  /** Human-readable list of what is still missing. */
  missing: string[];
}

/**
 * Environment variables read by the ABDM adapter. Names only — values live in
 * the deployment environment and are never committed, logged or persisted.
 */
export const ABDM_ENV_VARS = {
  environment: "ABDM_ENVIRONMENT",
  baseUrl: "ABDM_BASE_URL",
  clientId: "ABDM_CLIENT_ID",
  clientSecret: "ABDM_CLIENT_SECRET",
} as const;

function readEnvironment(raw: string | undefined): InteropEnvironment {
  if (raw === "SANDBOX" || raw === "PRODUCTION") return raw;
  // Anything unset, empty or unrecognised is treated as DISABLED rather than
  // guessed. Failing closed is the only safe default for a national registry.
  return "DISABLED";
}

/** Loosened from NodeJS.ProcessEnv so callers and tests can pass a plain map. */
export type EnvSource = Record<string, string | undefined>;

export function getAbdmConfig(env: EnvSource = process.env): AbdmConfig {
  const environment = readEnvironment(env[ABDM_ENV_VARS.environment]);
  const baseUrl = env[ABDM_ENV_VARS.baseUrl]?.trim() || null;
  const clientId = env[ABDM_ENV_VARS.clientId]?.trim() || null;
  const clientSecret = env[ABDM_ENV_VARS.clientSecret]?.trim() || null;

  if (environment === "DISABLED") {
    return { environment, baseUrl: null, clientId: null, configured: false, missing: [] };
  }

  const missing: string[] = [];
  if (!baseUrl) missing.push(ABDM_ENV_VARS.baseUrl);
  if (!clientId) missing.push(ABDM_ENV_VARS.clientId);
  if (!clientSecret) missing.push(ABDM_ENV_VARS.clientSecret);

  return { environment, baseUrl, clientId, configured: missing.length === 0, missing };
}

/**
 * Guard against the single most damaging misconfiguration: a production
 * deployment pointed at the sandbox, or a non-production build pointed at the
 * live registry. Returns the problem rather than throwing so a dashboard can
 * surface it without taking the hospital down.
 */
export function checkEnvironmentSafety(
  config: AbdmConfig,
  nodeEnv: string | undefined = process.env.NODE_ENV
): { safe: boolean; warning: string | null } {
  if (config.environment === "DISABLED") return { safe: true, warning: null };

  if (nodeEnv === "production" && config.environment === "SANDBOX") {
    return { safe: false, warning: "Production deployment is pointed at the ABDM SANDBOX environment." };
  }
  if (nodeEnv !== "production" && config.environment === "PRODUCTION") {
    return { safe: false, warning: "A non-production deployment is pointed at ABDM PRODUCTION." };
  }
  if (!config.configured) {
    return { safe: false, warning: `ABDM ${config.environment} is selected but ${config.missing.join(", ")} are not set.` };
  }
  return { safe: true, warning: null };
}

/**
 * Redacted view for dashboards and logs. Never exposes the client id itself,
 * only whether one is present.
 */
export function describeAbdmConfig(config: AbdmConfig) {
  return {
    environment: config.environment,
    baseUrlConfigured: !!config.baseUrl,
    credentialsConfigured: config.configured,
    missing: config.missing,
  };
}
