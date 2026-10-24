import { registerConsumer, getConsumerNames } from "@/lib/events/consumers";
import { workflowConsumer } from "@/lib/workflows/consumer";
import { taskGenerator } from "@/lib/consumers/taskGenerator";
import { marScheduler } from "@/lib/consumers/marScheduler";
import { notificationDispatch } from "@/lib/consumers/notificationDispatch";
import { chargeCapture } from "@/lib/consumers/chargeCapture";
import { stockMovement } from "@/lib/consumers/stockMovement";
import { claimDrafting } from "@/lib/consumers/claimDrafting";
import { dischargeReadiness } from "@/lib/consumers/dischargeReadiness";
import { ragIndexer } from "@/lib/consumers/ragIndexer";
import { personNotifier } from "@/lib/consumers/personNotifier";
import { directorySlots } from "@/lib/doctors/slots";
import { shareLifecycle } from "@/lib/doctors/booking";
import { checkInLifecycle } from "@/lib/insurance/checkin";
import { claimDocumentsLifecycle } from "@/lib/insurance/claimDocuments";
import { patientInsuranceNotify } from "@/lib/insurance/notify";
import { docAllergyBridge, docConflicts, docExtract, docMerge, docOcr, docPageSplit, docTranslate, docWithdrawal } from "@/lib/consumers/documentPipeline";

/**
 * Workflow spine §3.1 — the one place every domain-event consumer is
 * registered. The runner calls this before dispatching, so no entry point can
 * dispatch without, say, the workflow engine (previously a side-effect import
 * in individual routes). Idempotent: registration is keyed by name.
 */
export const EXPECTED_CONSUMERS = ["observability-projection", "workflow-engine", "task-generator", "mar-scheduler", "notification-dispatch", "charge-capture", "stock-movement", "claim-drafting", "discharge-readiness", "doc-page-split", "doc-ocr", "doc-translate", "doc-extract", "doc-merge", "doc-allergy-bridge", "doc-withdrawal", "doc-conflicts", "rag-indexer", "person-notifier", "directory-slots", "share-lifecycle", "checkin-lifecycle", "claim-documents-lifecycle", "patient-insurance-notify"] as const;

export function registerAllConsumers(): string[] {
  registerConsumer(workflowConsumer);
  registerConsumer(taskGenerator);
  registerConsumer(marScheduler);
  registerConsumer(notificationDispatch);
  registerConsumer(chargeCapture);
  registerConsumer(stockMovement);
  registerConsumer(claimDrafting);
  registerConsumer(dischargeReadiness);
  registerConsumer(docPageSplit);
  registerConsumer(docOcr);
  registerConsumer(docTranslate);
  registerConsumer(docExtract);
  registerConsumer(docMerge);
  registerConsumer(docAllergyBridge);
  registerConsumer(docWithdrawal);
  registerConsumer(docConflicts);
  registerConsumer(ragIndexer);
  registerConsumer(personNotifier);
  registerConsumer(directorySlots);
  registerConsumer(shareLifecycle);
  registerConsumer(checkInLifecycle);
  registerConsumer(claimDocumentsLifecycle);
  registerConsumer(patientInsuranceNotify);
  return getConsumerNames();
}
