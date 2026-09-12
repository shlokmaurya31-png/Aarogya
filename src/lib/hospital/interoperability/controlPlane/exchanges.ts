import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";

/**
 * Phase C6 — unified exchange operations view.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A READ MODEL, NOT A TABLE.
 *
 * C1/C3 own HealthInformationExchange and its ABDM protocol state. C5 owns
 * NhcxExchange and its protocol state. Both remain the canonical record for
 * their protocol, with their own state machines, and neither is modified here.
 *
 * This module projects them into ONE operational shape so an operator can ask
 * "what is happening across all our integrations" without three screens. It
 * deliberately creates no table: a third copy of exchange state would drift
 * from the two real ones within a release, and a duplicated state machine is
 * exactly what rule 17 forbids.
 *
 * The generic state below is a PROJECTION for display. Protocol-specific state
 * is carried alongside it, never replaced by it.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const OPERATIONAL_STATES = [
  "QUEUED",
  "AUTHORIZED",
  "DISPATCHED",
  "ACKNOWLEDGED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  /** Retry budget exhausted, or a conflict a human must resolve. */
  "REQUIRES_REVIEW",
] as const;
export type OperationalState = (typeof OPERATIONAL_STATES)[number];

export const FAILURE_CATEGORIES = [
  "AUTHENTICATION", "AUTHORIZATION", "CONSENT", "VALIDATION", "NETWORK", "TIMEOUT",
  "RATE_LIMIT", "PROTOCOL", "EXTERNAL_SYSTEM", "DUPLICATE", "CONFLICT",
  "CONFIGURATION", "CERTIFICATE", "UNKNOWN",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * Only genuinely transient categories retry automatically.
 *
 * CONSENT and AUTHORIZATION are never retryable, and that is a privacy control
 * rather than an efficiency one: retrying a refused disclosure until it
 * succeeds is precisely the behaviour a consent model exists to prevent.
 * DUPLICATE is not retryable because the far side already has the request.
 */
const AUTO_RETRYABLE: Record<FailureCategory, boolean> = {
  AUTHENTICATION: false,
  AUTHORIZATION: false,
  CONSENT: false,
  VALIDATION: false,
  NETWORK: true,
  TIMEOUT: true,
  RATE_LIMIT: true,
  PROTOCOL: false,
  EXTERNAL_SYSTEM: true,
  DUPLICATE: false,
  CONFLICT: false,
  CONFIGURATION: false,
  CERTIFICATE: false,
  UNKNOWN: false,
};

export function isAutoRetryable(category: string): boolean {
  return AUTO_RETRYABLE[category as FailureCategory] ?? false;
}

/**
 * Normalise a protocol-specific failure label onto the shared vocabulary.
 * Anything unrecognised becomes UNKNOWN, which is deliberately NOT retryable —
 * "we do not know what happened" is not a reason to send clinical data again.
 */
export function normaliseFailureCategory(raw: string | null | undefined): FailureCategory {
  if (!raw) return "UNKNOWN";
  const v = raw.toUpperCase();
  if ((FAILURE_CATEGORIES as readonly string[]).includes(v)) return v as FailureCategory;
  // C2/C3 ABDM error labels that do not share the C5 spelling.
  if (v.includes("AUTHENTICATION") || v.includes("AUTH_FAIL")) return "AUTHENTICATION";
  if (v.includes("FORBIDDEN") || v.includes("AUTHORIZATION")) return "AUTHORIZATION";
  if (v.includes("CONSENT")) return "CONSENT";
  if (v.includes("VALIDATION") || v.includes("MALFORMED") || v.includes("SCHEMA")) return "VALIDATION";
  if (v.includes("TIMEOUT")) return "TIMEOUT";
  if (v.includes("NETWORK") || v.includes("CONNECT")) return "NETWORK";
  if (v.includes("RATE")) return "RATE_LIMIT";
  if (v.includes("CERT")) return "CERTIFICATE";
  if (v.includes("CONFIG")) return "CONFIGURATION";
  if (v.includes("DUPLICATE")) return "DUPLICATE";
  if (v.includes("CONFLICT")) return "CONFLICT";
  if (v.includes("PROTOCOL") || v.includes("NOT_IMPLEMENTED")) return "PROTOCOL";
  if (v.includes("SERVER") || v.includes("EXTERNAL") || v.includes("TRANSIENT")) return "EXTERNAL_SYSTEM";
  return "UNKNOWN";
}

export interface UnifiedExchange {
  /** Stable operational handle: which table this came from, and its id. */
  source: "ABDM" | "NHCX";
  id: string;
  facilityId: string;
  system: string;
  environment: string | null;
  direction: string;
  operationalState: OperationalState;
  /** The protocol's own state, preserved verbatim. Never replaced. */
  protocolState: string | null;
  correlationId: string | null;
  externalReference: string | null;
  idempotencyKey: string | null;
  /** Present only when the exchange genuinely concerns one. */
  patientId: string | null;
  claimId: string | null;
  participantRef: string | null;
  failureCategory: FailureCategory | null;
  /** Safe operator-facing text. Never a payload. */
  failureMessage: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: Date | null;
  retryEligible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** ABDM/C1 local status → operational projection. */
function abdmOperationalState(row: {
  status: string; retryCount: number; maxRetries: number; abdmProtocolState: string | null;
}): OperationalState {
  switch (row.status) {
    case "REQUESTED": return "QUEUED";
    case "AUTHORIZED": return "AUTHORIZED";
    case "PROCESSING":
      // The gateway's own word takes precedence for display when we have it.
      if (row.abdmProtocolState === "ACKNOWLEDGED") return "ACKNOWLEDGED";
      if (row.abdmProtocolState === "SUBMITTED") return "DISPATCHED";
      return "PROCESSING";
    case "COMPLETED": return "COMPLETED";
    case "REJECTED": return "REJECTED";
    case "CANCELLED": return "CANCELLED";
    case "FAILED":
      // An exchange out of retries is not merely failed — it needs a human.
      return row.retryCount >= row.maxRetries ? "REQUIRES_REVIEW" : "FAILED";
    default: return "QUEUED";
  }
}

/** NHCX/C5 protocol state → operational projection. */
function nhcxOperationalState(row: {
  protocolState: string; attemptCount: number; maxAttempts: number;
}): OperationalState {
  switch (row.protocolState) {
    case "NOT_SUBMITTED": return "QUEUED";
    case "SUBMITTED": return "DISPATCHED";
    case "ACKNOWLEDGED": return "ACKNOWLEDGED";
    case "RESPONDED": return "COMPLETED";
    case "CANCELLED": return "CANCELLED";
    case "FAILED":
      return row.attemptCount >= row.maxAttempts ? "REQUIRES_REVIEW" : "FAILED";
    default: return "QUEUED";
  }
}

export interface ListExchangesArgs {
  facilityId: string;
  system?: string;
  state?: OperationalState;
  patientId?: string;
  /** Only exchanges that a human must look at. */
  requiresReviewOnly?: boolean;
  limit?: number;
}

/**
 * Project both canonical exchange tables into one list.
 *
 * Both queries are facility-scoped in their WHERE clause, not filtered after
 * the fact — a tenant boundary enforced in application code after a broad read
 * is a boundary waiting to be forgotten.
 */
export async function listUnifiedExchanges(args: ListExchangesArgs): Promise<UnifiedExchange[]> {
  const limit = Math.min(args.limit ?? 200, 500);
  const wantsAbdm = !args.system || args.system === "ABDM" || args.system === "FHIR";
  const wantsNhcx = !args.system || args.system === "NHCX";

  const [abdmRows, nhcxRows] = await Promise.all([
    wantsAbdm
      ? prisma.healthInformationExchange.findMany({
          where: {
            facilityId: args.facilityId,
            ...(args.patientId ? { patientId: args.patientId } : {}),
          },
          orderBy: { updatedAt: "desc" },
          take: limit,
        })
      : Promise.resolve([]),
    wantsNhcx
      ? prisma.nhcxExchange.findMany({
          where: { facilityId: args.facilityId },
          orderBy: { updatedAt: "desc" },
          take: limit,
        })
      : Promise.resolve([]),
  ]);

  const unified: UnifiedExchange[] = [
    ...abdmRows.map((r): UnifiedExchange => {
      const state = abdmOperationalState(r);
      const category = r.failureReason || r.lastError || r.abdmErrorCode
        ? normaliseFailureCategory(r.abdmErrorCode ?? r.failureReason ?? r.lastError)
        : null;
      return {
        source: "ABDM",
        id: r.id,
        facilityId: r.facilityId,
        system: r.destinationSystem,
        environment: null,
        direction: r.direction,
        operationalState: state,
        protocolState: r.abdmProtocolState,
        correlationId: r.correlationId,
        externalReference: r.externalRequestId,
        idempotencyKey: r.idempotencyKey,
        patientId: r.patientId,
        claimId: null,
        participantRef: r.destinationEndpoint,
        failureCategory: category,
        failureMessage: r.failureReason ?? r.lastError ?? null,
        attemptCount: r.retryCount,
        maxAttempts: r.maxRetries,
        nextRetryAt: r.nextRetryAt,
        retryEligible:
          state === "FAILED" && r.retryCount < r.maxRetries && isAutoRetryable(category ?? "UNKNOWN"),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    }),
    ...nhcxRows.map((r): UnifiedExchange => {
      const state = nhcxOperationalState(r);
      const category = r.errorCategory ? normaliseFailureCategory(r.errorCategory) : null;
      return {
        source: "NHCX",
        id: r.id,
        facilityId: r.facilityId,
        system: "NHCX",
        environment: null,
        direction: r.direction,
        operationalState: state,
        protocolState: r.protocolState,
        correlationId: r.correlationId,
        externalReference: r.externalReference,
        idempotencyKey: r.idempotencyKey,
        patientId: null,
        claimId: r.claimId,
        participantRef: null,
        failureCategory: category,
        failureMessage: r.errorMessage,
        attemptCount: r.attemptCount,
        maxAttempts: r.maxAttempts,
        nextRetryAt: r.nextRetryAt,
        retryEligible:
          state === "FAILED" && r.attemptCount < r.maxAttempts && isAutoRetryable(category ?? "UNKNOWN"),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    }),
  ];

  const filtered = unified
    .filter((e) => (args.state ? e.operationalState === args.state : true))
    .filter((e) => (args.requiresReviewOnly ? e.operationalState === "REQUIRES_REVIEW" : true))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return filtered.slice(0, limit);
}

export interface TimelineEntry {
  at: Date;
  event: string;
  /** Metadata only. Never a clinical or financial payload. */
  detail: string | null;
}

/**
 * Reconstruct what happened to one exchange.
 *
 * Built from timestamps and ledger rows that already exist. It carries no
 * payload: an operator reconstructing an incident needs to know that a callback
 * arrived and was rejected, not what was inside it.
 */
export async function getExchangeTimeline(
  facilityId: string, source: "ABDM" | "NHCX", id: string
): Promise<{ exchange: UnifiedExchange; timeline: TimelineEntry[] }> {
  const entries: TimelineEntry[] = [];

  if (source === "ABDM") {
    const r = await prisma.healthInformationExchange.findUnique({ where: { id } });
    if (!r || r.facilityId !== facilityId) throw new NotFoundError("Exchange not found.");

    entries.push({ at: r.requestedAt, event: "REQUESTED", detail: `purpose ${r.purpose}` });
    if (r.authorizedAt) entries.push({ at: r.authorizedAt, event: "AUTHORIZED", detail: null });
    if (r.processingStartedAt) entries.push({ at: r.processingStartedAt, event: "DISPATCHED", detail: r.destinationSystem });
    if (r.abdmLastEventAt) {
      entries.push({ at: r.abdmLastEventAt, event: "PROTOCOL_EVENT", detail: r.abdmProtocolState });
    }
    if (r.rejectedAt) entries.push({ at: r.rejectedAt, event: "REJECTED", detail: r.rejectionReason });
    if (r.failedAt) {
      entries.push({
        at: r.failedAt, event: "FAILED",
        detail: `${normaliseFailureCategory(r.abdmErrorCode ?? r.failureReason)} · attempt ${r.retryCount}/${r.maxRetries}`,
      });
    }
    if (r.completedAt) entries.push({ at: r.completedAt, event: "COMPLETED", detail: null });

    const callbacks = await prisma.abdmCallbackEvent.findMany({
      where: { facilityId, exchangeId: r.id }, orderBy: { receivedAt: "asc" }, take: 100,
    });
    for (const c of callbacks) {
      entries.push({
        at: c.receivedAt, event: "CALLBACK",
        detail: `${c.callbackKind} · ${c.status}${c.rejectionReason ? ` · ${c.rejectionReason}` : ""}`,
      });
    }

    const [exchange] = await listUnifiedExchanges({ facilityId, limit: 500 })
      .then((all) => all.filter((e) => e.source === "ABDM" && e.id === id));
    entries.sort((a, b) => a.at.getTime() - b.at.getTime());
    return { exchange, timeline: entries };
  }

  const r = await prisma.nhcxExchange.findUnique({ where: { id } });
  if (!r || r.facilityId !== facilityId) throw new NotFoundError("Exchange not found.");

  entries.push({ at: r.requestedAt, event: "REQUESTED", detail: r.exchangeType });
  if (r.submittedAt) entries.push({ at: r.submittedAt, event: "DISPATCHED", detail: null });
  if (r.acknowledgedAt) entries.push({ at: r.acknowledgedAt, event: "ACKNOWLEDGED", detail: null });
  if (r.completedAt) entries.push({ at: r.completedAt, event: "COMPLETED", detail: null });
  if (r.errorCategory) {
    entries.push({
      at: r.updatedAt, event: "FAILED",
      detail: `${normaliseFailureCategory(r.errorCategory)} · attempt ${r.attemptCount}/${r.maxAttempts}`,
    });
  }

  const callbacks = await prisma.nhcxCallbackEvent.findMany({
    where: { facilityId, exchangeId: r.id }, orderBy: { receivedAt: "asc" }, take: 100,
  });
  for (const c of callbacks) {
    entries.push({
      at: c.receivedAt, event: "CALLBACK",
      detail: `${c.messageType} · ${c.status}${c.rejectionReason ? ` · ${c.rejectionReason}` : ""}`,
    });
  }

  const [exchange] = await listUnifiedExchanges({ facilityId, system: "NHCX", limit: 500 })
    .then((all) => all.filter((e) => e.source === "NHCX" && e.id === id));
  entries.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { exchange, timeline: entries };
}

/** Unified callback ledger view across both protocols. Metadata only. */
export async function listUnifiedCallbacks(args: {
  facilityId: string; status?: string; system?: string; limit?: number;
}) {
  const limit = Math.min(args.limit ?? 200, 500);
  const wantsAbdm = !args.system || args.system === "ABDM";
  const wantsNhcx = !args.system || args.system === "NHCX";

  const [abdm, nhcx] = await Promise.all([
    wantsAbdm
      ? prisma.abdmCallbackEvent.findMany({
          where: { facilityId: args.facilityId, ...(args.status ? { status: args.status } : {}) },
          orderBy: { receivedAt: "desc" }, take: limit,
        })
      : Promise.resolve([]),
    wantsNhcx
      ? prisma.nhcxCallbackEvent.findMany({
          where: { facilityId: args.facilityId, ...(args.status ? { status: args.status } : {}) },
          orderBy: { receivedAt: "desc" }, take: limit,
        })
      : Promise.resolve([]),
  ]);

  return [
    ...abdm.map((c) => ({
      source: "ABDM" as const,
      id: c.id,
      system: "ABDM",
      kind: c.callbackKind,
      status: c.status,
      rejectionReason: c.rejectionReason,
      correlationId: c.externalRequestId,
      exchangeId: c.exchangeId,
      receivedAt: c.receivedAt,
    })),
    ...nhcx.map((c) => ({
      source: "NHCX" as const,
      id: c.id,
      system: "NHCX",
      kind: c.messageType,
      status: c.status,
      rejectionReason: c.rejectionReason,
      correlationId: c.correlationId,
      exchangeId: c.exchangeId,
      receivedAt: c.receivedAt,
    })),
  ]
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    .slice(0, limit);
}
