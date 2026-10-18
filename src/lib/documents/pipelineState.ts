import type { DocumentProcessingStatus, DocumentStepError, DocumentStepKind, DocumentStepStatus, Prisma } from "@prisma/client";
import { ConflictError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

/**
 * Week 4a — the pipeline's state machine (docs/DOCUMENT_PIPELINE_DESIGN.md §4.3).
 *
 * A run: QUEUED → RUNNING → AWAITING_REVIEW → COMPLETED, or SKIPPED (the
 * real-data switch or consent said no), FAILED (a permanent error) or
 * CANCELLED (the document was withdrawn). Terminal states never change.
 *
 * A step (PAGE_SPLIT, OCR, TRANSLATE, EXTRACT, MERGE): PENDING → RUNNING →
 * DONE | SKIPPED | FAILED. A RUNNING step may go back to RUNNING (a retry of
 * a transient error, or a stale claim) — never out of DONE, SKIPPED or FAILED.
 * Every change is compare-and-set on the row's current status and version,
 * so redelivered or concurrent consumers can't both act.
 */

export const STEPS: readonly DocumentStepKind[] = ["PAGE_SPLIT", "OCR", "TRANSLATE", "EXTRACT", "MERGE"];

export const RUN_TRANSITIONS: Record<DocumentProcessingStatus, readonly DocumentProcessingStatus[]> = {
  QUEUED: ["RUNNING", "SKIPPED", "CANCELLED"],
  RUNNING: ["AWAITING_REVIEW", "COMPLETED", "FAILED", "CANCELLED"],
  AWAITING_REVIEW: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  SKIPPED: [],
};

export const STEP_TRANSITIONS: Record<DocumentStepStatus, readonly DocumentStepStatus[]> = {
  PENDING: ["RUNNING", "SKIPPED"],
  RUNNING: ["RUNNING", "DONE", "SKIPPED", "FAILED"],
  DONE: [],
  SKIPPED: [],
  FAILED: [],
};

/** Errors that end a step (and its run) rather than being retried. */
export const PERMANENT_ERRORS: readonly DocumentStepError[] = ["UNREADABLE", "UNSUPPORTED_LANGUAGE", "EXACT_COPY_VIOLATION", "TOO_LARGE"];
export const TERMINAL_RUN: readonly DocumentProcessingStatus[] = ["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"];
export const STALE_CLAIM_MS = 10 * 60_000;
export const MAX_STEP_ATTEMPTS = 5;

export function canRun(from: DocumentProcessingStatus, to: DocumentProcessingStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}
export function canStep(from: DocumentStepStatus, to: DocumentStepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

/** Creates a run with its five steps (QUEUED, all PENDING). */
export async function createRun(tx: Tx, input: { personId: string; documentId: string; targetLanguage: string }) {
  const last = await tx.documentProcessing.findFirst({ where: { documentId: input.documentId }, orderBy: { run: "desc" }, select: { run: true } });
  return tx.documentProcessing.create({
    data: {
      personId: input.personId, documentId: input.documentId, targetLanguage: input.targetLanguage, run: (last?.run ?? 0) + 1,
      steps: { create: STEPS.map((step) => ({ step, personId: input.personId })) },
    },
  });
}

/** Moves a run, compare-and-set on its current status. */
export async function moveRun(tx: Tx, processingId: string, to: DocumentProcessingStatus, data: Prisma.DocumentProcessingUpdateManyMutationInput = {}) {
  const run = await tx.documentProcessing.findUniqueOrThrow({ where: { id: processingId }, select: { status: true, version: true } });
  if (run.status === to) return false;
  if (!canRun(run.status, to)) throw new ConflictError(`A ${run.status} run can't become ${to}.`);
  const r = await tx.documentProcessing.updateMany({
    where: { id: processingId, status: run.status, version: run.version },
    data: { ...data, status: to, version: { increment: 1 }, ...(TERMINAL_RUN.includes(to) ? { completedAt: new Date() } : {}) },
  });
  if (r.count !== 1) throw new ConflictError("This run changed concurrently.");
  return true;
}

/**
 * Claims a step for work: PENDING → RUNNING, or a RUNNING step whose claim
 * is stale (or that is being retried). Returns null when there is nothing to
 * do (already DONE/SKIPPED/FAILED, or someone else holds a fresh claim).
 */
export async function claimStep(tx: Tx, processingId: string, step: DocumentStepKind, now = new Date()) {
  const s = await tx.documentProcessingStep.findUniqueOrThrow({ where: { processingId_step: { processingId, step } } });
  const stale = s.status === "RUNNING" && (!s.startedAt || now.getTime() - s.startedAt.getTime() > STALE_CLAIM_MS);
  const retrying = s.status === "RUNNING" && s.lastErrorCode !== null && !PERMANENT_ERRORS.includes(s.lastErrorCode);
  if (!(s.status === "PENDING" || stale || retrying)) return null;
  if (s.attempts >= MAX_STEP_ATTEMPTS) return null;
  const r = await tx.documentProcessingStep.updateMany({
    where: { id: s.id, status: s.status, version: s.version },
    data: { status: "RUNNING", attempts: { increment: 1 }, startedAt: now, version: { increment: 1 } },
  });
  return r.count === 1 ? { ...s, status: "RUNNING" as const, attempts: s.attempts + 1 } : null;
}

/** Ends a claimed step: DONE, SKIPPED or FAILED (a transient error keeps it RUNNING for a retry). */
export async function finishStep(tx: Tx, processingId: string, step: DocumentStepKind, outcome: { status: "DONE" | "SKIPPED" } | { status: "FAILED"; error: DocumentStepError }, meta: { provider?: string; model?: string } = {}) {
  const s = await tx.documentProcessingStep.findUniqueOrThrow({ where: { processingId_step: { processingId, step } } });
  const transient = outcome.status === "FAILED" && !PERMANENT_ERRORS.includes(outcome.error) && s.attempts < MAX_STEP_ATTEMPTS;
  const to: DocumentStepStatus = transient ? "RUNNING" : outcome.status;
  if (!canStep(s.status, to)) throw new ConflictError(`A ${s.status} step can't become ${to}.`);
  const r = await tx.documentProcessingStep.updateMany({
    where: { id: s.id, status: s.status, version: s.version },
    data: {
      status: to, version: { increment: 1 }, provider: meta.provider, model: meta.model,
      lastErrorCode: outcome.status === "FAILED" ? outcome.error : null,
      ...(to !== "RUNNING" ? { finishedAt: new Date() } : {}),
    },
  });
  if (r.count !== 1) throw new ConflictError("This step changed concurrently.");
  return { status: to, transient };
}
