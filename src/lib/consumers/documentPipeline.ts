import type { DomainEventConsumer } from "@/lib/events/consumers";
import { extractStep, ocrStep, pageSplitStep, runForUpload, translateStep } from "@/lib/documents/pipeline";
import { mergeReviewedFact, rebridgePerson, withdrawDocumentDerived } from "@/lib/documents/merge";
import { checkRecordConflicts, recheckForPatient } from "@/lib/documents/conflicts";

/**
 * Week 4a — the document pipeline's consumers (docs/DOCUMENT_PIPELINE_DESIGN.md
 * §4.1). Each handles the previous step's event and runs one step; all are
 * idempotent (the step rows are the ledger) and resumable.
 */
const processingIdOf = (p: Record<string, unknown>) => String(p.processingId);

export const docPageSplit: DomainEventConsumer = {
  name: "doc-page-split",
  handles: ["PersonDocumentUploaded", "DocumentReprocessRequested"],
  async handle(event) {
    // A reprocess request names its new run; an upload makes (or finds) one.
    if (event.eventType === "DocumentReprocessRequested") return void (await pageSplitStep(processingIdOf(event.payload)));
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

export const docMerge: DomainEventConsumer = {
  name: "doc-merge",
  handles: ["ExtractedFactReviewed"],
  async handle(event) {
    await mergeReviewedFact(String(event.payload.factId));
  },
};

/** Patient-provided allergies follow the sharing choice and the person's links (§3). */
export const docAllergyBridge: DomainEventConsumer = {
  name: "doc-allergy-bridge",
  handles: ["PersonConsentDecided", "PersonPatientLinked", "PersonPatientUnlinked", "PersonAccountClosed", "PersonAccountReopened"],
  async handle(event) {
    const p = event.payload as { personId: string; purpose?: string; patientId?: string };
    if (event.eventType === "PersonConsentDecided" && p.purpose !== "SHARE_UPLOADS_WITH_TREATING") return;
    await rebridgePerson(p.personId, event.eventType === "PersonPatientUnlinked" ? { patientId: p.patientId, ended: true } : {});
  },
};

/** The person withdrew an upload: its run is cancelled and its entries withdrawn (§4.3). */
export const docWithdrawal: DomainEventConsumer = {
  name: "doc-withdrawal",
  handles: ["PersonDocumentWithdrawn"],
  async handle(event) {
    await withdrawDocumentDerived(String(event.payload.documentId));
  },
};

/**
 * Conflicts with verified records (§8): a new patient-provided entry is
 * checked against the linked facility records; a verified record of a linked
 * patient (released result, recorded diagnosis, allergy change, verified
 * order) re-checks that person's entries of the same kind.
 */
export const docConflicts: DomainEventConsumer = {
  name: "doc-conflicts",
  handles: ["PatientProvidedRecordAdded", "LabResultReleased", "DiagnosisRecorded", "AllergyListUpdated", "MedicationVerified"],
  async handle(event) {
    const p = event.payload as { recordId?: string; patientId?: string; source?: string };
    if (event.eventType === "PatientProvidedRecordAdded") return void (await checkRecordConflicts(String(p.recordId)));
    // A bridged patient-provided allergy is not a verified record.
    if (event.eventType === "AllergyListUpdated" && p.source === "PATIENT_PROVIDED") return;
    if (!p.patientId) return;
    const kind = ({ LabResultReleased: "LAB_RESULT", DiagnosisRecorded: "DIAGNOSIS", AllergyListUpdated: "ALLERGY", MedicationVerified: "MEDICATION_HISTORY" } as const)[event.eventType as "LabResultReleased"];
    await recheckForPatient(p.patientId, kind);
  },
};
