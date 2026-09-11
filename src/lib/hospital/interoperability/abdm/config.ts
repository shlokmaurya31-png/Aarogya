import {
  ABDM_ENVIRONMENTS, ABDM_ID_PATTERNS, type AbdmEnvironmentName,
} from "./contract";

/**
 * Phase C2 — hardened ABDM configuration.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SCOPE DECISION (verified, not assumed)
 *
 * The ABDM M3 document §2 defines two distinct identifiers:
 *
 *   Bridge ID  = the client id NHA issues to an INTEGRATOR (e.g. SBX_000135)
 *   Service ID = the facility id from the NHPR/HFR  (e.g. IN02100000XX)
 *
 * One deployment holds ONE bridge and authenticates once; individual facilities
 * are addressed as services beneath it. Therefore:
 *
 *   ABDM CREDENTIALS ARE PLATFORM-LEVEL, NOT FACILITY-LEVEL.
 *
 * That is why clientId/clientSecret live in the process environment and are NOT
 * a per-facility database setting. A facility-scoped credential would not just
 * be redundant, it would let one facility's configuration authenticate as the
 * whole bridge. Facility-level configuration is limited to the HFR/HPR service
 * identifiers, which are already modelled as ExternalIdentifier rows.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * No value here is ever persisted, logged or returned to a client. The only
 * thing that leaves this module is a redacted description.
 */

export type InteropEnvironment = "DISABLED" | AbdmEnvironmentName;

/** Environment variable names. Names only — values live in the environment. */
export const ABDM_ENV_VARS = {
  environment: "ABDM_ENVIRONMENT",
  clientId: "ABDM_CLIENT_ID",
  clientSecret: "ABDM_CLIENT_SECRET",
  /** Public base URL the CM will call back on (registered via bridge/url). */
  callbackBaseUrl: "ABDM_CALLBACK_BASE_URL",
  /** Shared secret we require on inbound callbacks; see callbacks.ts. */
  callbackToken: "ABDM_CALLBACK_TOKEN",
  /** Optional override; defaults to the documented per-environment base URL. */
  baseUrlOverride: "ABDM_BASE_URL",
  requestTimeoutMs: "ABDM_REQUEST_TIMEOUT_MS",
  /** Filesystem/secret-manager REFERENCES only — never the material itself. */
  clientCertPath: "ABDM_CLIENT_CERT_PATH",
  clientKeyPath: "ABDM_CLIENT_KEY_PATH",
  caBundlePath: "ABDM_CA_BUNDLE_PATH",
} as const;

export type EnvSource = Record<string, string | undefined>;

export interface AbdmConfig {
  environment: InteropEnvironment;
  /** Resolved from the environment name; override only for a proxy/mirror. */
  baseUrl: string | null;
  cmId: string | null;
  abhaSuffix: string | null;
  clientId: string | null;
  clientSecret: string | null;
  callbackBaseUrl: string | null;
  callbackToken: string | null;
  requestTimeoutMs: number;
  certificates: { clientCertPath: string | null; clientKeyPath: string | null; caBundlePath: string | null };
  /** True only when every prerequisite for a real outbound call is present. */
  configured: boolean;
  /** True when we can additionally RECEIVE callbacks. */
  callbacksConfigured: boolean;
  missing: string[];
  warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

function readEnvironment(raw: string | undefined): InteropEnvironment {
  if (raw === "SANDBOX" || raw === "PRODUCTION") return raw;
  // Unset, empty or unrecognised means DISABLED. Failing closed is the only
  // safe default when the alternative is talking to a national health registry.
  return "DISABLED";
}

function readTimeout(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(parsed)));
}

export function getAbdmConfig(env: EnvSource = process.env): AbdmConfig {
  const environment = readEnvironment(env[ABDM_ENV_VARS.environment]);
  const requestTimeoutMs = readTimeout(env[ABDM_ENV_VARS.requestTimeoutMs]);
  const certificates = {
    clientCertPath: env[ABDM_ENV_VARS.clientCertPath]?.trim() || null,
    clientKeyPath: env[ABDM_ENV_VARS.clientKeyPath]?.trim() || null,
    caBundlePath: env[ABDM_ENV_VARS.caBundlePath]?.trim() || null,
  };

  if (environment === "DISABLED") {
    return {
      environment, baseUrl: null, cmId: null, abhaSuffix: null,
      clientId: null, clientSecret: null, callbackBaseUrl: null, callbackToken: null,
      requestTimeoutMs, certificates,
      configured: false, callbacksConfigured: false, missing: [], warnings: [],
    };
  }

  const preset = ABDM_ENVIRONMENTS[environment];
  const baseUrl = env[ABDM_ENV_VARS.baseUrlOverride]?.trim() || preset.baseUrl;
  const clientId = env[ABDM_ENV_VARS.clientId]?.trim() || null;
  const clientSecret = env[ABDM_ENV_VARS.clientSecret]?.trim() || null;
  const callbackBaseUrl = env[ABDM_ENV_VARS.callbackBaseUrl]?.trim() || null;
  const callbackToken = env[ABDM_ENV_VARS.callbackToken]?.trim() || null;

  const missing: string[] = [];
  if (!clientId) missing.push(ABDM_ENV_VARS.clientId);
  if (!clientSecret) missing.push(ABDM_ENV_VARS.clientSecret);

  const warnings: string[] = [];
  if (clientId && !ABDM_ID_PATTERNS.bridgeId.test(clientId)) {
    // Shape only — the value itself is never echoed.
    warnings.push(`${ABDM_ENV_VARS.clientId} does not look like an ABDM bridge id (expected e.g. SBX_000135).`);
  }
  if (env[ABDM_ENV_VARS.baseUrlOverride]?.trim() && env[ABDM_ENV_VARS.baseUrlOverride]?.trim() !== preset.baseUrl) {
    warnings.push(`${ABDM_ENV_VARS.baseUrlOverride} overrides the documented ${environment} base URL.`);
  }
  if (callbackBaseUrl && !/^https:\/\//i.test(callbackBaseUrl)) {
    // ABDM pushes health information to this URL; plaintext is not acceptable.
    warnings.push(`${ABDM_ENV_VARS.callbackBaseUrl} must be an https URL.`);
  }
  if (callbackBaseUrl && !callbackToken) {
    warnings.push(`${ABDM_ENV_VARS.callbackToken} is not set; inbound callbacks will be refused.`);
  }

  const callbacksConfigured =
    !!callbackBaseUrl && /^https:\/\//i.test(callbackBaseUrl) && !!callbackToken;

  return {
    environment,
    baseUrl,
    cmId: preset.cmId,
    abhaSuffix: preset.abhaSuffix,
    clientId,
    clientSecret,
    callbackBaseUrl,
    callbackToken,
    requestTimeoutMs,
    certificates,
    configured: missing.length === 0,
    callbacksConfigured,
    missing,
    warnings,
  };
}

/**
 * Refuse the two dangerous environment mismatches, plus a PRODUCTION selection
 * that is not fully configured. Production fails CLOSED: an unconfigured
 * production adapter reports a configuration error, never readiness.
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
    return {
      safe: false,
      warning: `ABDM ${config.environment} is selected but ${config.missing.join(", ")} ${config.missing.length === 1 ? "is" : "are"} not set.`,
    };
  }
  return { safe: true, warning: null };
}

/**
 * Redacted description for dashboards, logs and the connections API.
 *
 * Never exposes the client id, the secret, the callback token or certificate
 * contents — only whether each is present.
 */
export function describeAbdmConfig(config: AbdmConfig) {
  return {
    environment: config.environment,
    baseUrl: config.baseUrl,
    cmId: config.cmId,
    credentialsConfigured: config.configured,
    callbacksConfigured: config.callbacksConfigured,
    callbackBaseUrlConfigured: !!config.callbackBaseUrl,
    certificatesConfigured: {
      clientCert: !!config.certificates.clientCertPath,
      clientKey: !!config.certificates.clientKeyPath,
      caBundle: !!config.certificates.caBundlePath,
    },
    requestTimeoutMs: config.requestTimeoutMs,
    missing: config.missing,
    warnings: config.warnings,
  };
}

/** Guard against a secret accidentally being rendered anywhere. */
export function redact(value: string | null | undefined): string {
  if (!value) return "(not set)";
  return `(set, ${value.length} chars)`;
}
