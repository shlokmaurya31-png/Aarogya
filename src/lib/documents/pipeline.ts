import type { DocumentProcessing, DocumentStepError, DocumentStepKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getStorageAdapter } from "@/lib/storage";
import { emitDomainEvent } from "@/lib/events/emit";
import { PermanentEventError, RetryableEventError } from "@/lib/events/types";
import { documentProcessingPermit } from "@/lib/ai/realData";
import { DocumentProviderError, getDocumentProviders, type CandidateFact, type Line, type OcrResult, type ProcessingPermit } from "@/lib/ai/documents";
import { medicineDictionary } from "@/lib/medicines/reference";
import { claimStep, createRun, finishStep, moveRun, MAX_STEP_ATTEMPTS, STALE_CLAIM_MS, TERMINAL_RUN } from "./pipelineState";
import { MAX_PAGES, splitPdf, stripProtected, translateText } from "./steps";
import { detectLanguage, isSupportedLanguage } from "./language";
import { bandOf, LOW_THRESHOLD } from "./confidence";
import { identifierSpans, personIdentifiers } from "./identifiers";
import { assessCandidates, maskIdentifierLines } from "./assess";

type Tx = Prisma.TransactionClient;

/**
 * Week 4a — the pipeline's steps (docs/DOCUMENT_PIPELINE_DESIGN.md §1, §4):
 * page split, OCR (with language detection), translation and fact extraction
 * (from the original text, never a translation), each run by its
 * consumer (src/lib/consumers/documentPipeline.ts).
 *
 * Every step:
 *   - asks the real-data gate first (a refused Person's run is SKIPPED before
 *     anything is read; consent withdrawn mid-run CANCELS it), and passes the
 *     permit to every provider call;
 *   - claims its step row (compare-and-set); a fresh claim held elsewhere is
 *     retried later, a stale one (10 min) is taken over;
 *   - calls providers outside transactions, writes each page's result in a
 *     short transaction that re-checks the step is still RUNNING, and skips
 *     pages already done (a resumed step never redoes a page);
 *   - transient provider errors retry with the dispatcher's backoff (up to 5
 *     attempts); permanent ones fail the step and the run and emit
 *     DocumentProcessingFailed. The original upload is never touched.
 */

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export { MAX_PAGES };
const OPEN_RUN = ["QUEUED", "RUNNING", "AWAITING_REVIEW"] as const;
const PAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
/** Uploads of these types are never processed: they hold identifiers, not health facts. */
const NEVER_PROCESSED = ["ID_PROOF"];

class StepGone extends Error {}

async function loadRun(processingId: string): Promise<DocumentProcessing> {
  const run = await prisma.documentProcessing.findUnique({ where: { id: processingId } });
  if (!run) throw new PermanentEventError("Processing run not found.", "RUN_NOT_FOUND");
  return run;
}

/** The run for an uploaded document: created on first delivery, reused after. */
export async function runForUpload(documentId: string): Promise<DocumentProcessing | null> {
  const doc = await prisma.personDocument.findUnique({ where: { id: documentId }, select: { id: true, personId: true, status: true, type: true, person: { select: { preferredLanguage: true } } } });
  // Gone (purged with a closed account, or merged away): nothing to process.
  if (!doc) return null;
  if (doc.status !== "CURRENT" || NEVER_PROCESSED.includes(doc.type)) return null;
  const latest = await prisma.documentProcessing.findFirst({ where: { documentId }, orderBy: { run: "desc" } });
  if (latest) return (OPEN_RUN as readonly string[]).includes(latest.status) ? latest : null;
  try {
    return await prisma.$transaction((tx) => createRun(tx, { personId: doc.personId, documentId, targetLanguage: doc.person.preferredLanguage }));
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    return prisma.documentProcessing.findFirst({ where: { documentId, status: { in: [...OPEN_RUN] } } });
  }
}

/** The gate: a permit, or the run is SKIPPED (not started) / CANCELLED (started). */
async function gate(run: DocumentProcessing): Promise<ProcessingPermit | null> {
  const g = await documentProcessingPermit(run.personId);
  if (g.allowed) return g.permit;
  await prisma.$transaction(async (tx) => {
    const cur = await tx.documentProcessing.findUniqueOrThrow({ where: { id: run.id }, select: { status: true } });
    if (TERMINAL_RUN.includes(cur.status)) return;
    if (cur.status === "QUEUED" && g.reason !== "PERSON_NOT_ACTIVE") await moveRun(tx, run.id, "SKIPPED", { skipReason: g.reason });
    else await moveRun(tx, run.id, "CANCELLED");
    await tx.documentProcessingStep.updateMany({ where: { processingId: run.id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "SKIPPED", finishedAt: new Date(), version: { increment: 1 } } });
  });
  return null;
}

/**
 * Claims a step. null: nothing to do (finished, or the run ended). Throws a
 * retryable error while another worker holds a fresh claim, so the event
 * comes back once that claim is done or stale.
 */
async function claim(run: DocumentProcessing, step: DocumentStepKind, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.documentProcessing.findUniqueOrThrow({ where: { id: run.id }, select: { status: true } });
    if (TERMINAL_RUN.includes(cur.status)) return null;
    const claimed = await claimStep(tx, run.id, step, now);
    if (claimed) {
      if (cur.status === "QUEUED") await moveRun(tx, run.id, "RUNNING");
      return claimed;
    }
    const s = await tx.documentProcessingStep.findUniqueOrThrow({ where: { processingId_step: { processingId: run.id, step } } });
    if (s.status === "PENDING" || s.status === "DONE" || s.status === "SKIPPED" || s.status === "FAILED") return null;
    if (s.attempts >= MAX_STEP_ATTEMPTS) {
      await failInTx(tx, run, step, s.lastErrorCode ?? "INTERNAL");
      return null;
    }
    throw new RetryableEventError(`Step ${step} is held by another worker (stale after ${STALE_CLAIM_MS / 60000} min).`, "STEP_BUSY");
  });
}

async function failInTx(tx: Tx, run: DocumentProcessing, step: DocumentStepKind, code: DocumentStepError) {
  const s = await tx.documentProcessingStep.findUniqueOrThrow({ where: { processingId_step: { processingId: run.id, step } } });
  if (s.status === "RUNNING") await tx.documentProcessingStep.update({ where: { id: s.id }, data: { status: "FAILED", lastErrorCode: code, finishedAt: new Date(), version: { increment: 1 } } });
  await tx.documentProcessingStep.updateMany({ where: { processingId: run.id, status: "PENDING" }, data: { status: "SKIPPED", finishedAt: new Date(), version: { increment: 1 } } });
  await moveRun(tx, run.id, "FAILED");
  await emitDomainEvent(tx, {
    type: "DocumentProcessingFailed", aggregateId: run.id, personId: run.personId,
    payload: { processingId: run.id, documentId: run.documentId, personId: run.personId, step, errorCode: code },
  });
}

/**
 * A provider or input error on a claimed step: transient ones keep the step
 * RUNNING and throw so the dispatcher retries; permanent ones (or the last
 * attempt) fail the step and the run.
 */
async function stepError(run: DocumentProcessing, step: DocumentStepKind, code: DocumentStepError): Promise<never | void> {
  const transient = await prisma.$transaction(async (tx) => {
    const r = await finishStep(tx, run.id, step, { status: "FAILED", error: code });
    if (!r.transient) {
      await tx.documentProcessingStep.updateMany({ where: { processingId: run.id, status: "PENDING" }, data: { status: "SKIPPED", finishedAt: new Date(), version: { increment: 1 } } });
      await moveRun(tx, run.id, "FAILED");
      await emitDomainEvent(tx, { type: "DocumentProcessingFailed", aggregateId: run.id, personId: run.personId, payload: { processingId: run.id, documentId: run.documentId, personId: run.personId, step, errorCode: code } });
    }
    return r.transient;
  });
  if (transient) throw new RetryableEventError(`Document step ${step} failed: ${code}`, code);
}

function providerCode(err: unknown): DocumentStepError | null {
  return err instanceof DocumentProviderError ? err.code : null;
}

/** Inside a page write: the step must still be ours and RUNNING. */
async function assertRunning(tx: Tx, processingId: string, step: DocumentStepKind) {
  const s = await tx.documentProcessingStep.findUnique({ where: { processingId_step: { processingId, step } }, select: { status: true } });
  const r = await tx.documentProcessing.findUnique({ where: { id: processingId }, select: { status: true } });
  if (s?.status !== "RUNNING" || !r || TERMINAL_RUN.includes(r.status)) throw new StepGone();
}

async function ifStillRunning<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (err) { if (err instanceof StepGone) return null; throw err; }
}

/**
 * A step that crashes (not a provider error: a bug, a lost connection) gives
 * its claim back, so the event's retry can take the step over at once rather
 * than waiting for the claim to go stale. A worker killed outright can't do
 * this; resumeStalledDocumentSteps (the runner) picks those up.
 */
async function releasingOnCrash(processingId: string, step: DocumentStepKind, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof RetryableEventError) && !(err instanceof PermanentEventError)) {
      await prisma.documentProcessingStep.updateMany({ where: { processingId, step, status: "RUNNING" }, data: { startedAt: null, version: { increment: 1 } } }).catch(() => undefined);
    }
    throw err;
  }
}

// ── Step 1: page split ─────────────────────────────────────────────────────

async function pageSplitStepInner(processingId: string) {
  const run = await loadRun(processingId);
  if (TERMINAL_RUN.includes(run.status)) return;
  const permit = await gate(run);
  if (!permit) return;
  if (!(await claim(run, "PAGE_SPLIT"))) return;
  const doc = await prisma.personDocument.findUniqueOrThrow({ where: { id: run.documentId }, select: { storageRef: true, contentType: true, status: true } });
  if (doc.status !== "CURRENT") return void (await prisma.$transaction((tx) => moveRun(tx, run.id, "CANCELLED")));
  const storage = getStorageAdapter();
  const original = await storage.get(doc.storageRef);
  if (original.bytes.length > MAX_DOCUMENT_BYTES) return stepError(run, "PAGE_SPLIT", "TOO_LARGE");
  // The type recorded at upload (checked against the bytes then); local storage doesn't keep it.
  const type = doc.contentType || original.contentType || "";
  const pages = type === "application/pdf" ? await splitPdf(original.bytes) : PAGE_TYPES.includes(type) ? [original.bytes] : "UNREADABLE";
  if (typeof pages === "string") return stepError(run, "PAGE_SPLIT", pages as DocumentStepError);
  const have = new Set((await prisma.documentPage.findMany({ where: { processingId }, select: { pageNo: true } })).map((p) => p.pageNo));
  const stored: { pageNo: number; storageRef: string; sha256: string; contentType: string }[] = [];
  for (const [i, bytes] of pages.entries()) {
    if (have.has(i + 1)) continue;
    const ext = type === "application/pdf" ? "pdf" : type.split("/")[1];
    const s = await storage.put({ bucket: "patient-uploads", bytes, contentType: type, originalName: `page-${i + 1}.${ext}`, scope: run.personId });
    stored.push({ pageNo: i + 1, storageRef: s.storageRef, sha256: s.sha256, contentType: s.contentType });
  }
  const done = await ifStillRunning(() => prisma.$transaction(async (tx) => {
    await assertRunning(tx, processingId, "PAGE_SPLIT");
    await tx.documentPage.createMany({ data: stored.map((p) => ({ ...p, processingId, personId: run.personId })), skipDuplicates: true });
    await tx.documentProcessing.update({ where: { id: processingId }, data: { pageCount: pages.length } });
    await finishStep(tx, processingId, "PAGE_SPLIT", { status: "DONE" }, { provider: "pdf-lib" });
    await emitDomainEvent(tx, { type: "DocumentPagesPrepared", aggregateId: processingId, personId: run.personId, payload: { processingId, documentId: run.documentId, personId: run.personId, pageCount: pages.length } });
    return true;
  }));
  // Objects written for a step that was no longer ours are removed (never a dangling row).
  if (!done) for (const p of stored) if (!(await prisma.documentPage.count({ where: { storageRef: p.storageRef } }))) await storage.delete(p.storageRef).catch(() => undefined);
}

// ── Step 2: OCR and language ───────────────────────────────────────────────

async function ocrStepInner(processingId: string) {
  const run = await loadRun(processingId);
  if (TERMINAL_RUN.includes(run.status)) return;
  const permit = await gate(run);
  if (!permit) return;
  if (!(await claim(run, "OCR"))) return;
  const { ocr } = getDocumentProviders();
  const storage = getStorageAdapter();
  const { names: dictionary } = await medicineDictionary();
  const pages = await prisma.documentPage.findMany({ where: { processingId }, orderBy: { pageNo: "asc" } });
  const done = new Set((await prisma.extractedText.findMany({ where: { processingId }, select: { pageNo: true } })).map((t) => t.pageNo));
  let model = "";
  for (const page of pages) {
    if (done.has(page.pageNo)) continue;
    const { bytes } = await storage.get(page.storageRef);
    let r: OcrResult;
    try {
      r = await ocr.ocrPage({ bytes, contentType: page.contentType }, {}, permit);
      if (r.confidence < LOW_THRESHOLD || r.handwritten) {
        // Low confidence or handwriting: one retry with the retry model; the better result is kept.
        const second = await ocr.ocrPage({ bytes, contentType: page.contentType }, { retry: true }, permit).catch(() => null);
        if (second && second.confidence > r.confidence) r = second;
      }
    } catch (err) {
      const code = providerCode(err);
      if (!code) throw err;
      return stepError(run, "OCR", code);
    }
    model = r.model;
    const detected = detectLanguage(r.layout.map((l) => stripProtected(l.text, dictionary)));
    const layout: Line[] = r.layout.map((l, i) => ({ ...l, language: detected.lines[i] ?? undefined }));
    const ok = await ifStillRunning(() => prisma.$transaction(async (tx) => {
      await assertRunning(tx, processingId, "OCR");
      await tx.extractedText.create({
        data: {
          processingId, personId: run.personId, pageNo: page.pageNo, text: r.text, layout: layout as unknown as Prisma.InputJsonValue,
          language: detected.language, script: detected.script, handwritten: r.handwritten, confidence: r.confidence, provider: ocr.id, model: r.model,
        },
      });
      return true;
    }));
    if (!ok) return;
  }
  await ifStillRunning(() => prisma.$transaction(async (tx) => {
    await assertRunning(tx, processingId, "OCR");
    const texts = await tx.extractedText.findMany({ where: { processingId }, select: { language: true, handwritten: true, confidence: true, model: true } });
    await finishStep(tx, processingId, "OCR", { status: "DONE" }, { provider: ocr.id, model: model || texts[0]?.model });
    await emitDomainEvent(tx, {
      type: "DocumentTextExtracted", aggregateId: processingId, personId: run.personId,
      payload: {
        processingId, documentId: run.documentId, personId: run.personId, pageCount: texts.length,
        languages: [...new Set(texts.map((t) => t.language))].sort() as never, handwritten: texts.some((t) => t.handwritten),
        confidenceBand: bandOf(Math.min(...texts.map((t) => t.confidence))),
      },
    });
  }));
}

// ── Step 3: translation with the exact-copy check ──────────────────────────

async function translateStepInner(processingId: string) {
  const run = await loadRun(processingId);
  if (TERMINAL_RUN.includes(run.status)) return;
  const permit = await gate(run);
  if (!permit) return;
  if (!(await claim(run, "TRANSLATE"))) return;
  const { translation } = getDocumentProviders();
  const target = run.targetLanguage;
  const texts = await prisma.extractedText.findMany({ where: { processingId }, orderBy: { pageNo: "asc" }, include: { translations: { where: { targetLanguage: target }, select: { id: true } } } });
  const finish = async (skipped: boolean) => ifStillRunning(() => prisma.$transaction(async (tx) => {
    await assertRunning(tx, processingId, "TRANSLATE");
    const rows = await tx.translation.findMany({ where: { extractedText: { processingId }, targetLanguage: target }, select: { exactCopyCheck: true, model: true } });
    await finishStep(tx, processingId, "TRANSLATE", { status: skipped ? "SKIPPED" : "DONE" }, { provider: translation.id, model: rows[0]?.model });
    await emitDomainEvent(tx, {
      type: "DocumentTranslated", aggregateId: processingId, personId: run.personId,
      payload: {
        processingId, documentId: run.documentId, personId: run.personId, targetLanguage: isSupportedLanguage(target) ? target : "und",
        translatedPages: rows.filter((r) => r.exactCopyCheck === "PASSED").length, exactCopyFailures: rows.filter((r) => r.exactCopyCheck === "FAILED").length, skipped,
      },
    });
  }));
  // An app language the pipeline can't translate into: the original is shown, as for a same-language page.
  if (!isSupportedLanguage(target)) return void (await finish(true));
  const todo = texts.filter((t) => t.language !== target && t.translations.length === 0);
  const unsupported = todo.find((t) => t.language !== "mixed" && !isSupportedLanguage(t.language));
  if (unsupported) return stepError(run, "TRANSLATE", "UNSUPPORTED_LANGUAGE");
  if (!texts.some((t) => t.language !== target)) return void (await finish(true));
  const { names: dictionary } = await medicineDictionary();
  const identifiers = await personIdentifiers(run.personId);
  for (const t of todo) {
    let r: Awaited<ReturnType<typeof translateText>>;
    try {
      r = await translateText(t.text, t.language, target, dictionary, identifiers, getDocumentProviders(), permit);
    } catch (err) {
      const code = providerCode(err);
      if (!code) throw err;
      return stepError(run, "TRANSLATE", code);
    }
    const ok = await ifStillRunning(() => prisma.$transaction(async (tx) => {
      await assertRunning(tx, processingId, "TRANSLATE");
      // A failed check keeps only the translator's raw (placeholder) output, for diagnosis; it is never shown.
      await tx.translation.create({
        data: {
          extractedTextId: t.id, personId: run.personId, targetLanguage: target, text: r.text, exactCopyCheck: r.check, provider: translation.id, model: r.model,
          protectedSpans: r.spans.spans.map((s, i) => ({ kind: s.kind, start: s.start, end: s.end, placeholder: `⟦P${i + 1}⟧` })) as unknown as Prisma.InputJsonValue,
        },
      });
      return true;
    }));
    if (!ok) return;
  }
  await finish(false);
}

export async function pageSplitStep(processingId: string) {
  return releasingOnCrash(processingId, "PAGE_SPLIT", () => pageSplitStepInner(processingId));
}

export async function ocrStep(processingId: string) {
  return releasingOnCrash(processingId, "OCR", () => ocrStepInner(processingId));
}

export async function translateStep(processingId: string) {
  return releasingOnCrash(processingId, "TRANSLATE", () => translateStepInner(processingId));
}

// ── Step 4: fact extraction (from the original text, never a translation) ──

export async function extractStep(processingId: string) {
  return releasingOnCrash(processingId, "EXTRACT", () => extractStepInner(processingId));
}

async function extractStepInner(processingId: string) {
  const run = await loadRun(processingId);
  if (TERMINAL_RUN.includes(run.status)) return;
  const permit = await gate(run);
  if (!permit) return;
  if (!(await claim(run, "EXTRACT"))) return;
  const { extraction } = getDocumentProviders();
  // The original OCR text: translations are never read here.
  const texts = await prisma.extractedText.findMany({ where: { processingId }, orderBy: { pageNo: "asc" }, select: { pageNo: true, text: true, layout: true, language: true, handwritten: true, confidence: true } });
  const done = new Set((await prisma.extractedFact.findMany({ where: { processingId }, select: { pageNo: true }, distinct: ["pageNo"] })).map((f) => f.pageNo));
  const identifiers = await personIdentifiers(run.personId);
  let model = "";
  for (const t of texts) {
    if (done.has(t.pageNo)) continue;
    const layout = t.layout as unknown as Line[];
    // The person's identifiers never reach the extractor; placeholders come back restored.
    const ids = maskIdentifierLines(layout.map((l) => l.text), (s) => identifierSpans(s, identifiers));
    const maskedLayout = layout.map((l, i) => ({ ...l, text: ids.masked[i] }));
    const page = { text: ids.masked.join("\n"), layout: maskedLayout, language: t.language };
    let first: CandidateFact[];
    let second: CandidateFact[] | undefined;
    try {
      const r = await extraction.extract(page, permit);
      first = r.facts;
      model = r.model;
      // Handwritten pages: a second pass with a different prompt; disagreement on an exact field forces LOW (§7).
      if (t.handwritten) second = (await extraction.extract(page, permit, { pass: 2 })).facts;
    } catch (err) {
      const code = providerCode(err);
      if (!code) throw err;
      return stepError(run, "EXTRACT", code);
    }
    const restore = (cs: CandidateFact[]) => cs.map((c) => ({ ...c, value: ids.restoreDeep(c.value) as Record<string, unknown>, sourceText: ids.restoreText(c.sourceText) }));
    const { facts } = assessCandidates({ pageNo: t.pageNo, text: t.text, layout, handwritten: t.handwritten, confidence: t.confidence }, restore(first), second && restore(second));
    const ok = await ifStillRunning(() => prisma.$transaction(async (tx) => {
      await assertRunning(tx, processingId, "EXTRACT");
      // A page with no facts writes nothing; a resume asks the extractor about that page again.
      if (facts.length) await tx.extractedFact.createMany({
        data: facts.map((f) => ({
          processingId, personId: run.personId, factType: f.factType, value: f.value as Prisma.InputJsonValue, confidence: f.confidence, confidenceBand: f.confidenceBand,
          handwritten: f.handwritten, pageNo: f.pageNo, region: (f.region ?? undefined) as Prisma.InputJsonValue | undefined, sourceText: f.sourceText, exactCopyCheck: f.exactCopyCheck,
        })),
      });
      return true;
    }));
    if (!ok) return;
  }
  await ifStillRunning(() => prisma.$transaction(async (tx) => {
    await assertRunning(tx, processingId, "EXTRACT");
    const facts = await tx.extractedFact.findMany({ where: { processingId }, select: { confidenceBand: true } });
    await finishStep(tx, processingId, "EXTRACT", { status: "DONE" }, { provider: extraction.id, model: model || undefined });
    await emitDomainEvent(tx, {
      type: "DocumentFactsExtracted", aggregateId: processingId, personId: run.personId,
      payload: { processingId, documentId: run.documentId, personId: run.personId, factCount: facts.length, lowConfidenceCount: facts.filter((f) => f.confidenceBand === "LOW").length },
    });
    if (facts.length) {
      await moveRun(tx, processingId, "AWAITING_REVIEW");
    } else {
      // Nothing to review: the run is complete; the original stays as it is.
      await tx.documentProcessingStep.updateMany({ where: { processingId, step: "MERGE", status: "PENDING" }, data: { status: "SKIPPED", finishedAt: new Date(), version: { increment: 1 } } });
      await moveRun(tx, processingId, "COMPLETED");
      await emitDomainEvent(tx, { type: "DocumentProcessingCompleted", aggregateId: processingId, personId: run.personId, payload: { processingId, documentId: run.documentId, personId: run.personId, confirmed: 0, corrected: 0, rejected: 0 } });
    }
  }));
}

const STEP_FN: Partial<Record<DocumentStepKind, (processingId: string) => Promise<void>>> = { PAGE_SPLIT: pageSplitStep, OCR: ocrStep, TRANSLATE: translateStep, EXTRACT: extractStep };

/**
 * The runner's sweep: steps whose claim went stale (a worker killed mid-step,
 * or an event whose retries ran out first) are resumed here, from where they
 * stopped. Bounded; a failure is left for the next tick.
 */
export async function resumeStalledDocumentSteps(opts: { now?: Date; batchSize?: number } = {}) {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - STALE_CLAIM_MS);
  const stalled = await prisma.documentProcessingStep.findMany({
    where: { status: "RUNNING", OR: [{ startedAt: null }, { startedAt: { lt: cutoff } }], processing: { status: "RUNNING" } },
    select: { processingId: true, step: true }, orderBy: { startedAt: "asc" }, take: opts.batchSize ?? 20,
  });
  let resumed = 0;
  for (const s of stalled) {
    const fn = STEP_FN[s.step];
    if (!fn) continue;
    try { await fn(s.processingId); resumed += 1; } catch { /* the next tick tries again */ }
  }
  return { resumed };
}
