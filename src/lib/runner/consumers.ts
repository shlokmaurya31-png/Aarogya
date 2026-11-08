import { declareConsumerRegistry, getConsumerNames, observabilityProjection, registerConsumer, type DomainEventConsumer } from "@/lib/events/consumers";
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
 * Workflow spine §3.1, Flagship 2b — THE consumer registry: the one list of
 * every domain-event consumer. Every entry point that dispatches (the worker,
 * POST /api/cron/tick, the platform dispatch route, the gates) registers this
 * list through registerAllConsumers(); nothing else registers a production
 * consumer (the consumer-registry gate checks). Loading this module declares
 * the list to the dispatcher, which refuses to run while any of it is missing
 * and marks an event PROCESSED only when every consumer listed for its type
 * has handled it. Idempotent: registration is keyed by name.
 */
export const CONSUMER_REGISTRY: readonly DomainEventConsumer[] = [
  observabilityProjection,
  workflowConsumer,
  taskGenerator,
  marScheduler,
  notificationDispatch,
  chargeCapture,
  stockMovement,
  claimDrafting,
  dischargeReadiness,
  docPageSplit,
  docOcr,
  docTranslate,
  docExtract,
  docMerge,
  docAllergyBridge,
  docWithdrawal,
  docConflicts,
  ragIndexer,
  personNotifier,
  directorySlots,
  shareLifecycle,
  checkInLifecycle,
  claimDocumentsLifecycle,
  patientInsuranceNotify,
];

export const EXPECTED_CONSUMERS = ["observability-projection", "workflow-engine", "task-generator", "mar-scheduler", "notification-dispatch", "charge-capture", "stock-movement", "claim-drafting", "discharge-readiness", "doc-page-split", "doc-ocr", "doc-translate", "doc-extract", "doc-merge", "doc-allergy-bridge", "doc-withdrawal", "doc-conflicts", "rag-indexer", "person-notifier", "directory-slots", "share-lifecycle", "checkin-lifecycle", "claim-documents-lifecycle", "patient-insurance-notify"] as const;

declareConsumerRegistry(CONSUMER_REGISTRY);

/** Registers every consumer of the registry; returns the names now registered in this process. */
export function registerAllConsumers(): string[] {
  for (const c of CONSUMER_REGISTRY) registerConsumer(c);
  return getConsumerNames();
}
