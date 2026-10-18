import type { DomainEventConsumer } from "@/lib/events/consumers";
import { extractStep, ocrStep, pageSplitStep, runForUpload, translateStep } from "@/lib/documents/pipeline";

/**
 * Week 4a — the document pipeline's consumers (docs/DOCUMENT_PIPELINE_DESIGN.md
 * §4.1). Each handles the previous step's event and runs one step; all are
 * idempotent (the step rows are the ledger) and resumable.
 */
const processingIdOf = (p: Record<string, unknown>) => String(p.processingId);

export const docPageSplit: DomainEventConsumer = {
  name: "doc-page-split",
  handles: ["PersonDocumentUploaded"],
  async handle(event) {
    const run = await runForUpload(String(event.payload.documentId));
    if (run) await pageSplitStep(run.id);
  },
};

export const docOcr: DomainEventConsumer = {
  name: "doc-ocr",
  handles: ["DocumentPagesPrepared"],
  async handle(event) {
    await ocrStep(processingIdOf(event.payload));
  },
};

export const docTranslate: DomainEventConsumer = {
  name: "doc-translate",
  handles: ["DocumentTextExtracted"],
  async handle(event) {
    await translateStep(processingIdOf(event.payload));
  },
};

export const docExtract: DomainEventConsumer = {
  name: "doc-extract",
  handles: ["DocumentTranslated"],
  async handle(event) {
    await extractStep(processingIdOf(event.payload));
  },
};
