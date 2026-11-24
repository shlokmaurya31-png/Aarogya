import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

/**
 * RAG Phase 5, step 3f — the daily token budget per facility, on top of the
 * daily request budget (docs/RAG_ARCHITECTURE.md §3.1 step 2).
 *
 *   the budget   `ai.daily_token_budget` (organisation or facility; the
 *                hospital administrator sets it through the configuration
 *                API, which drafts, publishes, audits and keeps the change
 *                ledger); model tokens, input and output, of every AI
 *                request of the facility over the last 24 hours, like the
 *                request budget's window
 *   at 80%       one alert per facility per 24 hours: the
 *                `AiTokenBudgetThresholdReached` event (level 80) and a
 *                notification to each of the facility's administrators, in
 *                one transaction
 *   at 100%      the same at level 100, and every model call is refused
 *                (429 FACILITY_TOKEN_BUDGET, with a message saying so). A
 *                Tier 0 answer from the structured records uses no model and
 *                is never blocked; neither is "no record" before the model.
 *
 * Counts and thresholds only: no question, answer or patient is in the event
 * or the notification.
 */
export const TOKEN_BUDGET_KEY = "ai.daily_token_budget";
export const DEFAULT_DAILY_TOKEN_BUDGET = 5_000_000;
export const ALERT_LEVELS = [80, 100] as const;
const WINDOW_MS = 86_400_000;

export const TOKEN_BUDGET_MESSAGE = "This facility has used its AI token budget for the last 24 hours. Answers that need an AI model are paused until usage falls below the budget; lookups answered straight from the records still work. A hospital administrator can change the budget.";

export async function facilityTokenBudget(facilityId: string): Promise<{ organizationId: string; budget: number } | null> {
  const fac = await prisma.facility.findUnique({ where: { id: facilityId }, select: { organizationId: true } });
  if (!fac) return null;
  const eff = await resolveEffectiveInternal({ key: TOKEN_BUDGET_KEY, organizationId: fac.organizationId, facilityId, fallbackRaw: String(DEFAULT_DAILY_TOKEN_BUDGET) });
  return { organizationId: fac.organizationId, budget: typeof eff.value === "number" ? eff.value : DEFAULT_DAILY_TOKEN_BUDGET };
}

/** Model tokens (input + output) the facility's AI requests used in the last 24 hours. */
export async function facilityTokensUsed(facilityId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<number> {
  const [r] = await db.$queryRaw<{ used: bigint | null }[]>(Prisma.sql`
    SELECT coalesce(sum(i."inputTokens" + i."outputTokens"), 0)::bigint AS used FROM "AiInteraction" i
    WHERE i."facilityId" = ${facilityId} AND i."createdAt" >= ${new Date(Date.now() - WINDOW_MS)}`);
  return Number(r?.used ?? 0);
}

export class TokenBudgetExceededError extends Error {
  constructor() {
    super(TOKEN_BUDGET_MESSAGE);
    this.name = "TokenBudgetExceededError";
  }
}

/** Before a model call: refused when the facility has used its whole budget. A staff request only (a patient's has no facility budget). */
export async function assertTokenBudget(facilityId: string | null | undefined): Promise<void> {
  if (!facilityId) return;
  const b = await facilityTokenBudget(facilityId);
  if (!b) return;
  if ((await facilityTokensUsed(facilityId)) >= b.budget) throw new TokenBudgetExceededError();
}

/**
 * After a request's tokens are logged: the alert at 80% and at 100%, each at
 * most once per facility per 24 hours. A transaction-scoped advisory lock on
 * the facility makes two requests crossing the line together raise one alert.
 */
export async function checkTokenBudgetAlerts(facilityId: string | null | undefined): Promise<number | null> {
  if (!facilityId) return null;
  const b = await facilityTokenBudget(facilityId);
  if (!b || b.budget <= 0) return null;
  const used = await facilityTokensUsed(facilityId);
  const level = [...ALERT_LEVELS].reverse().find((l) => used * 100 >= b.budget * l);
  if (!level) return null;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-token-budget:${facilityId}`}))`;
    const since = new Date(Date.now() - WINDOW_MS);
    const raised = await tx.domainEventOutbox.findFirst({
      where: { eventType: "AiTokenBudgetThresholdReached", facilityId, occurredAt: { gte: since }, payload: { path: ["level"], equals: level } },
      select: { id: true },
    });
    if (raised) return null;
    await emitFacilityEvent(tx, {
      type: "AiTokenBudgetThresholdReached", aggregateType: "FACILITY", aggregateId: facilityId, facilityId,
      payload: { level, budget: b.budget, used, windowHours: 24 },
    });
    const admins = await tx.hospitalStaffProfile.findMany({
      where: { status: "ACTIVE", user: { facilityMemberships: { some: { facilityId, isAdmin: true, status: "ACTIVE" } } } },
      select: { id: true },
    });
    if (admins.length) {
      await tx.notification.createMany({
        data: admins.map((a) => ({
          facilityId, recipientStaffId: a.id, type: "AI_TOKEN_BUDGET", category: "ADMINISTRATIVE", priority: level >= 100 ? "URGENT" as const : "ROUTINE" as const,
          title: level >= 100 ? "AI token budget used up" : `AI token budget ${level}% used`,
          body: level >= 100
            ? `This facility has used its ${b.budget.toLocaleString("en-IN")} AI tokens for the last 24 hours. Answers that need a model are paused; record lookups still work.`
            : `This facility has used ${used.toLocaleString("en-IN")} of its ${b.budget.toLocaleString("en-IN")} AI tokens for the last 24 hours. At 100% answers that need a model are paused.`,
          linkHref: "/hospital-os/ai-usage", sourceType: "AI_TOKEN_BUDGET", sourceId: facilityId,
        })),
      });
    }
    return level;
  });
}
