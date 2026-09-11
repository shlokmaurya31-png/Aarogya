import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { ABDM_ENDPOINTS } from "./contract";
import type { AbdmConfig } from "./config";
import { abdmRequest, type FetchLike } from "./transport";
import { withAbdmSession } from "./session";
import { InteropError, configurationError } from "./errors";
import { consumeRateLimit, RateLimitExceededError } from "./rateLimit";
import {
  buildConsentRequestBody, buildConsentStatusBody, buildConsentFetchBody,
  buildHealthInformationRequestBody, readConsentRequestId,
  type BuildConsentRequestInput, type BuildHealthInformationRequestInput,
} from "./requests";
import { isProtocolTransitionAllowed, type AbdmProtocolState } from "./protocolState";

/**
 * Phase C3 — ABDM transport client.
 *
 * Sits behind the C2 adapter boundary and is responsible for exactly one thing:
 * turning a validated request into an authenticated, rate-limited, correlated
 * HTTP call and normalising what comes back.
 *
 * It deliberately contains NO:
 *   - clinical business logic
 *   - consent decisions        (consent.ts / exchange.ts own those)
 *   - patient matching         (fhir/import.ts owns that)
 *   - FHIR mapping             (fhir/mappers.ts owns that)
 *
 * Every function here refuses when ABDM is not configured. None of them can
 * produce a successful-looking result without a real gateway response.
 */

export interface AbdmCallResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
  /** Our REQUEST-ID, which is also the correlation handle. */
  requestId: string;
  durationMs: number;
}

function assertUsable(config: AbdmConfig, operation: string) {
  if (config.environment === "DISABLED") {
    throw configurationError(`ABDM is disabled; ${operation} was not attempted.`);
  }
  if (!config.configured) {
    throw configurationError(`ABDM ${operation} requires ${config.missing.join(", ")}.`);
  }
  // C3 is SANDBOX ONLY. Production traffic stays off until a dedicated
  // production-readiness phase enables it deliberately.
  if (config.environment === "PRODUCTION") {
    throw configurationError(
      "ABDM PRODUCTION traffic is not enabled. Phase C3 is sandbox-only by design; " +
      "enabling production requires an explicit production-readiness phase."
    );
  }
}

/**
 * Send one authenticated ABDM call.
 *
 * The session token is acquired through withAbdmSession, which handles a single
 * refresh on a stale token. Rate limiting is applied BEFORE authentication so a
 * burst cannot even consume session calls.
 */
async function send<T>(args: {
  config: AbdmConfig;
  operation: string;
  path: string;
  body: unknown;
  requestId?: string;
  fetchImpl?: FetchLike;
}): Promise<AbdmCallResult<T>> {
  assertUsable(args.config, args.operation);

  try {
    consumeRateLimit(args.operation);
  } catch (e) {
    if (e instanceof RateLimitExceededError) {
      throw new InteropError({
        kind: "RATE_LIMITED",
        message: e.message,
        retryable: true,
      });
    }
    throw e;
  }

  const requestId = args.requestId ?? randomUUID();

  return withAbdmSession(args.config, async (session) => {
    const response = await abdmRequest<T>({
      config: args.config,
      path: args.path,
      method: "POST",
      body: args.body,
      operation: args.operation,
      context: {
        requestId,
        accessToken: session.accessToken,
        hiuId: args.config.clientId,
      },
      fetchImpl: args.fetchImpl,
    });
    return {
      ok: true,
      status: response.status,
      body: response.body,
      requestId: response.requestId,
      durationMs: response.durationMs,
    };
  }, { fetchImpl: args.fetchImpl });
}

/**
 * Persist the correlation between our exchange and the gateway's request id,
 * and advance the ABDM protocol state.
 *
 * Correlation is written from the SERVER-generated REQUEST-ID, never from
 * anything a client supplied, which is what lets the callback router trust a
 * correlation match later.
 */
export async function recordProtocolTransition(args: {
  exchangeId: string;
  facilityId: string;
  to: AbdmProtocolState;
  correlationId?: string | null;
  abdmConsentId?: string | null;
  abdmTransactionId?: string | null;
  errorCode?: string | null;
  byUserId: string;
}) {
  const exchange = await prisma.healthInformationExchange.findUnique({ where: { id: args.exchangeId } });
  if (!exchange || exchange.facilityId !== args.facilityId) throw new NotFoundError("Exchange not found.");

  if (!isProtocolTransitionAllowed(exchange.abdmProtocolState, args.to)) {
    throw new BadRequestError(
      `Illegal ABDM protocol transition ${exchange.abdmProtocolState ?? "NOT_SUBMITTED"} -> ${args.to}.`
    );
  }

  const updated = await prisma.healthInformationExchange.update({
    where: { id: exchange.id },
    data: {
      abdmProtocolState: args.to,
      abdmLastEventAt: new Date(),
      ...(args.correlationId ? { correlationId: args.correlationId, externalRequestId: args.correlationId } : {}),
      ...(args.abdmConsentId ? { abdmConsentId: args.abdmConsentId } : {}),
      ...(args.abdmTransactionId ? { abdmTransactionId: args.abdmTransactionId } : {}),
      ...(args.errorCode !== undefined ? { abdmErrorCode: args.errorCode } : {}),
      version: { increment: 1 },
    },
  });

  await recordAuditEvent(
    "hospital.interop.abdmProtocolStateChanged",
    args.byUserId,
    {
      exchangeId: exchange.id,
      from: exchange.abdmProtocolState ?? "NOT_SUBMITTED",
      to: args.to,
      // Correlation id is an opaque UUID, safe to audit. No payload, no token.
      correlationId: args.correlationId ?? exchange.correlationId,
      errorCode: args.errorCode ?? null,
    },
    { facilityId: args.facilityId, patientId: exchange.patientId ?? undefined }
  );
  return updated;
}

/**
 * Initiate a consent request against the real gateway.
 *
 * The caller is responsible for having already established that this exchange
 * is locally authorized — this function does not re-decide consent, it
 * transmits a request the domain layer has already approved.
 */
export async function sendConsentRequest(args: {
  config: AbdmConfig;
  exchangeId: string;
  facilityId: string;
  request: BuildConsentRequestInput;
  byUserId: string;
  fetchImpl?: FetchLike;
}) {
  const body = buildConsentRequestBody(args.request);
  const requestId = randomUUID();

  await recordAuditEvent(
    "hospital.interop.abdmRequestSent",
    args.byUserId,
    { operation: "consentRequestInit", exchangeId: args.exchangeId, requestId },
    { facilityId: args.facilityId }
  );

  try {
    const result = await send({
      config: args.config,
      operation: "consentRequestInit",
      path: ABDM_ENDPOINTS.consentRequestInit,
      body,
      requestId,
      fetchImpl: args.fetchImpl,
    });

    // The CM returns the consent request id; if it does not, our own
    // REQUEST-ID remains the correlation handle for the callback.
    const consentRequestId = readConsentRequestId(result.body) ?? result.requestId;

    await recordProtocolTransition({
      exchangeId: args.exchangeId,
      facilityId: args.facilityId,
      to: "SUBMITTED",
      correlationId: consentRequestId,
      byUserId: args.byUserId,
    });

    return { ...result, consentRequestId };
  } catch (error) {
    await handleProtocolFailure({
      error, exchangeId: args.exchangeId, facilityId: args.facilityId,
      operation: "consentRequestInit", byUserId: args.byUserId,
    });
    throw error;
  }
}

export async function sendConsentStatusRequest(args: {
  config: AbdmConfig;
  consentRequestId: string;
  facilityId: string;
  byUserId: string;
  fetchImpl?: FetchLike;
}) {
  const result = await send({
    config: args.config,
    operation: "consentRequestStatus",
    path: ABDM_ENDPOINTS.consentRequestStatus,
    body: buildConsentStatusBody(args.consentRequestId),
    fetchImpl: args.fetchImpl,
  });
  await recordAuditEvent(
    "hospital.interop.consentStatusSynchronised",
    args.byUserId,
    { consentRequestId: args.consentRequestId, requestId: result.requestId },
    { facilityId: args.facilityId }
  );
  return result;
}

export async function sendConsentFetch(args: {
  config: AbdmConfig;
  abdmConsentId: string;
  facilityId: string;
  byUserId: string;
  fetchImpl?: FetchLike;
}) {
  const result = await send({
    config: args.config,
    operation: "consentFetch",
    path: ABDM_ENDPOINTS.consentFetch,
    body: buildConsentFetchBody(args.abdmConsentId),
    fetchImpl: args.fetchImpl,
  });
  await recordAuditEvent(
    "hospital.interop.abdmRequestSent",
    args.byUserId,
    { operation: "consentFetch", requestId: result.requestId },
    { facilityId: args.facilityId }
  );
  return result;
}

/**
 * Request health information for a GRANTED consent artefact.
 *
 * Requires a CM-issued consent id: our local consent id is meaningless to the
 * gateway, and passing one would leak an internal identifier while failing.
 */
export async function sendHealthInformationRequest(args: {
  config: AbdmConfig;
  exchangeId: string;
  facilityId: string;
  request: BuildHealthInformationRequestInput;
  byUserId: string;
  fetchImpl?: FetchLike;
}) {
  const body = buildHealthInformationRequestBody(args.request);

  try {
    const result = await send({
      config: args.config,
      operation: "healthInformationRequest",
      path: ABDM_ENDPOINTS.healthInformationRequest,
      body,
      fetchImpl: args.fetchImpl,
    });
    await recordAuditEvent(
      "hospital.interop.abdmRequestSent",
      args.byUserId,
      { operation: "healthInformationRequest", exchangeId: args.exchangeId, requestId: result.requestId },
      { facilityId: args.facilityId }
    );
    return result;
  } catch (error) {
    await handleProtocolFailure({
      error, exchangeId: args.exchangeId, facilityId: args.facilityId,
      operation: "healthInformationRequest", byUserId: args.byUserId,
    });
    throw error;
  }
}

/**
 * Record a failed protocol call.
 *
 * Best-effort: a protocol failure must never be masked by a secondary failure
 * while recording it, so the recording error is swallowed and the ORIGINAL
 * error continues to propagate to the caller.
 */
async function handleProtocolFailure(args: {
  error: unknown;
  exchangeId: string;
  facilityId: string;
  operation: string;
  byUserId: string;
}) {
  const err = args.error instanceof InteropError ? args.error : null;
  try {
    await recordAuditEvent(
      "hospital.interop.abdmRequestFailed",
      args.byUserId,
      {
        operation: args.operation,
        exchangeId: args.exchangeId,
        kind: err?.kind ?? "UNKNOWN_EXTERNAL_ERROR",
        externalCode: err?.externalCode ?? null,
        retryable: err?.retryable ?? false,
      },
      { facilityId: args.facilityId }
    );
    // Only a genuine gateway protocol error moves the protocol state. A local
    // configuration or rate-limit refusal never reached ABDM, so claiming
    // ERRORED would misrepresent what happened.
    const reachedGateway = err && !["CONFIGURATION_ERROR", "RATE_LIMITED"].includes(err.kind);
    if (reachedGateway) {
      await recordProtocolTransition({
        exchangeId: args.exchangeId,
        facilityId: args.facilityId,
        to: "ERRORED",
        errorCode: err?.externalCode ?? null,
        byUserId: args.byUserId,
      });
    }
  } catch {
    // Deliberately ignored — see above.
  }
}
