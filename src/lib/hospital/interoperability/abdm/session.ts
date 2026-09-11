import { ABDM_ENDPOINTS, ABDM_GRANT_TYPE } from "./contract";
import type { AbdmConfig } from "./config";
import { checkEnvironmentSafety } from "./config";
import { abdmRequest, type FetchLike } from "./transport";
import { InteropError, configurationError } from "./errors";

/**
 * Phase C2 — ABDM SYSTEM authentication boundary.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT USER AUTHENTICATION.
 *
 * Aarogya has two completely separate authentication concerns:
 *
 *   1. A clinician signing into Aarogya  → src/lib/auth/session.ts
 *   2. Aarogya, as a registered ABDM bridge, authenticating to the gateway
 *      → THIS FILE
 *
 * They never mix. A doctor being logged in does not make Aarogya an
 * authenticated ABDM client, and an ABDM session token grants that doctor
 * nothing. The gateway token represents the DEPLOYMENT, not a person, which is
 * exactly why authorisation for a specific patient's data still comes from
 * consent, and why the token is never derived from or attached to a user session.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Contract (M3 doc §3.2.1):
 *   POST /api/hiecm/gateway/v3/sessions
 *   headers: REQUEST-ID, TIMESTAMP, X-CM-ID
 *   body:    { clientId, clientSecret, grantType: "client_credentials" }
 *   → 202 Accepted { accessToken, expiresIn, refreshExpiresIn, tokenType }
 */

export interface AbdmSession {
  accessToken: string;
  /** Absolute expiry, computed on receipt. */
  expiresAt: Date;
  tokenType: string;
}

interface SessionResponseBody {
  accessToken?: unknown;
  expiresIn?: unknown;
  tokenType?: unknown;
}

/**
 * Refresh this many milliseconds BEFORE the token actually expires, so a call
 * cannot start with a token that dies mid-flight.
 */
const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_TTL_SECONDS = 600;

/**
 * Process-wide token cache keyed by environment+clientId.
 *
 * Deliberately in-memory: a gateway token is short-lived and bearer-only, so
 * persisting it to the database would create a durable credential in backups
 * and audit exports for no benefit. A cold start simply re-authenticates.
 */
const cache = new Map<string, AbdmSession>();

function cacheKey(config: AbdmConfig): string {
  return `${config.environment}:${config.clientId ?? "none"}`;
}

export function clearSessionCache() {
  cache.clear();
}

function parseSession(body: unknown): AbdmSession {
  const raw = (body ?? {}) as SessionResponseBody;
  const token = raw.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new InteropError({
      kind: "AUTHENTICATION_ERROR",
      // The body is NOT echoed: it is an auth response.
      message: "ABDM session response did not contain an access token.",
    });
  }
  const ttlSeconds = typeof raw.expiresIn === "number" && raw.expiresIn > 0 ? raw.expiresIn : DEFAULT_TTL_SECONDS;
  return {
    accessToken: token,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    tokenType: typeof raw.tokenType === "string" ? raw.tokenType : "Bearer",
  };
}

function isUsable(session: AbdmSession | undefined): session is AbdmSession {
  return !!session && session.expiresAt.getTime() - EXPIRY_SKEW_MS > Date.now();
}

/**
 * Obtain a gateway session token, reusing a cached one while it is still valid.
 *
 * Fails CLOSED: a disabled, misconfigured or unsafe configuration throws a
 * CONFIGURATION_ERROR rather than returning anything a caller could mistake for
 * a working session.
 */
export async function getAbdmSession(
  config: AbdmConfig,
  options: { forceRefresh?: boolean; fetchImpl?: FetchLike } = {}
): Promise<AbdmSession> {
  if (config.environment === "DISABLED") {
    throw configurationError("ABDM is disabled; no session can be established.");
  }
  const safety = checkEnvironmentSafety(config);
  if (!safety.safe) {
    throw configurationError(safety.warning ?? "ABDM configuration is unsafe; refusing to authenticate.");
  }
  if (!config.clientId || !config.clientSecret) {
    throw configurationError(`ABDM credentials are incomplete: ${config.missing.join(", ")} not set.`);
  }

  const key = cacheKey(config);
  if (!options.forceRefresh) {
    const cached = cache.get(key);
    if (isUsable(cached)) return cached;
  }

  let response;
  try {
    response = await abdmRequest<SessionResponseBody>({
      config,
      path: ABDM_ENDPOINTS.session,
      method: "POST",
      operation: "session",
      // The session call is the one request that carries NO bearer token.
      body: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        grantType: ABDM_GRANT_TYPE,
      },
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    // OBSERVED AGAINST THE LIVE SANDBOX (2026-09-11): ABDM answers bad client
    // credentials with HTTP 400 + {"error":{"code":"ABDM-9999","message":
    // "Invalid user credentials"}}, not the 401 the status code alone would
    // imply. Left unhandled, the generic mapping classifies that as
    // VALIDATION_ERROR, and the health check then reports UNKNOWN instead of
    // AUTHENTICATION_FAILED — telling an operator with a bad secret to go
    // looking for a network fault.
    //
    // Retry behaviour is unaffected: both kinds are non-retryable. This is
    // purely so the diagnosis matches reality. Scoped to the session
    // operation, where a credential rejection is the only thing a 400 of this
    // shape can mean.
    if (error instanceof InteropError && error.httpStatus === 400) {
      throw new InteropError({
        kind: "AUTHENTICATION_ERROR",
        message: "The ABDM gateway rejected the configured client credentials.",
        externalCode: error.externalCode,
        httpStatus: error.httpStatus,
        requestId: error.requestId,
      });
    }
    throw error;
  }

  const session = parseSession(response.body);
  cache.set(key, session);
  return session;
}

/**
 * Run an operation with a valid token, transparently re-authenticating once if
 * the gateway rejects the token we believed was good.
 *
 * The retry is deliberately limited to ONE attempt and only for
 * AUTHENTICATION_ERROR — a persistent 401 means bad credentials, not a stale
 * token, and hammering the gateway would not fix it.
 */
export async function withAbdmSession<T>(
  config: AbdmConfig,
  operation: (session: AbdmSession) => Promise<T>,
  options: { fetchImpl?: FetchLike } = {}
): Promise<T> {
  const session = await getAbdmSession(config, { fetchImpl: options.fetchImpl });
  try {
    return await operation(session);
  } catch (error) {
    if (error instanceof InteropError && error.kind === "AUTHENTICATION_ERROR") {
      const refreshed = await getAbdmSession(config, { forceRefresh: true, fetchImpl: options.fetchImpl });
      return operation(refreshed);
    }
    throw error;
  }
}

/**
 * Token presence/expiry without exposing the token. Used by the health check
 * and the connections dashboard.
 */
export function describeCachedSession(config: AbdmConfig) {
  const session = cache.get(cacheKey(config));
  if (!session) return { cached: false, valid: false, expiresAt: null as string | null };
  return {
    cached: true,
    valid: isUsable(session),
    expiresAt: session.expiresAt.toISOString(),
  };
}
