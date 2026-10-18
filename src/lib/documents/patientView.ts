import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { emitDomainEvent } from "@/lib/events/emit";
import { getStorageAdapter } from "@/lib/storage";
import { requireOwnedPerson } from "@/lib/person/access";
import { createRun, TERMINAL_RUN } from "./pipelineState";

/**
 * Week 4a — what the person sees of their documents' processing
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §9). Owner only (Week 4a); another
 * Person's document is a 404. Reads are audited like other record reads.
 */

const SIGNED_URL_SECONDS = 300;
export const COULD_NOT_READ = "We couldn't read this document; it is saved as it is.";

async function ownDocument(userId: string, documentId: string) {
  const personId = await requireOwnedPerson(userId);
  const doc = await prisma.personDocument.findUnique({ where: { id: documentId }, select: { id: true, personId: true, status: true, type: true } });
  if (!doc || doc.personId !== personId || doc.status !== "CURRENT") throw new NotFoundError();
  return { personId, doc };
}

const latestRun = (documentId: string) => prisma.documentProcessing.findFirst({ where: { documentId }, orderBy: { run: "desc" }, include: { steps: { select: { step: true, status: true } }, texts: { select: { pageNo: true, language: true, handwritten: true, translations: { select: { targetLanguage: true, exactCopyCheck: true } } } } } });

/** Run status, steps (status only), pages, languages, whether a translation exists, fact counts. */
export async function processingStatus(userId: string, documentId: string) {
  await ownDocument(userId, documentId);
  const run = await latestRun(documentId);
  if (!run) return { status: "NOT_PROCESSED" as const };
  const facts = await prisma.extractedFact.groupBy({ by: ["reviewStatus"], where: { processingId: run.id }, _count: true });
  return {
    processingId: run.id, run: run.run, status: run.status, skipReason: run.skipReason, targetLanguage: run.targetLanguage, pageCount: run.pageCount,
    steps: run.steps.map((s) => ({ step: s.step, status: s.status })),
    languages: [...new Set(run.texts.map((t) => t.language))].sort(), handwritten: run.texts.some((t) => t.handwritten),
    translated: run.texts.some((t) => t.translations.some((x) => x.targetLanguage === run.targetLanguage && x.exactCopyCheck === "PASSED")),
    facts: Object.fromEntries(facts.map((f) => [f.reviewStatus, f._count])),
    ...(run.status === "FAILED" ? { message: COULD_NOT_READ } : {}),
  };
}

/**
 * One page: the original image (a short-lived signed URL), the text as read
 * and, only if it passed the exact-copy check, the translation. Each part is
 * labelled; a translation that failed is never shown, the original is.
 */
export async function pageView(userId: string, documentId: string, pageNo: number) {
  if (!Number.isInteger(pageNo) || pageNo < 1) throw new BadRequestError("Page numbers start at 1.");
  const { personId } = await ownDocument(userId, documentId);
  const run = await latestRun(documentId);
  const page = run && (await prisma.documentPage.findUnique({ where: { processingId_pageNo: { processingId: run.id, pageNo } } }));
  if (!run || !page) throw new NotFoundError();
  const text = await prisma.extractedText.findUnique({ where: { processingId_pageNo: { processingId: run.id, pageNo } }, include: { translations: { where: { targetLanguage: run.targetLanguage } } } });
  const tr = text?.translations[0];
  const image = await getStorageAdapter().signedDownloadUrl(page.storageRef, SIGNED_URL_SECONDS);
  await recordAuditEvent("person.document.pageViewed", userId, { personId, documentId, processingId: run.id, pageNo });
  return {
    pageNo, pageCount: run.pageCount,
    original: { label: "ORIGINAL" as const, imageUrl: image.url, expiresAt: image.expiresAt, contentType: page.contentType },
    text: text ? { label: "TEXT_AS_READ" as const, text: text.text, language: text.language, handwritten: text.handwritten } : null,
    translation: tr?.exactCopyCheck === "PASSED"
      ? { label: "TRANSLATION" as const, text: tr.text, language: tr.targetLanguage, note: "Machine translation. Medicine names, doses and numbers are copied exactly from the original." }
      : tr ? { label: "TRANSLATION_WITHHELD" as const, note: "This translation couldn't keep every value exactly, so the original is shown instead." } : null,
  };
}

export const REPROCESS_REASONS = ["PATIENT_REQUEST", "LANGUAGE_CHANGED"] as const;

/** A fresh run of a document (e.g. after changing the app language). Only when no run is open. */
export async function requestReprocess(userId: string, documentId: string, reason: unknown) {
  if (!(REPROCESS_REASONS as readonly unknown[]).includes(reason)) throw new BadRequestError(`reason must be one of ${REPROCESS_REASONS.join(", ")}.`);
  const { personId, doc } = await ownDocument(userId, documentId);
  if (doc.type === "ID_PROOF") throw new BadRequestError("ID proofs are never processed.");
  const person = await prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { preferredLanguage: true } });
  try {
    const run = await prisma.$transaction(async (tx) => {
      const latest = await tx.documentProcessing.findFirst({ where: { documentId }, orderBy: { run: "desc" }, select: { status: true } });
      if (latest && !TERMINAL_RUN.includes(latest.status)) throw new ConflictError("This document is still being processed or awaits your review.");
      const r = await createRun(tx, { personId, documentId, targetLanguage: person.preferredLanguage });
      await emitDomainEvent(tx, { type: "DocumentReprocessRequested", aggregateId: r.id, personId, actorUserId: userId, payload: { processingId: r.id, documentId, personId, reason: reason as (typeof REPROCESS_REASONS)[number] } });
      return r;
    });
    await recordAuditEvent("person.document.reprocessRequested", userId, { personId, documentId, processingId: run.id, reason });
    return { processingId: run.id, run: run.run, status: run.status };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ConflictError("This document is already being processed.");
    throw err;
  }
}
