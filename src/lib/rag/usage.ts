import { Prisma, type Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ForbiddenError, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { loadActorMemberships } from "@/lib/auth/tenantContext";
import { DEFAULT_PRICES } from "./prices";

/**
 * RAG Phase 4, step 4.5 — the AI usage report (docs/RAG_ARCHITECTURE.md §11.5):
 * GET /api/ai/usage. Totals and groups over AiInteraction rows (metadata only:
 * no question, answer, patient, person or source ever leaves here).
 *
 *   an organisation's administrator  the organisation, or one of its
 *                                    facilities; by facility, role, module,
 *                                    model or request type (the mode)
 *   a facility's administrator        their facility; the same groups, and by
 *                                    user — per-user figures are for the
 *                                    administrator of that facility only, so
 *                                    an organisation administrator who isn't
 *                                    also that facility's sees none
 *   anyone else                       403; an organisation or facility the
 *                                    caller has no standing in, 404
 *
 * Every group's rows add up to the totals: each row is the same SQL sum over
 * the same filter, split by one column.
 */
export const USAGE_GROUPS = ["facility", "role", "module", "model", "requestType", "user"] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

export interface UsageFigures {
  requests: number; answered: number; tier0: number; inputTokens: number; outputTokens: number; embeddingTokens: number;
  rerankUnits: number; cacheHits: number; estimatedCostMicroUsd: number; medianRetrievalMs: number | null; medianGenerationMs: number | null;
}
export interface UsageReport {
  organizationId: string; facilityId: string | null; from: string; to: string; groupBy: UsageGroup;
  prices: { asOf: string; confirmed: boolean; status: string | null };
  totals: UsageFigures;
  rows: (UsageFigures & { key: string; label: string })[];
}

const COLUMN: Record<UsageGroup, Prisma.Sql> = {
  facility: Prisma.sql`i."facilityId"`, role: Prisma.sql`i."role"`, module: Prisma.sql`i."module"`, model: Prisma.sql`i."model"`,
  requestType: Prisma.sql`i."mode"`, user: Prisma.sql`i."userId"`,
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function figures(r: Record<string, unknown>): UsageFigures {
  const n = (k: string) => Number(r[k] ?? 0);
  const m = (k: string) => (r[k] == null ? null : Math.round(Number(r[k])));
  return {
    requests: n("requests"), answered: n("answered"), tier0: n("tier0"), inputTokens: n("inputTokens"), outputTokens: n("outputTokens"),
    embeddingTokens: n("embeddingTokens"), rerankUnits: n("rerankUnits"), cacheHits: n("cacheHits"), estimatedCostMicroUsd: n("cost"),
    medianRetrievalMs: m("retrievalMs"), medianGenerationMs: m("generationMs"),
  };
}

const SUMS = Prisma.sql`count(*)::int AS "requests", count(*) FILTER (WHERE i."outcome" = 'ANSWERED')::int AS "answered", count(*) FILTER (WHERE i."tier" = 0)::int AS "tier0",
  coalesce(sum(i."inputTokens"), 0)::bigint AS "inputTokens", coalesce(sum(i."outputTokens"), 0)::bigint AS "outputTokens", coalesce(sum(i."embeddingTokens"), 0)::bigint AS "embeddingTokens",
  coalesce(sum(i."rerankUnits"), 0)::bigint AS "rerankUnits", coalesce(sum(i."cacheHits"), 0)::bigint AS "cacheHits", coalesce(sum(i."estimatedCostMicroUsd"), 0)::bigint AS "cost",
  percentile_cont(0.5) WITHIN GROUP (ORDER BY i."retrievalMs") AS "retrievalMs", percentile_cont(0.5) WITHIN GROUP (ORDER BY i."generationMs") AS "generationMs"`;

export async function aiUsageReport(caller: { userId: string; role: Role }, q: { organizationId?: string | null; facilityId?: string | null; from?: string | null; to?: string | null; groupBy?: string | null }): Promise<UsageReport> {
  const groupBy = (q.groupBy ?? "facility") as UsageGroup;
  if (!USAGE_GROUPS.includes(groupBy)) throw new BadRequestError("groupBy must be one of facility, role, module, model, requestType, user.");
  const m = await loadActorMemberships(caller.userId, caller.role);
  const adminFacilities = [...m.facilityMemberships].filter(([, f]) => f.isAdmin);
  if (!m.adminOrgIds.size && !adminFacilities.length) throw new ForbiddenError("ai:usage:read");

  // The scope: an organisation the caller administers, or a facility they administer (or whose organisation they do).
  let organizationId: string;
  let facilityId: string | null = null;
  if (q.facilityId) {
    const fac = await prisma.facility.findUnique({ where: { id: q.facilityId }, select: { id: true, organizationId: true } });
    const facAdmin = !!fac && !!m.facilityMemberships.get(fac.id)?.isAdmin;
    if (!fac || (!facAdmin && !m.adminOrgIds.has(fac.organizationId)) || (q.organizationId && q.organizationId !== fac.organizationId)) throw new NotFoundError();
    organizationId = fac.organizationId;
    facilityId = fac.id;
  } else if (q.organizationId) {
    if (!m.adminOrgIds.has(q.organizationId)) throw new NotFoundError();
    organizationId = q.organizationId;
  } else if (m.adminOrgIds.size) {
    organizationId = [...m.adminOrgIds].sort()[0];
  } else {
    const [fid, f] = adminFacilities.sort(([a], [b]) => a.localeCompare(b))[0];
    organizationId = f.organizationId;
    facilityId = fid;
  }
  if (!facilityId && !m.adminOrgIds.has(organizationId)) throw new NotFoundError();
  // Per user: the administrator of that facility only.
  if (groupBy === "user" && !(facilityId && m.facilityMemberships.get(facilityId)?.isAdmin)) throw new ForbiddenError("ai:usage:read");

  if ((q.from && !DAY.test(q.from)) || (q.to && !DAY.test(q.to))) throw new BadRequestError("from and to are days (YYYY-MM-DD).");
  const to = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date(Date.now() + 86_400_000);
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 31 * 86_400_000);
  if (!(from < to) || to.getTime() - from.getTime() > 400 * 86_400_000) throw new BadRequestError("The period is at most 400 days, from before to.");

  const where = Prisma.sql`i."organizationId" = ${organizationId} ${facilityId ? Prisma.sql`AND i."facilityId" = ${facilityId}` : Prisma.empty} AND i."createdAt" >= ${from} AND i."createdAt" < ${to}`;
  const [total] = await prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${SUMS} FROM "AiInteraction" i WHERE ${where}`);
  const grouped = await prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${COLUMN[groupBy]} AS "key", ${SUMS} FROM "AiInteraction" i WHERE ${where} GROUP BY 1 ORDER BY "cost" DESC, 1 LIMIT 500`);

  // Labels: facility names and user display names, never anything about a patient.
  const keys = grouped.map((g) => (g.key == null ? "" : String(g.key)));
  const labels = new Map<string, string>();
  if (groupBy === "facility") for (const f of await prisma.facility.findMany({ where: { id: { in: keys } }, select: { id: true, name: true } })) labels.set(f.id, f.name);
  if (groupBy === "user") for (const u of await prisma.user.findMany({ where: { id: { in: keys } }, select: { id: true, displayName: true } })) labels.set(u.id, u.displayName ?? "Staff member");
  return {
    organizationId, facilityId, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), groupBy,
    prices: { asOf: DEFAULT_PRICES.asOf, confirmed: DEFAULT_PRICES.confirmed, status: DEFAULT_PRICES.status ?? null },
    totals: figures(total ?? {}),
    rows: grouped.map((g, i) => ({ key: keys[i] || "(none)", label: labels.get(keys[i]) ?? (keys[i] || "(none)"), ...figures(g) })),
  };
}
