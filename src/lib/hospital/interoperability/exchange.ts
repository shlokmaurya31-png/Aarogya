import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { assertExchangeAuthorized } from "./consent";
import { recordProvenance } from "./provenance";
import { getExchangeAdapter } from "./adapters/abdm";
import { exportPatientToFhir } from "./fhir/export";
import {
  EXCHANGE_DIRECTIONS, EXCHANGE_TRANSITIONS, CONSENT_PURPOSES,
  assertOneOf, isTransitionAllowed, assertStaffInFacility,
} from "./shared";

/**
 * Phase C1 — health information exchange lifecycle.
 *
 * The transactional shape matters more than the state machine here:
 *
 *   local transaction  -> create/authorize the exchange intent -> COMMIT
 *   (outside any transaction) -> adapter call -> record the outcome
 *
 * The external call is never inside a clinical transaction. An unreachable
 * national registry therefore cannot roll back, block or corrupt care that has
 * already happened — the exchange simply ends up FAILED with a reason, and the
 * hospital carries on.
 */

export class ExchangeConcurrencyError extends ConflictError {
  constructor(message = "This exchange changed concurrently. Refresh and try again.") {
    super(message);
  }
}

/**
 * Deterministic idempotency key. Two identical intents collapse to one exchange;
 * a retry from a double-clicked button or a network replay cannot create a
 * second external transfer.
 */
export function buildIdempotencyKey(parts: {
  facilityId: string; direction: string; destinationSystem: string;
  patientId?: string | null; purpose: string; scopes: string[]; consentId?: string | null;
  clientKey?: string | null;
}): string {
  if (parts.clientKey?.trim()) {
    // A caller-supplied key is still namespaced by facility so one facility can
    // never address, or collide with, another exchange.
    return createHash("sha256").update(`${parts.facilityId}|client|${parts.clientKey.trim()}`).digest("hex");
  }
  const canonical = [
    parts.facilityId, parts.direction, parts.destinationSystem,
    parts.patientId ?? "", parts.purpose, [...parts.scopes].sort().join(","), parts.consentId ?? "",
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export interface CreateExchangeInput {
  facilityId: string;
  patientId?: string | null;
  direction: string;
  purpose: string;
  scopes: string[];
  destinationSystem: string;
  destinationEndpoint?: string | null;
  consentId?: string | null;
  recipientIdentifier?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  requestedByStaffId?: string | null;
  byUserId: string;
}

/**
 * Create an exchange request. Authorization is evaluated at creation for
 * outbound patient data, so an unauthorized intent is never persisted.
 */
export async function createExchange(input: CreateExchangeInput) {
  assertOneOf(input.direction, EXCHANGE_DIRECTIONS, "direction");
  assertOneOf(input.purpose, CONSENT_PURPOSES, "purpose");
  if (!input.destinationSystem?.trim()) throw new BadRequestError("A destination system is required.");
  if (input.requestedByStaffId) await assertStaffInFacility(prisma, input.requestedByStaffId, input.facilityId);

  let scopes = [...new Set(input.scopes ?? [])];
  let consentId = input.consentId ?? null;

  if (input.direction === "OUTBOUND") {
    if (!input.patientId) throw new BadRequestError("An outbound exchange requires a patient.");
    const authorization = await assertExchangeAuthorized({
      facilityId: input.facilityId,
      patientId: input.patientId,
      purpose: input.purpose,
      scopes,
      consentId,
      recipientIdentifier: input.recipientIdentifier,
    });
    scopes = authorization.scopes;
    consentId = authorization.consent?.id ?? null;
  }

  const idempotencyKey = buildIdempotencyKey({
    facilityId: input.facilityId, direction: input.direction, destinationSystem: input.destinationSystem,
    patientId: input.patientId, purpose: input.purpose, scopes, consentId, clientKey: input.idempotencyKey,
  });

  const existing = await prisma.healthInformationExchange.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.facilityId !== input.facilityId) {
      // Defence in depth: keys are facility-namespaced, so this should be
      // unreachable, but a cross-facility hit must never return another
      // facility record.
      throw new ConflictError("That idempotency key is already in use.");
    }
    return { exchange: existing, deduplicated: true };
  }

  const exchange = await prisma.healthInformationExchange
    .create({
      data: {
        facilityId: input.facilityId,
        patientId: input.patientId ?? null,
        direction: input.direction,
        purpose: input.purpose,
        consentId,
        destinationSystem: input.destinationSystem.trim(),
        destinationEndpoint: input.destinationEndpoint ?? null,
        requestedScopes: scopes.join(","),
        idempotencyKey,
        correlationId: input.correlationId ?? null,
        requestedByStaffId: input.requestedByStaffId ?? null,
      },
    })
    .catch(async (e: unknown) => {
      if ((e as { code?: string })?.code === "P2002") {
        const raced = await prisma.healthInformationExchange.findUnique({ where: { idempotencyKey } });
        if (raced && raced.facilityId === input.facilityId) return raced;
        throw new ConflictError("That exchange was created concurrently.");
      }
      throw e;
    });

  await recordAuditEvent(
    "hospital.interop.exchangeRequested",
    input.byUserId,
    { exchangeId: exchange.id, direction: input.direction, purpose: input.purpose, scopes, destination: exchange.destinationSystem },
    { facilityId: input.facilityId, patientId: input.patientId ?? undefined }
  );
  return { exchange, deduplicated: false };
}

async function transition(
  exchangeId: string,
  facilityId: string,
  to: string,
  data: Record<string, unknown>,
  audit: { type: Parameters<typeof recordAuditEvent>[0]; detail: Record<string, unknown>; byUserId: string }
) {
  return prisma.$transaction(async (tx) => {
    const ex = await tx.healthInformationExchange.findUnique({ where: { id: exchangeId } });
    if (!ex || ex.facilityId !== facilityId) throw new NotFoundError("Exchange not found.");
    if (!isTransitionAllowed(EXCHANGE_TRANSITIONS, ex.status, to)) {
      throw new BadRequestError(`Illegal exchange transition ${ex.status} -> ${to}.`);
    }
    const r = await tx.healthInformationExchange.updateMany({
      where: { id: ex.id, status: ex.status, version: ex.version },
      data: { ...data, status: to, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ExchangeConcurrencyError();
    await tx.auditEvent.create({
      data: {
        type: audit.type, userId: audit.byUserId,
        detail: { exchangeId: ex.id, from: ex.status, to, ...audit.detail },
        facilityId: ex.facilityId, patientId: ex.patientId,
      },
    });
    return tx.healthInformationExchange.findUniqueOrThrow({ where: { id: ex.id } });
  });
}

/**
 * Authorize an exchange. Consent is re-checked HERE, not just at creation — a
 * consent revoked between request and authorization must block the transfer.
 */
export async function authorizeExchange(input: {
  facilityId: string; exchangeId: string; authorizedByStaffId?: string; byUserId: string;
}) {
  const ex = await prisma.healthInformationExchange.findUnique({ where: { id: input.exchangeId } });
  if (!ex || ex.facilityId !== input.facilityId) throw new NotFoundError("Exchange not found.");
  if (input.authorizedByStaffId) await assertStaffInFacility(prisma, input.authorizedByStaffId, input.facilityId);

  if (ex.direction === "OUTBOUND" && ex.patientId) {
    // Throws if consent has since been revoked, expired, or no longer covers
    // the requested scopes.
    await assertExchangeAuthorized({
      facilityId: ex.facilityId,
      patientId: ex.patientId,
      purpose: ex.purpose,
      scopes: ex.requestedScopes.split(",").filter(Boolean),
      consentId: ex.consentId,
    });
  }

  return transition(
    ex.id, input.facilityId, "AUTHORIZED",
    { authorizedAt: new Date(), authorizedByStaffId: input.authorizedByStaffId ?? null },
    { type: "hospital.interop.exchangeAuthorized", detail: {}, byUserId: input.byUserId }
  );
}

export async function rejectExchange(input: {
  facilityId: string; exchangeId: string; reason: string; byUserId: string;
}) {
  if (!input.reason?.trim()) throw new BadRequestError("A rejection reason is required.");
  return transition(
    input.exchangeId, input.facilityId, "REJECTED",
    { rejectedAt: new Date(), rejectionReason: input.reason },
    { type: "hospital.interop.exchangeRejected", detail: { reason: input.reason }, byUserId: input.byUserId }
  );
}

export async function cancelExchange(input: {
  facilityId: string; exchangeId: string; reason?: string; byUserId: string;
}) {
  return transition(
    input.exchangeId, input.facilityId, "CANCELLED",
    { rejectionReason: input.reason ?? null },
    { type: "hospital.interop.exchangeRejected", detail: { cancelled: true }, byUserId: input.byUserId }
  );
}

export interface DispatchOptions {
  /** Injected in tests; production resolves the configured adapter. */
  adapter?: ReturnType<typeof getExchangeAdapter>;
  timestamp?: Date;
}

/**
 * Execute an authorized outbound exchange.
 *
 * Composition and the adapter call both happen OUTSIDE any clinical
 * transaction. The only database writes are to the exchange row itself and to
 * provenance, so a remote failure is recorded as a failure and nothing else.
 */
export async function dispatchExchange(
  input: { facilityId: string; exchangeId: string; byUserId: string; actorStaffId?: string | null },
  options: DispatchOptions = {}
) {
  const started = await transition(
    input.exchangeId, input.facilityId, "PROCESSING",
    { processingStartedAt: new Date(), lastError: null },
    { type: "hospital.interop.exchangeProcessing", detail: {}, byUserId: input.byUserId }
  );

  if (started.direction !== "OUTBOUND") {
    return markFailed(started.id, input.facilityId, "Only outbound exchanges can be dispatched.", input.byUserId, false);
  }
  if (!started.patientId) {
    return markFailed(started.id, input.facilityId, "Exchange has no patient to export.", input.byUserId, false);
  }

  let bundle: unknown;
  let bundleHash: string;
  let resourceCount: number;
  try {
    const exported = await exportPatientToFhir({
      facilityId: started.facilityId,
      patientId: started.patientId,
      purpose: started.purpose,
      scopes: started.requestedScopes.split(",").filter(Boolean),
      consentId: started.consentId,
      exchangeId: started.id,
      correlationId: started.correlationId,
      actorStaffId: input.actorStaffId ?? null,
      byUserId: input.byUserId,
      timestamp: options.timestamp,
    });
    bundle = exported.bundle;
    bundleHash = exported.bundleHash;
    resourceCount = exported.resourceCount;
  } catch (e) {
    // A composition/authorization failure is permanent, not retryable.
    return markFailed(started.id, input.facilityId, e instanceof Error ? e.message : "Failed to compose the export.", input.byUserId, false);
  }

  const adapter = options.adapter ?? getExchangeAdapter(started.destinationSystem);
  const result = await adapter.send({
    facilityId: started.facilityId,
    patientId: started.patientId,
    correlationId: started.correlationId,
    idempotencyKey: started.idempotencyKey,
    body: bundle,
  });

  if (result.outcome !== "OK") {
    return markFailed(started.id, input.facilityId, result.message, input.byUserId, result.retryable, { bundleHash, resourceCount });
  }

  const completed = await transition(
    started.id, input.facilityId, "COMPLETED",
    {
      completedAt: new Date(),
      externalRequestId: result.externalRequestId ?? result.data?.externalRequestId ?? null,
      bundleHash, resourceCount, lastError: null, nextRetryAt: null,
    },
    { type: "hospital.interop.exchangeCompleted", detail: { resourceCount, bundleHash }, byUserId: input.byUserId }
  );

  await recordProvenance(prisma, {
    facilityId: started.facilityId,
    patientId: started.patientId,
    entityType: "EXCHANGE",
    entityId: started.id,
    direction: "OUTBOUND",
    dataOrigin: "DERIVED",
    sourceSystem: started.destinationSystem,
    externalResourceId: completed.externalRequestId,
    exchangeId: started.id,
    consentId: started.consentId,
    actorUserId: input.byUserId,
    actorStaffId: input.actorStaffId ?? null,
    correlationId: started.correlationId,
    payload: bundle,
    payloadContentType: "application/fhir+json",
  });

  return completed;
}

/**
 * Record a failure with bounded retry metadata. Only transient failures get a
 * nextRetryAt, and only until maxRetries — nothing retries forever, and a
 * failed exchange is never reported as delivered.
 */
async function markFailed(
  exchangeId: string, facilityId: string, reason: string, byUserId: string,
  retryable: boolean, extra: Record<string, unknown> = {}
) {
  const ex = await prisma.healthInformationExchange.findUniqueOrThrow({ where: { id: exchangeId } });
  const nextRetryCount = ex.retryCount + 1;
  const mayRetry = retryable && nextRetryCount < ex.maxRetries;
  // Exponential backoff: 1, 2, 4 minutes. Manual or operator-triggered.
  const backoffMs = Math.min(2 ** ex.retryCount, 8) * 60_000;

  return transition(
    exchangeId, facilityId, "FAILED",
    {
      ...extra,
      failedAt: new Date(),
      failureReason: reason,
      lastError: reason,
      retryCount: nextRetryCount,
      nextRetryAt: mayRetry ? new Date(Date.now() + backoffMs) : null,
    },
    { type: "hospital.interop.exchangeFailed", detail: { reason, retryable: mayRetry, retryCount: nextRetryCount }, byUserId }
  );
}

/**
 * Manually retry a failed exchange. Refuses once the retry budget is spent, so
 * a permanently broken destination cannot be hammered indefinitely.
 */
export async function retryExchange(
  input: { facilityId: string; exchangeId: string; byUserId: string; actorStaffId?: string | null },
  options: DispatchOptions = {}
) {
  const ex = await prisma.healthInformationExchange.findUnique({ where: { id: input.exchangeId } });
  if (!ex || ex.facilityId !== input.facilityId) throw new NotFoundError("Exchange not found.");
  if (ex.status !== "FAILED") throw new BadRequestError("Only a failed exchange can be retried.");
  if (ex.retryCount >= ex.maxRetries) {
    throw new BadRequestError(`This exchange has exhausted its ${ex.maxRetries} retry attempts.`);
  }
  return dispatchExchange(input, options);
}

export async function getExchange(facilityId: string, exchangeId: string) {
  const ex = await prisma.healthInformationExchange.findUnique({
    where: { id: exchangeId },
    include: { consent: { include: { scopes: true } } },
  });
  if (!ex || ex.facilityId !== facilityId) throw new NotFoundError("Exchange not found.");
  return ex;
}

export async function listExchanges(args: { facilityId: string; status?: string; patientId?: string }) {
  return prisma.healthInformationExchange.findMany({
    where: {
      facilityId: args.facilityId,
      ...(args.status ? { status: args.status } : {}),
      ...(args.patientId ? { patientId: args.patientId } : {}),
    },
    orderBy: { requestedAt: "desc" },
    take: 200,
  });
}
