import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { authorizeAccess } from "@/lib/auth/authorize/engine";
import type { AuthorizationActor } from "@/lib/auth/authorize/types";
import { QUERY_TRANSITIONS, isTransitionAllowed, type QueryStatus } from "./stateMachines";

/**
 * Phase C5 — claim query / clarification lifecycle.
 *
 * A payer asks a question against a submitted claim; the provider answers,
 * optionally attaching documents. Deliberately a STRUCTURED workflow with a
 * state machine, not a chat thread: every response is versioned, audited and
 * individually authorized, which a free-form message log would not be.
 *
 * Documents attached to a response go through the same C4 authorization as any
 * other disclosure. Answering a payer question is not a licence to attach
 * whatever is on the chart.
 */

export class QueryConcurrencyError extends ConflictError {
  constructor(message = "This query changed concurrently. Refresh and try again.") {
    super(message);
  }
}

const MAX_QUESTION_LENGTH = 4000;
const MAX_RESPONSE_LENGTH = 8000;

/**
 * Record an inbound payer query.
 *
 * `questionText` is UNTRUSTED external content: it is length-capped and stored
 * as data, never interpreted.
 */
export async function recordQuery(input: {
  facilityId: string;
  submissionId: string;
  questionText: string;
  externalQueryId?: string | null;
  reasonCode?: string | null;
  dueAt?: Date | null;
  byUserId?: string | null;
}) {
  const submission = await prisma.claimSubmission.findUnique({ where: { id: input.submissionId } });
  if (!submission || submission.facilityId !== input.facilityId) throw new NotFoundError("Submission not found.");

  const text = (input.questionText ?? "").trim();
  if (!text) throw new BadRequestError("A query must carry a question.");

  const query = await prisma.claimQuery.create({
    data: {
      facilityId: input.facilityId,
      submissionId: submission.id,
      claimId: submission.claimId,
      externalQueryId: input.externalQueryId?.slice(0, 128) ?? null,
      questionText: text.slice(0, MAX_QUESTION_LENGTH),
      reasonCode: input.reasonCode?.slice(0, 64) ?? null,
      dueAt: input.dueAt ?? null,
      status: "RECEIVED",
    },
  });

  await recordAuditEvent(
    "hospital.claim.queryReceived",
    input.byUserId ?? null,
    { queryId: query.id, claimId: submission.claimId, submissionId: submission.id, reasonCode: query.reasonCode },
    { facilityId: input.facilityId, patientId: submission.patientId }
  );
  return query;
}

/** Guarded query transition. */
export async function transitionQuery(input: {
  facilityId: string; queryId: string; to: QueryStatus; byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const q = await tx.claimQuery.findUnique({ where: { id: input.queryId } });
    if (!q || q.facilityId !== input.facilityId) throw new NotFoundError("Query not found.");
    if (!isTransitionAllowed(QUERY_TRANSITIONS, q.status, input.to)) {
      throw new BadRequestError(`Illegal query transition ${q.status} -> ${input.to}.`);
    }
    const r = await tx.claimQuery.updateMany({
      where: { id: q.id, status: q.status, version: q.version },
      data: {
        status: input.to,
        version: { increment: 1 },
        ...(input.to === "RESOLVED" ? { resolvedAt: new Date() } : {}),
      },
    });
    if (r.count !== 1) throw new QueryConcurrencyError();
    return tx.claimQuery.findUniqueOrThrow({ where: { id: q.id } });
  });
}

/**
 * Submit a response to a payer query.
 *
 * Each attached document is authorized INDIVIDUALLY against the C4 engine with
 * purpose INSURANCE. A document that fails is dropped from the response and
 * reported back, never silently included.
 */
export async function respondToQuery(input: {
  facilityId: string;
  queryId: string;
  responseText: string;
  documentIds?: string[];
  actor: AuthorizationActor;
}) {
  const query = await prisma.claimQuery.findUnique({ where: { id: input.queryId } });
  if (!query || query.facilityId !== input.facilityId) throw new NotFoundError("Query not found.");

  const text = (input.responseText ?? "").trim();
  if (!text) throw new BadRequestError("A response is required.");
  if (!["RECEIVED", "UNDER_REVIEW", "RESPONSE_DRAFT"].includes(query.status)) {
    throw new BadRequestError(`A query in ${query.status} cannot be answered.`);
  }

  const submission = await prisma.claimSubmission.findUniqueOrThrow({ where: { id: query.submissionId } });

  const accepted: string[] = [];
  const rejected: { id: string; reason: string }[] = [];

  for (const documentId of [...new Set(input.documentIds ?? [])]) {
    const doc = await prisma.clinicalDocument.findUnique({ where: { id: documentId } });
    // Cross-facility or wrong-patient documents are refused outright.
    if (!doc || doc.facilityId !== input.facilityId) {
      rejected.push({ id: documentId, reason: "Not found." });
      continue;
    }
    if (doc.patientId !== submission.patientId) {
      rejected.push({ id: documentId, reason: "Document belongs to a different patient." });
      continue;
    }
    const decision = await authorizeAccess({
      actor: input.actor,
      action: doc.accessPolicy === "RESTRICTED" ? "document.read.restricted" : "document.read",
      resource: {
        type: "DOCUMENT", id: doc.id, facilityId: input.facilityId,
        patientId: doc.patientId,
        dataClass: doc.accessPolicy === "RESTRICTED" ? "HIGHLY_SENSITIVE" : "SENSITIVE_CLINICAL",
      },
      purpose: "INSURANCE",
    }, { skipAudit: true });
    if (decision.decision !== "ALLOW") {
      rejected.push({ id: documentId, reason: "Not authorized for disclosure." });
      continue;
    }
    accepted.push(documentId);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.claimQuery.findUniqueOrThrow({ where: { id: query.id } });
    const r = await tx.claimQuery.updateMany({
      where: { id: current.id, status: current.status, version: current.version },
      data: {
        status: "RESPONSE_SUBMITTED",
        responseText: text.slice(0, MAX_RESPONSE_LENGTH),
        responseDocumentIds: accepted.length ? accepted.join(",") : null,
        respondedByUserId: input.actor.userId,
        respondedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new QueryConcurrencyError();
    return tx.claimQuery.findUniqueOrThrow({ where: { id: current.id } });
  });

  await recordAuditEvent(
    "hospital.claim.queryResponded",
    input.actor.userId,
    {
      queryId: query.id, claimId: query.claimId,
      documentsAttached: accepted.length, documentsRefused: rejected.length,
    },
    { facilityId: input.facilityId, patientId: submission.patientId }
  );

  return { query: updated, attachedDocuments: accepted, refusedDocuments: rejected };
}

export async function listQueries(args: { facilityId: string; status?: string; claimId?: string }) {
  return prisma.claimQuery.findMany({
    where: {
      facilityId: args.facilityId,
      ...(args.status ? { status: args.status } : {}),
      ...(args.claimId ? { claimId: args.claimId } : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: 200,
  });
}
