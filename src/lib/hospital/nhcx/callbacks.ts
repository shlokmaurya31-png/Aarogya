import { timingSafeEqual, createHash } from "crypto";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { NhcxError } from "./errors";
import { getNhcxConfig, type NhcxConfig } from "./config";
import {
  PROTOCOL_TRANSITIONS, isTransitionAllowed, canonicalStatusForAdjudication,
  type ProtocolState,
} from "./stateMachines";
import { NHCX_ADJUDICATION_OUTCOMES } from "./contract";

/**
 * Phase C5 — inbound claims callback boundary.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THREAT MODEL
 *
 * This endpoint is public by necessity and carries FINANCIAL consequence: a
 * forged "approved, settled ₹400,000" message is an attack on money, not just
 * on data. It is treated as hostile input throughout.
 *
 * Controls, in order:
 *   1. AUTHENTICATE   — deployment-configured shared secret, constant-time.
 *                       Unset means callbacks are REFUSED, never accepted.
 *   2. BOUND          — timestamp must be within a narrow window.
 *   3. CORRELATE      — must name an exchange WE created, in the facility that
 *                       owns it. Correlation ids are server-generated UUIDs.
 *   4. DE-DUPLICATE   — unique (facility, messageType, externalEventId).
 *   5. DERIVE         — claim, facility and patient come from the correlated
 *                       exchange. The body cannot nominate any of them.
 *
 * NOTE ON SIGNATURES: the HCX protocol specification was not retrievable
 * (HTTP 403), so the official callback signature/JWE mechanism is unknown. No
 * signature verification is implemented, because inventing one would be
 * security theatre. The shared secret is what actually protects this endpoint,
 * and the gap is recorded in the contract matrix.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const NHCX_CALLBACK_TOKEN_HEADER = "x-nhcx-callback-token";
export const CALLBACK_MAX_SKEW_MS = 10 * 60_000;
export const MAX_CALLBACK_BYTES = 2 * 1024 * 1024;

export type CallbackStatus = "ACCEPTED" | "DUPLICATE" | "UNMATCHED" | "REJECTED" | "CONFLICT";

export interface CallbackEnvelope {
  messageType: string;
  rawBody: string;
  headers: { token?: string | null; timestamp?: string | null; correlationId?: string | null };
  sourceAddress?: string | null;
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Burn a comparison so timing does not distinguish wrong-length from
    // wrong-value.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function authenticateCallback(config: NhcxConfig, token: string | null | undefined): void {
  if (config.environment === "DISABLED") {
    throw new NhcxError({ category: "CONFIGURATION", message: "NHCX is disabled; callbacks are not accepted." });
  }
  if (!config.callbackToken) {
    // Fail closed. An unset secret must never mean "accept everyone".
    throw new NhcxError({ category: "AUTHENTICATION", message: "No callback token is configured; inbound callbacks are refused." });
  }
  if (!token || !secretsMatch(token, config.callbackToken)) {
    throw new NhcxError({ category: "AUTHENTICATION", message: "Callback authentication failed." });
  }
}

export function validateCallbackTimestamp(ts: string | null | undefined, now = Date.now()): void {
  if (!ts) throw new NhcxError({ category: "VALIDATION", message: "Callback is missing a timestamp." });
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) throw new NhcxError({ category: "VALIDATION", message: "Callback timestamp is not a valid instant." });
  if (Math.abs(now - parsed) > CALLBACK_MAX_SKEW_MS) {
    throw new NhcxError({ category: "VALIDATION", message: "Callback timestamp is outside the accepted window." });
  }
}

/** Read the outcome defensively. Nothing is coerced; unknown yields null. */
export function readCallbackOutcome(parsed: unknown): {
  outcome: string | null;
  externalReference: string | null;
  externalEventId: string | null;
  approvedAmountMinor: number | null;
  rejectionReason: string | null;
  queryText: string | null;
} {
  const out = {
    outcome: null as string | null, externalReference: null as string | null,
    externalEventId: null as string | null, approvedAmountMinor: null as number | null,
    rejectionReason: null as string | null, queryText: null as string | null,
  };
  if (!parsed || typeof parsed !== "object") return out;
  const r = parsed as Record<string, unknown>;

  const str = (v: unknown, max = 128) => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);
  out.externalEventId = str(r.eventId) ?? str(r.messageId);
  out.externalReference = str(r.externalReference) ?? str(r.claimReference);
  out.rejectionReason = str(r.rejectionReason, 500);
  out.queryText = str(r.queryText, 2000);

  const outcome = str(r.outcome, 32) ?? str(r.status, 32);
  if (outcome && (NHCX_ADJUDICATION_OUTCOMES as readonly string[]).includes(outcome.toUpperCase())) {
    out.outcome = outcome.toUpperCase();
  }

  // Amounts are accepted ONLY as integers. A float or a string would be a
  // rounding hazard on money, so it is rejected rather than coerced.
  const amt = r.approvedAmountMinor;
  if (typeof amt === "number" && Number.isInteger(amt) && amt >= 0 && amt <= Number.MAX_SAFE_INTEGER) {
    out.approvedAmountMinor = amt;
  }
  return out;
}

export interface CallbackResult {
  status: CallbackStatus;
  eventId: string | null;
  exchangeId: string | null;
  protocolState?: string | null;
  reason?: string;
}

/**
 * Receive, verify and record one callback.
 *
 * Business outcomes (duplicate, unmatched, conflict) are RETURNED so the route
 * can answer 202 — the network must not be encouraged to retry something we
 * deliberately ignored. Security failures THROW.
 */
export async function receiveCallback(args: {
  config: NhcxConfig;
  envelope: CallbackEnvelope;
  byUserId?: string | null;
}): Promise<CallbackResult> {
  const { config, envelope } = args;

  authenticateCallback(config, envelope.headers.token);
  validateCallbackTimestamp(envelope.headers.timestamp);

  const bytes = Buffer.byteLength(envelope.rawBody ?? "", "utf8");
  if (bytes === 0) throw new NhcxError({ category: "VALIDATION", message: "Callback body is empty." });
  if (bytes > MAX_CALLBACK_BYTES) throw new NhcxError({ category: "VALIDATION", message: "Callback body exceeds the accepted size." });

  let parsed: unknown;
  try { parsed = JSON.parse(envelope.rawBody); }
  catch { throw new NhcxError({ category: "VALIDATION", message: "Callback body is not valid JSON." }); }

  const info = readCallbackOutcome(parsed);
  const correlationId = envelope.headers.correlationId
    ?? (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).correlationId : null);
  if (typeof correlationId !== "string" || !correlationId || correlationId.length > 128) {
    throw new NhcxError({ category: "VALIDATION", message: "Callback does not carry a usable correlation id." });
  }
  const externalEventId = info.externalEventId ?? correlationId;
  const payloadHash = createHash("sha256").update(envelope.rawBody).digest("hex");

  // Correlate to an exchange WE created. The body cannot nominate a facility.
  const exchange = await prisma.nhcxExchange.findUnique({ where: { correlationId } });

  const base = {
    facilityId: exchange?.facilityId ?? "UNMATCHED",
    exchangeId: exchange?.id ?? null,
    correlationId,
    externalEventId,
    messageType: envelope.messageType,
    payloadHash,
    payloadBytes: bytes,
    sourceAddress: envelope.sourceAddress ?? null,
  };

  if (!exchange) {
    // Recorded for abuse investigation, but creates no claim state whatsoever.
    await recordAuditEvent(
      "hospital.claim.callbackRejected",
      args.byUserId ?? null,
      { correlationId, messageType: envelope.messageType, reason: "no matching exchange" },
      {}
    );
    return { status: "UNMATCHED", eventId: null, exchangeId: null, reason: "No matching exchange." };
  }

  try {
    const event = await prisma.nhcxCallbackEvent.create({
      data: { ...base, status: "ACCEPTED", processedAt: new Date() },
    });

    const protocolState = await applyCallback({
      exchange, info, messageType: envelope.messageType, byUserId: args.byUserId ?? null,
    });

    await recordAuditEvent(
      "hospital.claim.callbackReceived",
      args.byUserId ?? null,
      {
        exchangeId: exchange.id, correlationId, messageType: envelope.messageType,
        outcome: info.outcome, protocolState,
      },
      { facilityId: exchange.facilityId }
    );
    return { status: "ACCEPTED", eventId: event.id, exchangeId: exchange.id, protocolState };
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      // The unique constraint IS the replay guard.
      await recordAuditEvent(
        "hospital.claim.callbackReplayed",
        args.byUserId ?? null,
        { exchangeId: exchange.id, correlationId, messageType: envelope.messageType },
        { facilityId: exchange.facilityId }
      );
      return { status: "DUPLICATE", eventId: null, exchangeId: exchange.id, reason: "Already processed." };
    }
    throw e;
  }
}

/**
 * Apply a verified callback to the exchange and, where the outcome is a real
 * decision, to the canonical claim.
 *
 * An illegal protocol transition is recorded and IGNORED rather than thrown:
 * the callback was authentic, so rejecting the delivery would make the network
 * retry something we have deliberately refused.
 */
async function applyCallback(args: {
  exchange: { id: string; facilityId: string; protocolState: string; claimId: string | null; submissionId: string | null; version: number };
  info: ReturnType<typeof readCallbackOutcome>;
  messageType: string;
  byUserId: string | null;
}): Promise<string> {
  const { exchange, info } = args;

  const target: ProtocolState = info.outcome ? "RESPONDED" : "ACKNOWLEDGED";
  if (!isTransitionAllowed(PROTOCOL_TRANSITIONS, exchange.protocolState, target)) {
    await recordAuditEvent(
      "hospital.claim.callbackRejected",
      args.byUserId,
      {
        exchangeId: exchange.id, reason: "illegal protocol transition",
        from: exchange.protocolState, attempted: target,
      },
      { facilityId: exchange.facilityId }
    );
    return exchange.protocolState;
  }

  await prisma.nhcxExchange.update({
    where: { id: exchange.id },
    data: {
      protocolState: target,
      ...(target === "RESPONDED" ? { completedAt: new Date() } : { acknowledgedAt: new Date() }),
      ...(info.externalReference ? { externalReference: info.externalReference } : {}),
      version: { increment: 1 },
    },
  });

  if (!info.outcome || !exchange.claimId) return target;

  // ── Record the adjudication ─────────────────────────────────────────────
  const canonical = canonicalStatusForAdjudication(info.outcome);
  const claim = await prisma.claim.findUnique({ where: { id: exchange.claimId } });
  if (!claim || claim.facilityId !== exchange.facilityId) return target;

  if (exchange.submissionId) {
    await prisma.claimSubmission.updateMany({
      where: { id: exchange.submissionId, facilityId: exchange.facilityId },
      data: {
        status: info.outcome === "REJECTED" ? "REJECTED" : "ACCEPTED",
        approvedAmountMinor: info.approvedAmountMinor,
        respondedAt: new Date(),
      },
    });
  }

  if (canonical) {
    const { isClaimTransitionAllowed } = await import("@/lib/hospital/billing/claims");
    if (isClaimTransitionAllowed(claim.status, canonical)) {
      await prisma.claim.updateMany({
        where: { id: claim.id, status: claim.status },
        data: {
          status: canonical as never,
          // The ORIGINAL claimed amount is never overwritten — approved is a
          // separate column precisely so both survive for reconciliation.
          ...(info.approvedAmountMinor !== null ? { approvedAmountMinor: info.approvedAmountMinor } : {}),
          decidedAt: new Date(),
          ...(info.rejectionReason ? { denialReason: info.rejectionReason } : {}),
        },
      });
    }
  }

  await recordAuditEvent(
    "hospital.claim.adjudicationRecorded",
    args.byUserId,
    {
      claimId: claim.id, exchangeId: exchange.id, outcome: info.outcome,
      approvedAmountMinor: info.approvedAmountMinor, canonicalStatus: canonical,
    },
    { facilityId: exchange.facilityId }
  );
  return target;
}

export function getCallbackConfig(): NhcxConfig {
  return getNhcxConfig();
}
