import type { Prisma } from "@prisma/client";
import { assertNoSensitiveData } from "@/lib/events/sensitiveGuard";

type Tx = Prisma.TransactionClient;

/**
 * Phase D7 — durable timer storage helpers (§14).
 *
 * Timers live in the database (WorkflowTimer) and are fired by a bounded, guarded
 * claim in the engine's tick — no continuously-running process is required for
 * correctness. This module only creates/cancels timer rows; the firing logic lives
 * in engine.ts (which also resumes the instance), to keep the dependency acyclic.
 */

export interface CreateTimerInput {
  workflowInstanceId: string;
  workflowStepId?: string | null;
  kind: "DELAY" | "SLA";
  availableAt: Date;
  payload?: Prisma.InputJsonValue;
  idempotencyKey: string;
}

/** Idempotently create a timer within a transaction. */
export async function createTimerTx(tx: Tx, input: CreateTimerInput) {
  if (input.payload !== undefined) assertNoSensitiveData(input.payload);
  try {
    return await tx.workflowTimer.create({
      data: {
        workflowInstanceId: input.workflowInstanceId, workflowStepId: input.workflowStepId ?? null,
        kind: input.kind, availableAt: input.availableAt, status: "PENDING", payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    return tx.workflowTimer.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
  }
}

/** Cancel all still-pending timers for an instance (used on cancellation). */
export async function cancelInstanceTimersTx(tx: Tx, workflowInstanceId: string) {
  await tx.workflowTimer.updateMany({
    where: { workflowInstanceId, status: { in: ["PENDING", "CLAIMED"] } },
    data: { status: "CANCELLED" },
  });
}
