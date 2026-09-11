/**
 * Phase C5 — NHCX configuration contract.
 *
 * Defines WHICH environment variables an operator must supply. Contains no
 * credential, no production endpoint default, and no fallback that could let a
 * misconfigured deployment start talking to a live claims network.
 *
 * The default is DISABLED. Aarogya bills, invoices, takes payments and issues
 * refunds with every one of these unset — claims exchange is an integration
 * layer, not a dependency of the revenue cycle.
 *
 * VARIABLE NAMES ARE PROVISIONAL. The real NHCX onboarding parameters are part
 * of the transport contract this phase could not verify, so these are Aarogya's
 * own naming rather than a claim about what NHCX requires. Recorded as such in
 * the contract matrix.
 */

export type NhcxEnvironment = "DISABLED" | "LOCAL" | "SANDBOX" | "PRODUCTION";

export const NHCX_ENV_VARS = {
  environment: "NHCX_ENVIRONMENT",
  baseUrl: "NHCX_BASE_URL",
  participantCode: "NHCX_PARTICIPANT_CODE",
  clientId: "NHCX_CLIENT_ID",
  clientSecret: "NHCX_CLIENT_SECRET",
  callbackUrl: "NHCX_CALLBACK_URL",
  callbackToken: "NHCX_CALLBACK_TOKEN",
  /** Filesystem / secret-manager REFERENCES only. Never the material itself. */
  certificatePath: "NHCX_CERTIFICATE_PATH",
  privateKeyPath: "NHCX_PRIVATE_KEY_PATH",
  requestTimeoutMs: "NHCX_REQUEST_TIMEOUT_MS",
} as const;

export type EnvSource = Record<string, string | undefined>;

export interface NhcxConfig {
  environment: NhcxEnvironment;
  baseUrl: string | null;
  participantCode: string | null;
  clientId: string | null;
  clientSecret: string | null;
  callbackUrl: string | null;
  callbackToken: string | null;
  certificatePath: string | null;
  privateKeyPath: string | null;
  requestTimeoutMs: number;
  configured: boolean;
  callbacksConfigured: boolean;
  missing: string[];
  warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;

function readEnvironment(raw: string | undefined): NhcxEnvironment {
  if (raw === "LOCAL" || raw === "SANDBOX" || raw === "PRODUCTION") return raw;
  // Unset, empty or unrecognised means DISABLED. Never inferred, and never
  // silently downgraded from PRODUCTION to something weaker.
  return "DISABLED";
}

export function getNhcxConfig(env: EnvSource = process.env): NhcxConfig {
  const environment = readEnvironment(env[NHCX_ENV_VARS.environment]);
  const timeoutRaw = Number(env[NHCX_ENV_VARS.requestTimeoutMs]);
  const requestTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.min(120_000, Math.max(1_000, Math.floor(timeoutRaw)))
    : DEFAULT_TIMEOUT_MS;

  const certificatePath = env[NHCX_ENV_VARS.certificatePath]?.trim() || null;
  const privateKeyPath = env[NHCX_ENV_VARS.privateKeyPath]?.trim() || null;

  if (environment === "DISABLED") {
    return {
      environment, baseUrl: null, participantCode: null, clientId: null, clientSecret: null,
      callbackUrl: null, callbackToken: null, certificatePath, privateKeyPath,
      requestTimeoutMs, configured: false, callbacksConfigured: false, missing: [], warnings: [],
    };
  }

  const baseUrl = env[NHCX_ENV_VARS.baseUrl]?.trim() || null;
  const participantCode = env[NHCX_ENV_VARS.participantCode]?.trim() || null;
  const clientId = env[NHCX_ENV_VARS.clientId]?.trim() || null;
  const clientSecret = env[NHCX_ENV_VARS.clientSecret]?.trim() || null;
  const callbackUrl = env[NHCX_ENV_VARS.callbackUrl]?.trim() || null;
  const callbackToken = env[NHCX_ENV_VARS.callbackToken]?.trim() || null;

  const missing: string[] = [];
  if (!baseUrl) missing.push(NHCX_ENV_VARS.baseUrl);
  if (!participantCode) missing.push(NHCX_ENV_VARS.participantCode);
  if (!clientId) missing.push(NHCX_ENV_VARS.clientId);
  if (!clientSecret) missing.push(NHCX_ENV_VARS.clientSecret);

  const warnings: string[] = [];
  if (callbackUrl && !/^https:\/\//i.test(callbackUrl)) {
    // Claim responses carry clinical and financial content; plaintext is not
    // acceptable.
    warnings.push(`${NHCX_ENV_VARS.callbackUrl} must be an https URL.`);
  }
  if (callbackUrl && !callbackToken) {
    warnings.push(`${NHCX_ENV_VARS.callbackToken} is not set; inbound callbacks will be refused.`);
  }
  warnings.push(
    "The NHCX transport contract is unverified, so no outbound call will be attempted regardless of configuration."
  );

  return {
    environment, baseUrl, participantCode, clientId, clientSecret,
    callbackUrl, callbackToken, certificatePath, privateKeyPath, requestTimeoutMs,
    configured: missing.length === 0,
    callbacksConfigured: !!callbackUrl && /^https:\/\//i.test(callbackUrl) && !!callbackToken,
    missing, warnings,
  };
}

/**
 * Refuse the dangerous environment mismatches. Production fails CLOSED: an
 * unconfigured production selection is an error, never a silent downgrade.
 */
export function checkNhcxEnvironmentSafety(
  config: NhcxConfig,
  nodeEnv: string | undefined = process.env.NODE_ENV
): { safe: boolean; warning: string | null } {
  if (config.environment === "DISABLED") return { safe: true, warning: null };
  if (nodeEnv === "production" && (config.environment === "SANDBOX" || config.environment === "LOCAL")) {
    return { safe: false, warning: `Production deployment is pointed at the NHCX ${config.environment} environment.` };
  }
  if (nodeEnv !== "production" && config.environment === "PRODUCTION") {
    return { safe: false, warning: "A non-production deployment is pointed at NHCX PRODUCTION." };
  }
  if (!config.configured) {
    return { safe: false, warning: `NHCX ${config.environment} is selected but ${config.missing.join(", ")} not set.` };
  }
  return { safe: true, warning: null };
}

/** Redacted description. Never exposes a secret, only whether one is present. */
export function describeNhcxConfig(config: NhcxConfig) {
  return {
    environment: config.environment,
    baseUrlConfigured: !!config.baseUrl,
    participantCodeConfigured: !!config.participantCode,
    credentialsConfigured: config.configured,
    callbacksConfigured: config.callbacksConfigured,
    certificatesConfigured: { certificate: !!config.certificatePath, privateKey: !!config.privateKeyPath },
    requestTimeoutMs: config.requestTimeoutMs,
    missing: config.missing,
    warnings: config.warnings,
  };
}
