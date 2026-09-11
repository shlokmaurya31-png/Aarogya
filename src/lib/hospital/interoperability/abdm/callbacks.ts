import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { hashPayload } from "../provenance";
import { ABDM_CALLBACK_PATHS, type AbdmCallbackKind } from "./contract";
import type { AbdmConfig } from "./config";
import { InteropError, callbackError } from "./errors";

/**
 * Phase C2 — inbound ABDM callback boundary.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THREAT MODEL
 *
 * The documented CM→HIU callbacks (M3 doc §4.3.3, §5) carry only REQUEST-ID,
 * TIMESTAMP and X-HIU-ID. None of those prove who sent the request: anybody who
 * learns the public callback URL can POST to it. A callback is therefore
 * treated as HOSTILE INPUT that happens to be shaped like a protocol message.
 *
 * Four independent controls, in order:
 *
 *   1. AUTHENTICATE  — a deployment-configured shared secret
 *                      (ABDM_CALLBACK_TOKEN) compared in constant time. Without
 *                      it configured, callbacks are refused outright rather
 *                      than accepted unauthenticated.
 *   2. CORRELATE     — the callback must name a request WE started. An
 *                      uncorrelated callback can never create state.
 *   3. DE-DUPLICATE  — a unique (facility, kind, externalRequestId) ledger row
 *                      means a replayed callback collides instead of being
 *                      processed twice.
 *   4. DERIVE        — patient, facility and actor come from the correlated
 *                      exchange, NEVER from the callback body.
 *
 * NOTE ON SIGNATURES: ABDM publishes a JWKS at /gateway/v3/certs, but the M3
 * document does not specify a signature over callback bodies. No signature
 * verification is implemented, because inventing one would be security
 * theatre. The shared-secret gate is what actually protects the endpoint, and
 * the gap is recorded in the contract matrix.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const CALLBACK_TOKEN_HEADER = "x-callback-token";

/** Reject callbacks whose TIMESTAMP is implausible — bounds any replay window. */
export const CALLBACK_MAX_SKEW_MS = 10 * 60_000;

export type CallbackStatus = "ACCEPTED" | "REJECTED" | "DUPLICATE" | "UNMATCHED";

export interface CallbackEnvelope {
  kind: AbdmCallbackKind;
  /** Raw body text, so size limits apply before parsing. */
  rawBody: string;
  headers: {
    token?: string | null;
    requestId?: string | null;
    timestamp?: string | null;
    hiuId?: string | null;
  };
  sourceAddress?: string | null;
}

export const MAX_CALLBACK_BYTES = 1024 * 1024; // 1 MB

/** Constant-time comparison that does not leak length through early exit. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so timing does not distinguish wrong-length from
    // wrong-value, then fail.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function authenticateCallback(config: AbdmConfig, token: string | null | undefined): void {
  if (config.environment === "DISABLED") {
    throw callbackError("ABDM is disabled; callbacks are not accepted.");
  }
  if (!config.callbackToken) {
    // Fail closed. An unconfigured secret must never mean "allow everyone".
    throw callbackError("No callback token is configured; inbound callbacks are refused.");
  }
  if (!token || !secretsMatch(token, config.callbackToken)) {
    throw callbackError("Callback authentication failed.");
  }
}

export function validateCallbackTimestamp(timestamp: string | null | undefined, now = Date.now()): void {
  if (!timestamp) throw callbackError("Callback is missing the TIMESTAMP header.");
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) throw callbackError("Callback TIMESTAMP is not a valid ISO instant.");
  if (Math.abs(now - parsed) > CALLBACK_MAX_SKEW_MS) {
    throw callbackError("Callback TIMESTAMP is outside the accepted window.");
  }
}

/**
 * Extract the external request id used for correlation and replay protection.
 * The documented callbacks echo the originating request id under
 * `response.requestId` (M3 doc §4.3.2); the REQUEST-ID header identifies the
 * callback delivery itself, so both are considered.
 */
export function extractExternalRequestId(parsed: unknown, headerRequestId: string | null | undefined): string | null {
  if (parsed && typeof parsed === "object") {
    const response = (parsed as Record<string, unknown>).response;
    if (response && typeof response === "object") {
      const rid = (response as Record<string, unknown>).requestId;
      if (typeof rid === "string" && rid.length > 0 && rid.length <= 128) return rid;
    }
  }
  if (typeof headerRequestId === "string" && headerRequestId.length > 0 && headerRequestId.length <= 128) {
    return headerRequestId;
  }
  return null;
}

export interface CallbackResult {
  status: CallbackStatus;
  eventId: string | null;
  exchangeId: string | null;
  reason?: string;
}

/**
 * Receive, verify and record one callback.
 *
 * Returns a result rather than throwing for business outcomes (duplicate,
 * unmatched) so the route can answer 202 — the gateway must not be encouraged
 * to retry a callback we have deliberately ignored. Genuine security failures
 * (bad token, bad timestamp, oversize) DO throw.
 */
export async function receiveCallback(args: {
  config: AbdmConfig;
  facilityId: string;
  envelope: CallbackEnvelope;
  byUserId?: string | null;
}): Promise<CallbackResult> {
  const { config, envelope, facilityId } = args;

  // 1 — authenticate before touching the body at all.
  authenticateCallback(config, envelope.headers.token);
  validateCallbackTimestamp(envelope.headers.timestamp);

  const bytes = Buffer.byteLength(envelope.rawBody ?? "", "utf8");
  if (bytes === 0) throw callbackError("Callback body is empty.");
  if (bytes > MAX_CALLBACK_BYTES) throw callbackError("Callback body exceeds the accepted size.");

  let parsed: unknown;
  try { parsed = JSON.parse(envelope.rawBody); }
  catch { throw callbackError("Callback body is not valid JSON."); }

  const externalRequestId = extractExternalRequestId(parsed, envelope.headers.requestId);
  if (!externalRequestId) {
    throw callbackError("Callback does not carry a request id to correlate against.");
  }

  const { hash } = hashPayload(parsed);

  // 2 — correlate to an exchange WE started, in THIS facility. The body cannot
  // nominate a facility or a patient; both are derived from the match.
  const exchange = await prisma.healthInformationExchange.findFirst({
    where: {
      facilityId,
      OR: [{ correlationId: externalRequestId }, { externalRequestId }],
    },
  });

  const baseData = {
    facilityId,
    callbackKind: envelope.kind,
    externalRequestId,
    correlationId: exchange?.correlationId ?? null,
    exchangeId: exchange?.id ?? null,
    consentId: exchange?.consentId ?? null,
    payloadHash: hash,
    payloadBytes: bytes,
    sourceAddress: envelope.sourceAddress ?? null,
  };

  // 3 — de-duplicate. The unique constraint is the actual replay guard; losing
  // the insert race means somebody already delivered this exact callback.
  try {
    const event = await prisma.abdmCallbackEvent.create({
      data: {
        ...baseData,
        status: exchange ? "ACCEPTED" : "UNMATCHED",
        rejectionReason: exchange ? null : "No matching exchange in this facility.",
        processedAt: new Date(),
      },
    });

    await recordAuditEvent(
      exchange ? "hospital.interop.callbackReceived" : "hospital.interop.callbackRejected",
      args.byUserId ?? null,
      {
        callbackKind: envelope.kind,
        externalRequestId,
        exchangeId: exchange?.id ?? null,
        matched: !!exchange,
      },
      { facilityId, patientId: exchange?.patientId ?? undefined }
    );

    return {
      status: exchange ? "ACCEPTED" : "UNMATCHED",
      eventId: event.id,
      exchangeId: exchange?.id ?? null,
      reason: exchange ? undefined : "No matching exchange in this facility.",
    };
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      await recordAuditEvent(
        "hospital.interop.callbackReplayed",
        args.byUserId ?? null,
        { callbackKind: envelope.kind, externalRequestId },
        { facilityId }
      );
      return {
        status: "DUPLICATE",
        eventId: null,
        exchangeId: exchange?.id ?? null,
        reason: "This callback has already been processed.",
      };
    }
    throw e;
  }
}

/** Callback paths this deployment exposes, for the bridge/url registration. */
export function describeCallbackRoutes(config: AbdmConfig) {
  const base = config.callbackBaseUrl;
  return Object.entries(ABDM_CALLBACK_PATHS).map(([kind, path]) => ({
    kind: kind as AbdmCallbackKind,
    path,
    url: base ? `${base.replace(/\/+$/, "")}${path}` : null,
  }));
}

export function isCallbackError(error: unknown): error is InteropError {
  return error instanceof InteropError && error.kind === "CALLBACK_ERROR";
}
