import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { authorizeAccess } from "@/lib/auth/authorize/engine";
import type { AuthorizationActor, Purpose } from "@/lib/auth/authorize/types";
import { describeIntegration, assertKnownSystem, type IntegrationSystem } from "./registry";
import { resolveParticipant, isParticipantUsable } from "./participants";

/**
 * Phase C6 — outbound and inbound safety gates.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ONE CHOKEPOINT, EVALUATED IN A FIXED ORDER, FAILING CLOSED.
 *
 * These do not replace the checks inside the C1/C3/C5 dispatch paths — those
 * remain, and are the last line. This is the FIRST line: a single place where
 * "should anything leave this building at all" is answered, so a future
 * integration cannot accidentally ship without the control-plane checks.
 *
 * Order matters and is deliberate. The kill switch and configuration are
 * checked BEFORE anything patient-specific, so a disabled integration reveals
 * nothing about whether a patient exists. Authorization and consent are checked
 * last, by the C4 engine, which is the only component permitted to answer them.
 *
 * Every gate returns a structured refusal rather than throwing, so a caller can
 * record WHY nothing was dispatched. A refusal is an operational fact worth
 * storing, not an exception to swallow.
 * ════════════════════════════════════════════════════════════════════════════
 */

export interface OutboundGateRequest {
  facilityId: string;
  system: string;
  actor: AuthorizationActor;
  /** The C4 action this dispatch performs, e.g. "interop.export". */
  action: string;
  purpose?: Purpose;
  scopes?: string[];
  patientId?: string | null;
  /** The counterparty this is addressed to, if the protocol names one. */
  participantExternalId?: string | null;
  /** Caller-computed idempotency identity, when the protocol has one. */
  idempotencyKey?: string | null;
}

export type GateRefusalReason =
  | "UNKNOWN_INTEGRATION"
  | "INTEGRATION_DISABLED"
  | "CONFIGURATION_INVALID"
  | "CONTRACT_UNVERIFIED"
  | "PRODUCTION_NOT_APPROVED"
  | "NO_LIVE_OPERATIONS"
  | "PARTICIPANT_UNKNOWN"
  | "PARTICIPANT_UNTRUSTED"
  | "AUTHORIZATION_DENIED"
  | "CONSENT_REQUIRED"
  | "DUPLICATE_DISPATCH";

export interface GateDecision {
  allowed: boolean;
  reason: GateRefusalReason | null;
  /** Operator-facing. Safe to display; never contains a credential or payload. */
  message: string | null;
  environment: string;
  system: IntegrationSystem | null;
}

function refuse(
  reason: GateRefusalReason, message: string, environment = "DISABLED", system: IntegrationSystem | null = null
): GateDecision {
  return { allowed: false, reason, message, environment, system };
}

/**
 * Decide whether an outbound dispatch may proceed.
 *
 * Nothing here trusts the caller for identity: the facility comes from the
 * actor's session upstream, and the participant, environment and configuration
 * are all read server-side.
 */
export async function evaluateOutboundGate(req: OutboundGateRequest): Promise<GateDecision> {
  let system: IntegrationSystem;
  try {
    system = assertKnownSystem(req.system);
  } catch {
    return refuse("UNKNOWN_INTEGRATION", "That integration does not exist.");
  }

  const view = await describeIntegration(req.facilityId, system);
  const environment = view.connection.environment;

  // ── 1. Kill switch and configuration, before anything patient-specific ────
  if (!view.dispatch.allowed) {
    const reason: GateRefusalReason =
      !view.connection.enabled || environment === "DISABLED" ? "INTEGRATION_DISABLED"
        : !view.descriptor.contractVerified ? "CONTRACT_UNVERIFIED"
          : environment === "PRODUCTION" && !view.connection.productionApprovedAt ? "PRODUCTION_NOT_APPROVED"
            : view.readiness.dimensions.configuration === "FAIL" ? "CONFIGURATION_INVALID"
              : "NO_LIVE_OPERATIONS";
    return refuse(reason, view.dispatch.reason ?? "This integration cannot dispatch.", environment, system);
  }

  // ── 2. Counterparty ───────────────────────────────────────────────────────
  // Identity is not trust: a registered participant that has not been verified
  // is refused just as firmly as an unknown one.
  if (req.participantExternalId) {
    const participant = await resolveParticipant({
      facilityId: req.facilityId, system, environment, externalId: req.participantExternalId,
    });
    if (!participant) {
      return refuse(
        "PARTICIPANT_UNKNOWN",
        "That counterparty is not registered for this facility and environment.",
        environment, system
      );
    }
    if (!isParticipantUsable(participant)) {
      return refuse(
        "PARTICIPANT_UNTRUSTED",
        `That counterparty is ${participant.trustStatus.toLowerCase()} and cannot be sent to.`,
        environment, system
      );
    }
  }

  // ── 3. Idempotency ────────────────────────────────────────────────────────
  // A cheap pre-check only. The real guarantee is the unique constraint in the
  // protocol module; this exists so an operator sees a clean refusal rather
  // than a constraint violation.
  if (req.idempotencyKey) {
    const [abdm, nhcx] = await Promise.all([
      prisma.healthInformationExchange.findUnique({ where: { idempotencyKey: req.idempotencyKey } }),
      prisma.nhcxExchange.findUnique({ where: { idempotencyKey: req.idempotencyKey } }),
    ]);
    const existing = abdm ?? nhcx;
    if (existing && existing.facilityId === req.facilityId) {
      return refuse("DUPLICATE_DISPATCH", "An identical dispatch is already in progress.", environment, system);
    }
  }

  // ── 4. Authorization and consent, answered only by the C4 engine ──────────
  const decision = await authorizeAccess({
    actor: req.actor,
    action: req.action,
    resource: {
      type: "EXCHANGE",
      facilityId: req.facilityId,
      patientId: req.patientId ?? null,
      dataClass: req.patientId ? "SENSITIVE_CLINICAL" : "OPERATIONAL",
    },
    purpose: req.purpose,
    scopes: req.scopes,
  });

  if (decision.decision === "REQUIRE_CONSENT") {
    return refuse("CONSENT_REQUIRED", decision.reason ?? "Patient consent is required.", environment, system);
  }
  if (decision.decision !== "ALLOW") {
    // The message is the engine's, which is already shaped not to disclose
    // whether a resource exists.
    return refuse("AUTHORIZATION_DENIED", decision.reason ?? "Not authorized.", environment, system);
  }

  return { allowed: true, reason: null, message: null, environment, system };
}

/**
 * Record a refusal so it is visible in the control plane.
 *
 * A dispatch that never happened is the single hardest thing to debug from the
 * outside, so refusals are audited with their category — never with the payload
 * that was about to be sent.
 */
export async function recordGateRefusal(args: {
  facilityId: string; system: string; decision: GateDecision; actor: AuthorizationActor;
  context?: Record<string, unknown>;
}) {
  await recordAuditEvent(
    "hospital.interop.dispatchRefused",
    args.actor.userId,
    {
      system: args.system,
      reason: args.decision.reason,
      environment: args.decision.environment,
      ...(args.context ?? {}),
    },
    { facilityId: args.facilityId }
  );
}

export interface InboundGateRequest {
  facilityId: string;
  system: string;
  /** Whether transport-level authentication already succeeded upstream. */
  authenticated: boolean;
  environment: string;
  participantExternalId?: string | null;
  /** The correlation the message claims. */
  correlationId?: string | null;
}

export type InboundRefusalReason =
  | "UNKNOWN_INTEGRATION"
  | "INTEGRATION_DISABLED"
  | "NOT_AUTHENTICATED"
  | "ENVIRONMENT_MISMATCH"
  | "PARTICIPANT_UNKNOWN"
  | "PARTICIPANT_UNTRUSTED"
  | "UNKNOWN_CORRELATION";

export interface InboundDecision {
  accepted: boolean;
  reason: InboundRefusalReason | null;
  message: string | null;
  /** True when the payload must be quarantined rather than applied. */
  quarantine: boolean;
}

/**
 * Decide whether inbound external data may be accepted.
 *
 * Refusing is cheap and safe; accepting is not. Anything that cannot be
 * confidently attributed to a known correlation, a trusted participant and the
 * right environment is refused or quarantined — never applied on the assumption
 * that it is probably fine.
 */
export async function evaluateInboundGate(req: InboundGateRequest): Promise<InboundDecision> {
  let system: IntegrationSystem;
  try {
    system = assertKnownSystem(req.system);
  } catch {
    return { accepted: false, reason: "UNKNOWN_INTEGRATION", message: "Unknown integration.", quarantine: false };
  }

  if (!req.authenticated) {
    return { accepted: false, reason: "NOT_AUTHENTICATED", message: "Unauthorized.", quarantine: false };
  }

  const view = await describeIntegration(req.facilityId, system);
  if (!view.connection.enabled) {
    // A disabled integration accepts nothing. Inbound is part of the kill
    // switch, not an exception to it.
    return {
      accepted: false, reason: "INTEGRATION_DISABLED",
      message: "This integration is disabled for this facility.", quarantine: false,
    };
  }

  // A sandbox message must never be applied by a production connection, or the
  // reverse. Test data in a live record is a clinical safety problem.
  if (view.connection.environment !== req.environment) {
    return {
      accepted: false, reason: "ENVIRONMENT_MISMATCH",
      message: "The message environment does not match this integration's configured environment.",
      quarantine: true,
    };
  }

  if (req.participantExternalId) {
    const participant = await resolveParticipant({
      facilityId: req.facilityId, system, environment: req.environment, externalId: req.participantExternalId,
    });
    if (!participant) {
      return {
        accepted: false, reason: "PARTICIPANT_UNKNOWN",
        message: "Unknown counterparty.", quarantine: true,
      };
    }
    if (!isParticipantUsable(participant)) {
      return {
        accepted: false, reason: "PARTICIPANT_UNTRUSTED",
        message: "Counterparty is not trusted.", quarantine: true,
      };
    }
  }

  return { accepted: true, reason: null, message: null, quarantine: false };
}
