import { dispatchPendingDomainEvents, type DispatchResult } from "@/lib/events/dispatcher";
import { tickWorkflows, type TickResult } from "@/lib/workflows/engine";
import { sweepMedicationSchedule, type SweepResult } from "@/lib/hospital/marSweep";
import { sweepDelegationExpiry } from "@/lib/patient/experience/delegationSweep";
import { purgeClosedPersons } from "@/lib/person/closure";
import { resumeStalledDocumentSteps } from "@/lib/documents/pipeline";
import { purgeRetiredEmbeddings, runReembedTick } from "@/lib/rag/reembed";
import { purgeLapsedAiIndexes } from "@/lib/rag/indexer";
import { purgeExpiredAiInteractions } from "@/lib/rag/interactions";
import { sweepConsentLapses } from "@/lib/person/consentLapse";
import { sweepShareExpiry } from "@/lib/sharing/shares";
import { sweepAccessRequestExpiry } from "@/lib/sharing/requests";
import { sweepAccessSummaries } from "@/lib/person/notifications";
import { registerAllConsumers } from "./consumers";

/**
 * Workflow spine §3.1 — one bounded unit of background work, used by the local
 * worker (`npm run worker`) and by POST /api/cron/tick:
 *   1. dispatch pending domain events (claims with FOR UPDATE SKIP LOCKED,
 *      per-aggregate order by seq; reaps abandoned claims first);
 *   2. fire due workflow timers and run runnable workflow instances;
 *   3. sweep the MAR: DUE doses past their grace become MISSED (§3.4);
 *   4. expire family delegations past their expiresAt (§3.4);
 *   5. purge closed accounts past their grace period (Phase 0);
 *   6. resume document-pipeline steps whose claim went stale (Week 4a);
 *   7. one re-embed batch per embedding space being built, and the purge of
 *      retired spaces' embeddings after their grace period (Week 4b);
 *   8. consents decided before an 18th birthday lapse; the AI index of a
 *      lapsed AI consent goes after its 90-day window; retained AI text past
 *      its expiry is cleared and AI metadata past a year deleted (Week 4b);
 *   9. shares past their validity expire, and undecided access requests
 *      past their 7 days (Week 4c).
 * Safe to run concurrently with itself: every claim is SKIP LOCKED + token
 * guarded and every consumer is idempotent.
 */
export interface RunTickOptions {
  now?: Date;
  /** Wall-clock budget for the whole tick. */
  budgetMs?: number;
  eventBatchSize?: number;
  workflowBatchSize?: number;
  marBatchSize?: number;
}

export interface RunTickResult {
  consumers: string[];
  events: DispatchResult;
  workflows: TickResult;
  mar: SweepResult;
  delegations: { expired: number };
  /** Phase 0: closed accounts whose 30-day grace period has ended. */
  closures: { purged: number; deferredForLegalHold: number; documentsDeleted: number; documentsKept: number };
  /** Week 4a: document-pipeline steps resumed after a stale claim. */
  documents: { resumed: number };
  /** Week 4b: chunks embedded into spaces being built; retired embeddings purged. */
  embeddings: { embedded: number; purged: number };
  /** Week 4b: consents lapsed at 18; AI index documents removed after a lapse window. */
  consents: { lapsed: number; aiIndexPurged: number };
  /** Week 4b: retained AI text cleared at expiry; AI interaction metadata deleted after a year. */
  aiInteractions: { textPurged: number; deleted: number };
  /** Week 4c: shares and access requests that expired. */
  sharing: { sharesExpired: number; requestsExpired: number; accessSummaries: number };
  durationMs: number;
  /** True when a batch limit was hit, i.e. there may be more work now. */
  moreWork: boolean;
}

export async function runTick(opts: RunTickOptions = {}): Promise<RunTickResult> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 25_000;
  const eventBatchSize = opts.eventBatchSize ?? 100;
  const workflowBatchSize = opts.workflowBatchSize ?? 100;
  const marBatchSize = opts.marBatchSize ?? 500;
  const consumers = registerAllConsumers();

  const events = await dispatchPendingDomainEvents({ now: opts.now, batchSize: eventBatchSize, maxDurationMs: Math.floor(budgetMs * 0.7) });
  const remaining = Math.max(1, budgetMs - (Date.now() - started));
  const workflows = remaining > 0
    ? await tickWorkflows({ now: opts.now, batchSize: workflowBatchSize })
    : { timersFired: 0, escalated: 0, instancesRun: 0 };
  const mar = Date.now() - started < budgetMs
    ? await sweepMedicationSchedule({ now: opts.now, batchSize: marBatchSize })
    : { missed: 0 };
  const delegations = Date.now() - started < budgetMs ? await sweepDelegationExpiry({ now: opts.now }) : { expired: 0 };
  const closures = Date.now() - started < budgetMs ? await purgeClosedPersons({ now: opts.now }) : { purged: 0, deferredForLegalHold: 0, documentsDeleted: 0, documentsKept: 0 };
  const documents = Date.now() - started < budgetMs ? await resumeStalledDocumentSteps({ now: opts.now }) : { resumed: 0 };
  const embeddings = Date.now() - started < budgetMs
    ? { embedded: (await runReembedTick()).embedded, purged: (await purgeRetiredEmbeddings({ now: opts.now })).deleted }
    : { embedded: 0, purged: 0 };
  const consents = Date.now() - started < budgetMs
    ? { lapsed: (await sweepConsentLapses({ now: opts.now })).lapsed, aiIndexPurged: (await purgeLapsedAiIndexes({ now: opts.now })).purged }
    : { lapsed: 0, aiIndexPurged: 0 };
  const aiInteractions = Date.now() - started < budgetMs ? await purgeExpiredAiInteractions({ now: opts.now }) : { textPurged: 0, deleted: 0 };
  const sharing = Date.now() - started < budgetMs
    ? {
      sharesExpired: (await sweepShareExpiry({ now: opts.now })).expired,
      requestsExpired: (await sweepAccessRequestExpiry({ now: opts.now })).expired,
      // 4c answers: yesterday's (India day) access summary to each person whose record was opened.
      accessSummaries: (await sweepAccessSummaries({ now: opts.now })).queued,
    }
    : { sharesExpired: 0, requestsExpired: 0, accessSummaries: 0 };

  return {
    consumers,
    events,
    workflows,
    mar,
    delegations,
    closures,
    documents,
    embeddings,
    consents,
    aiInteractions,
    sharing,
    durationMs: Date.now() - started,
    moreWork: events.claimed >= eventBatchSize || workflows.timersFired >= workflowBatchSize || workflows.instancesRun >= workflowBatchSize || mar.missed >= marBatchSize,
  };
}
