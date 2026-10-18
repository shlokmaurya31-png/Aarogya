import { dispatchPendingDomainEvents, type DispatchResult } from "@/lib/events/dispatcher";
import { tickWorkflows, type TickResult } from "@/lib/workflows/engine";
import { sweepMedicationSchedule, type SweepResult } from "@/lib/hospital/marSweep";
import { sweepDelegationExpiry } from "@/lib/patient/experience/delegationSweep";
import { purgeClosedPersons } from "@/lib/person/closure";
import { registerAllConsumers } from "./consumers";

/**
 * Workflow spine §3.1 — one bounded unit of background work, used by the local
 * worker (`npm run worker`) and by POST /api/cron/tick:
 *   1. dispatch pending domain events (claims with FOR UPDATE SKIP LOCKED,
 *      per-aggregate order by seq; reaps abandoned claims first);
 *   2. fire due workflow timers and run runnable workflow instances;
 *   3. sweep the MAR: DUE doses past their grace become MISSED (§3.4);
 *   4. expire family delegations past their expiresAt (§3.4).
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

  return {
    consumers,
    events,
    workflows,
    mar,
    delegations,
    closures,
    durationMs: Date.now() - started,
    moreWork: events.claimed >= eventBatchSize || workflows.timersFired >= workflowBatchSize || workflows.instancesRun >= workflowBatchSize || mar.missed >= marBatchSize,
  };
}
