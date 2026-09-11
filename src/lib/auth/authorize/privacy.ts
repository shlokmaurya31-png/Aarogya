import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "../rbac";
import { recordAuditEvent } from "../audit";

/**
 * Phase C4 — privacy request workflow.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES AND POINTEDLY DOES NOT DO
 *
 * It records a patient-initiated request and carries it through an explicit
 * review to a recorded decision.
 *
 * It NEVER deletes a clinical record. `DELETION_REQUEST` is a request, not an
 * instruction. Clinical notes, diagnoses, results, medication administration,
 * operative notes, transfusion records and audit events carry retention and
 * safety obligations that a generic workflow has no business overriding, and a
 * system that silently honoured a deletion request would be dangerous.
 *
 * So the terminal state is a DECISION plus, where applicable, a separate
 * deliberate action. `legalHold` blocks actioning outright.
 *
 * This implements technical controls that SUPPORT privacy and data-protection
 * obligations. It is not, and does not claim to be, legal compliance.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const PRIVACY_REQUEST_TYPES = [
  "ACCESS",
  "CORRECTION",
  "RESTRICTION",
  "WITHDRAW_CONSENT",
  "DELETION_REQUEST",
] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

export const REQUESTER_TYPES = ["PATIENT", "STAFF_ON_BEHALF", "GUARDIAN"] as const;

/** REQUESTED -> UNDER_REVIEW -> APPROVED|REJECTED -> ACTIONED, or CANCELLED. */
export const PRIVACY_TRANSITIONS: Record<string, string[]> = {
  REQUESTED: ["UNDER_REVIEW", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "CANCELLED"],
  // Only an approved request can be actioned. A rejection is terminal.
  APPROVED: ["ACTIONED", "CANCELLED"],
  REJECTED: [],
  ACTIONED: [],
  CANCELLED: [],
};

export function isPrivacyTransitionAllowed(from: string, to: string): boolean {
  return PRIVACY_TRANSITIONS[from]?.includes(to) ?? false;
}

export const MIN_REASON_LENGTH = 10;

export async function createPrivacyRequest(input: {
  facilityId: string;
  patientId: string;
  requestType: string;
  requesterType: string;
  /** Server-derived. A client cannot nominate who raised the request. */
  requesterUserId: string;
  scope?: string;
  reason?: string;
}) {
  if (!(PRIVACY_REQUEST_TYPES as readonly string[]).includes(input.requestType)) {
    throw new BadRequestError(`requestType must be one of ${PRIVACY_REQUEST_TYPES.join(", ")}.`);
  }
  if (!(REQUESTER_TYPES as readonly string[]).includes(input.requesterType)) {
    throw new BadRequestError(`requesterType must be one of ${REQUESTER_TYPES.join(", ")}.`);
  }

  const patient = await prisma.patient.findUnique({
    where: { id: input.patientId },
    select: { id: true, facilityId: true, userId: true },
  });
  // Not-found shaped: a privacy request must not become a way to discover that
  // a patient exists in another facility.
  if (!patient || patient.facilityId !== input.facilityId) throw new NotFoundError("Patient not found.");

  // A patient raising a request for THEMSELVES must actually be that patient.
  // Without this check, any patient account could raise requests against any
  // other patient — the exact IDOR this workflow would otherwise introduce.
  if (input.requesterType === "PATIENT" && patient.userId !== input.requesterUserId) {
    throw new NotFoundError("Patient not found.");
  }

  const request = await prisma.privacyRequest.create({
    data: {
      facilityId: input.facilityId,
      patientId: input.patientId,
      requestType: input.requestType,
      requesterType: input.requesterType,
      requesterUserId: input.requesterUserId,
      scope: input.scope,
      reason: input.reason,
      status: "REQUESTED",
    },
  });

  await recordAuditEvent(
    "security.privacy.requestCreated",
    input.requesterUserId,
    { privacyRequestId: request.id, requestType: request.requestType, requesterType: request.requesterType },
    { facilityId: input.facilityId, patientId: input.patientId }
  );
  return request;
}

/** Move a request through review. Guarded so two reviewers cannot both decide. */
export async function transitionPrivacyRequest(input: {
  facilityId: string;
  privacyRequestId: string;
  to: string;
  byUserId: string;
  decisionNote?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.privacyRequest.findUnique({ where: { id: input.privacyRequestId } });
    if (!request || request.facilityId !== input.facilityId) throw new NotFoundError("Privacy request not found.");

    if (!isPrivacyTransitionAllowed(request.status, input.to)) {
      throw new BadRequestError(`Illegal privacy request transition ${request.status} -> ${input.to}.`);
    }
    if (["APPROVED", "REJECTED"].includes(input.to) && !input.decisionNote?.trim()) {
      // A decision without a recorded rationale is not a decision anyone can
      // stand behind later.
      throw new BadRequestError("A decision note is required when approving or rejecting.");
    }

    // A record under legal hold cannot be actioned, whatever the decision was.
    if (input.to === "ACTIONED" && request.legalHold) {
      throw new BadRequestError(
        "This record is under legal hold and cannot be actioned. Clear the hold first."
      );
    }

    const r = await tx.privacyRequest.updateMany({
      where: { id: request.id, status: request.status, version: request.version },
      data: {
        status: input.to,
        version: { increment: 1 },
        ...(["APPROVED", "REJECTED"].includes(input.to)
          ? { reviewedByUserId: input.byUserId, reviewedAt: new Date(), decisionNote: input.decisionNote }
          : {}),
        ...(input.to === "UNDER_REVIEW" ? { reviewedByUserId: input.byUserId } : {}),
        ...(input.to === "ACTIONED" ? { actionedAt: new Date(), actionedByUserId: input.byUserId } : {}),
      },
    });
    if (r.count !== 1) throw new ConflictError("That privacy request changed concurrently.");

    await tx.auditEvent.create({
      data: {
        type: input.to === "ACTIONED" ? "security.privacy.requestActioned" : "security.privacy.requestReviewed",
        userId: input.byUserId,
        detail: {
          privacyRequestId: request.id,
          from: request.status,
          to: input.to,
          requestType: request.requestType,
          decisionNote: input.decisionNote ?? null,
        },
        facilityId: request.facilityId,
        patientId: request.patientId,
      },
    });
    return tx.privacyRequest.findUniqueOrThrow({ where: { id: request.id } });
  });
}

/** Place or lift a legal hold. Blocks actioning while set. */
export async function setLegalHold(input: {
  facilityId: string; privacyRequestId: string; hold: boolean; reason?: string; byUserId: string;
}) {
  const request = await prisma.privacyRequest.findUnique({ where: { id: input.privacyRequestId } });
  if (!request || request.facilityId !== input.facilityId) throw new NotFoundError("Privacy request not found.");
  if (input.hold && !input.reason?.trim()) {
    throw new BadRequestError("A reason is required when placing a legal hold.");
  }

  const updated = await prisma.privacyRequest.update({
    where: { id: request.id },
    data: {
      legalHold: input.hold,
      legalHoldReason: input.hold ? input.reason : null,
      version: { increment: 1 },
    },
  });
  await recordAuditEvent(
    "security.privacy.requestReviewed",
    input.byUserId,
    { privacyRequestId: request.id, legalHold: input.hold, reason: input.reason ?? null },
    { facilityId: request.facilityId, patientId: request.patientId }
  );
  return updated;
}

/**
 * List privacy requests.
 *
 * `restrictToPatientId` is how a patient account is confined to its own
 * requests — the caller passes the patient resolved from the session, never a
 * value from the query string.
 */
export async function listPrivacyRequests(args: {
  facilityId: string;
  status?: string;
  patientId?: string;
  restrictToPatientId?: string | null;
}) {
  return prisma.privacyRequest.findMany({
    where: {
      facilityId: args.facilityId,
      ...(args.status ? { status: args.status } : {}),
      ...(args.restrictToPatientId
        ? { patientId: args.restrictToPatientId }
        : args.patientId
          ? { patientId: args.patientId }
          : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

/**
 * Retention metadata for a data class.
 *
 * Descriptive ONLY. Nothing in Aarogya acts on these values: there is no
 * cleanup job, and clinical records are never purged automatically. Exposing
 * the policy without wiring it to a deleter is the deliberate choice — the
 * alternative is a background task capable of destroying medical records.
 */
export const RETENTION_POLICIES: Record<string, { years: number | null; note: string }> = {
  STANDARD_CLINICAL: { years: null, note: "Retained indefinitely; no automated deletion." },
  SENSITIVE_CLINICAL: { years: null, note: "Retained indefinitely; no automated deletion." },
  HIGHLY_SENSITIVE: { years: null, note: "Retained indefinitely; no automated deletion." },
  FINANCIAL: { years: null, note: "Retained per financial record obligations; no automated deletion." },
  IDENTITY: { years: null, note: "Retained while the record is active; no automated deletion." },
  SECURITY: { years: null, note: "Audit events are append-only and are never deleted by this system." },
};

export function describeRetention() {
  return {
    automatedDeletion: false,
    note:
      "Aarogya performs no automated deletion of clinical, financial or audit records. " +
      "Retention values are descriptive metadata; any deletion is a deliberate, " +
      "reviewed action outside this workflow.",
    policies: RETENTION_POLICIES,
  };
}
