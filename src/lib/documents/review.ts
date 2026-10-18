import type { ExtractedFact, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { emitDomainEvent } from "@/lib/events/emit";
import { requireOwnedPerson } from "@/lib/person/access";
import { factFields, parseFactValue } from "./factSchemas";

type Tx = Prisma.TransactionClient;

/**
 * Week 4a — the patient's review of extracted facts (docs/DOCUMENT_PIPELINE_DESIGN.md
 * §7, §9). Review is the only gate into the record: nothing extracted enters
 * it without the person's confirm or correct.
 *
 *   - Owner only in Week 4a: the Person's OWNER login (requireOwnedPerson);
 *     households (5b) add proxies behind personAccess(). Another Person's
 *     fact is a 404.
 *   - A fact is decided once: compare-and-set on its version, PENDING only.
 *   - No auto-confirm. Bulk confirm only for HIGH, printed facts whose
 *     exact-copy check passed; LOW ones are decided one by one.
 *   - Handwritten facts are confirmed field by field (no fact-level or bulk
 *     confirm); the last field confirmed makes the fact CONFIRMED.
 *   - A fact whose exact-copy check FAILED can't be confirmed as extracted:
 *     the person corrects it (typing what the page says) or rejects it.
 *   - A correction is validated by the type's schema and stored exactly as
 *     typed, after the person has seen it back (typedValueConfirmed).
 *   - Each decision emits ExtractedFactReviewed in its transaction; doc-merge
 *     turns confirmed and corrected facts into record entries.
 */

export type FactDecision = "CONFIRMED" | "CORRECTED" | "REJECTED";

function view(f: ExtractedFact) {
  const value = f.value as Record<string, unknown>;
  return {
    id: f.id, processingId: f.processingId, factType: f.factType, value, confidence: f.confidence, confidenceBand: f.confidenceBand,
    handwritten: f.handwritten, pageNo: f.pageNo, region: f.region, sourceText: f.sourceText, exactCopyCheck: f.exactCopyCheck,
    reviewStatus: f.reviewStatus, reviewedValue: f.reviewedValue, version: f.version,
    fields: factFields(value), confirmedFields: f.confirmedFields,
    confirmable: !f.handwritten && f.exactCopyCheck === "PASSED",
    bulkConfirmable: !f.handwritten && f.exactCopyCheck === "PASSED" && f.confidenceBand === "HIGH",
  };
}
export type FactView = ReturnType<typeof view>;

const BAND_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

/** The person's facts awaiting review (or of another status), LOW first. */
export async function listOwnFacts(userId: string, opts: { status?: "PENDING" | "CONFIRMED" | "CORRECTED" | "REJECTED"; processingId?: string } = {}) {
  const personId = await requireOwnedPerson(userId);
  const facts = await prisma.extractedFact.findMany({
    where: { personId, reviewStatus: opts.status ?? "PENDING", ...(opts.processingId ? { processingId: opts.processingId } : {}), processing: { status: { notIn: ["CANCELLED"] } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return facts.map(view).sort((a, b) => BAND_ORDER[a.confidenceBand] - BAND_ORDER[b.confidenceBand]);
}

async function ownFact(tx: Tx, personId: string, factId: string) {
  const f = await tx.extractedFact.findUnique({ where: { id: factId }, include: { processing: { select: { status: true, documentId: true } } } });
  if (!f || f.personId !== personId) throw new NotFoundError();
  return f;
}

function assertVersion(v: unknown): number {
  if (!Number.isInteger(v)) throw new BadRequestError("version is required (the fact's version as shown).");
  return v as number;
}

/** One decision, compare-and-set, with its event. Returns the fact as now. */
async function decide(tx: Tx, f: ExtractedFact, userId: string, version: number, decision: FactDecision, data: Prisma.ExtractedFactUpdateManyMutationInput = {}) {
  if (f.reviewStatus !== "PENDING") throw new ConflictError("This fact has already been decided.");
  const r = await tx.extractedFact.updateMany({
    where: { id: f.id, version, reviewStatus: "PENDING" },
    data: { ...data, reviewStatus: decision, reviewedByUserId: userId, reviewedAt: new Date(), reviewedVia: "SELF", version: { increment: 1 } },
  });
  if (r.count !== 1) throw new ConflictError("This fact changed. Refresh and try again.");
  await emitDomainEvent(tx, {
    type: "ExtractedFactReviewed", aggregateId: f.processingId, personId: f.personId, actorUserId: userId,
    payload: { factId: f.id, processingId: f.processingId, personId: f.personId, factType: f.factType, decision, via: "SELF" },
  });
}

async function reviewable(tx: Tx, personId: string, factId: string) {
  const f = await ownFact(tx, personId, factId);
  if (f.processing.status !== "AWAITING_REVIEW") throw new ConflictError("This document isn't awaiting review.");
  return f;
}

async function audited<T>(userId: string, factId: string, decision: string, fn: (personId: string) => Promise<T>) {
  const personId = await requireOwnedPerson(userId);
  const out = await fn(personId);
  await recordAuditEvent("person.fact.reviewed", userId, { personId, factId, decision });
  return out;
}

export async function confirmFact(userId: string, factId: string, input: { version: unknown }) {
  const version = assertVersion(input.version);
  return audited(userId, factId, "CONFIRMED", async (personId) => {
    await prisma.$transaction(async (tx) => {
      const f = await reviewable(tx, personId, factId);
      if (f.handwritten) throw new BadRequestError("A handwritten fact is confirmed one field at a time.");
      if (f.exactCopyCheck === "FAILED") throw new BadRequestError("This fact doesn't match the page exactly. Correct it to what the page says, or reject it.");
      await decide(tx, f, userId, version, "CONFIRMED");
    });
    return view(await prisma.extractedFact.findUniqueOrThrow({ where: { id: factId } }));
  });
}

/** Handwritten facts: confirm one field; the last one makes the fact CONFIRMED. */
export async function confirmFactField(userId: string, factId: string, field: string, input: { version: unknown }) {
  const version = assertVersion(input.version);
  return audited(userId, factId, `FIELD:${field}`, async (personId) => {
    await prisma.$transaction(async (tx) => {
      const f = await reviewable(tx, personId, factId);
      if (!f.handwritten) throw new BadRequestError("Only handwritten facts are confirmed field by field.");
      if (f.exactCopyCheck === "FAILED") throw new BadRequestError("This fact doesn't match the page exactly. Correct it to what the page says, or reject it.");
      if (f.reviewStatus !== "PENDING") throw new ConflictError("This fact has already been decided.");
      const fields = factFields(f.value as Record<string, unknown>);
      if (!fields.includes(field)) throw new BadRequestError(`This fact has no field "${field}".`);
      const confirmed = [...new Set([...f.confirmedFields, field])].sort();
      if (fields.every((x) => confirmed.includes(x))) {
        await decide(tx, f, userId, version, "CONFIRMED", { confirmedFields: confirmed });
      } else {
        const r = await tx.extractedFact.updateMany({ where: { id: f.id, version, reviewStatus: "PENDING" }, data: { confirmedFields: confirmed, version: { increment: 1 } } });
        if (r.count !== 1) throw new ConflictError("This fact changed. Refresh and try again.");
      }
    });
    return view(await prisma.extractedFact.findUniqueOrThrow({ where: { id: factId } }));
  });
}

export async function correctFact(userId: string, factId: string, input: { version: unknown; value: unknown; typedValueConfirmed?: unknown }) {
  const version = assertVersion(input.version);
  return audited(userId, factId, "CORRECTED", async (personId) => {
    const f0 = await ownFact(prisma, personId, factId);
    const parsed = parseFactValue(f0.factType, input.value);
    if (!parsed.success) throw new BadRequestError(`That isn't a valid ${f0.factType.toLowerCase().replace("_", " ")}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "value"} ${i.message}`).join("; ")}.`);
    // Shown back first: a correction is accepted only once the person has seen it exactly as stored.
    if (input.typedValueConfirmed !== true) return { needsConfirmation: true as const, value: parsed.data };
    await prisma.$transaction(async (tx) => {
      const f = await reviewable(tx, personId, factId);
      await decide(tx, f, userId, version, "CORRECTED", { reviewedValue: parsed.data as Prisma.InputJsonValue });
    });
    return view(await prisma.extractedFact.findUniqueOrThrow({ where: { id: factId } }));
  });
}

export async function rejectFact(userId: string, factId: string, input: { version: unknown }) {
  const version = assertVersion(input.version);
  return audited(userId, factId, "REJECTED", async (personId) => {
    await prisma.$transaction(async (tx) => {
      const f = await reviewable(tx, personId, factId);
      await decide(tx, f, userId, version, "REJECTED");
    });
    return view(await prisma.extractedFact.findUniqueOrThrow({ where: { id: factId } }));
  });
}

/**
 * Several decisions at once, all or nothing. Confirm only for HIGH, printed
 * facts with a passed exact-copy check; reject for any. A refused item
 * refuses the whole request (nothing is half-applied).
 */
export async function bulkReview(userId: string, input: { decisions: unknown }) {
  const items = input.decisions;
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw new BadRequestError("decisions must be a list of 1–100 items.");
  const parsed = items.map((x) => {
    const d = x as { factId?: unknown; version?: unknown; decision?: unknown };
    if (typeof d?.factId !== "string" || (d.decision !== "CONFIRM" && d.decision !== "REJECT")) throw new BadRequestError("Each decision needs factId, version and decision CONFIRM or REJECT.");
    return { factId: d.factId, version: assertVersion(d.version), decision: d.decision as "CONFIRM" | "REJECT" };
  });
  if (new Set(parsed.map((p) => p.factId)).size !== parsed.length) throw new BadRequestError("A fact appears twice.");
  const personId = await requireOwnedPerson(userId);
  await prisma.$transaction(async (tx) => {
    for (const p of parsed) {
      const f = await reviewable(tx, personId, p.factId);
      if (p.decision === "CONFIRM" && !(f.confidenceBand === "HIGH" && !f.handwritten && f.exactCopyCheck === "PASSED")) {
        throw new BadRequestError("Only high-confidence printed facts can be confirmed together; decide the others one by one.");
      }
      await decide(tx, f, userId, p.version, p.decision === "CONFIRM" ? "CONFIRMED" : "REJECTED");
    }
  });
  await recordAuditEvent("person.fact.bulkReviewed", userId, { personId, count: parsed.length, confirmed: parsed.filter((p) => p.decision === "CONFIRM").length });
  return { decided: parsed.length };
}
