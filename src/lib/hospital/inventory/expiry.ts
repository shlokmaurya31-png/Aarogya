import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type Db = Prisma.TransactionClient | typeof prisma;

export function isExpired(expiresAt: Date | null, at: Date = new Date()): boolean {
  return expiresAt !== null && expiresAt.getTime() <= at.getTime();
}

export function isExpiringSoon(expiresAt: Date | null, windowDays = 30, at: Date = new Date()): boolean {
  if (expiresAt === null) return false;
  const windowMs = windowDays * 86_400_000;
  return expiresAt.getTime() > at.getTime() && expiresAt.getTime() <= at.getTime() + windowMs;
}

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

export function clampPageSize(requested: number | undefined): number {
  if (!requested || requested <= 0) return PAGE_SIZE_DEFAULT;
  return Math.min(requested, PAGE_SIZE_MAX);
}

/** Server-side paginated "expiring soon" worklist — never an unbounded findMany against the whole lot table. */
export async function listExpiringSoonLots(db: Db, facilityId: string, opts: { windowDays?: number; cursor?: string; take?: number } = {}) {
  const windowDays = opts.windowDays ?? 30;
  const take = clampPageSize(opts.take);
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowDays * 86_400_000);

  return db.itemLot.findMany({
    where: { facilityId, status: "ACTIVE", expiresAt: { gt: now, lte: windowEnd } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    include: { item: true },
  });
}

export async function listExpiredLots(db: Db, facilityId: string, opts: { cursor?: string; take?: number } = {}) {
  const take = clampPageSize(opts.take);
  return db.itemLot.findMany({
    where: { facilityId, status: "EXPIRED" },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    include: { item: true },
  });
}

export async function listQuarantinedLots(db: Db, facilityId: string, opts: { cursor?: string; take?: number } = {}) {
  const take = clampPageSize(opts.take);
  return db.itemLot.findMany({
    where: { facilityId, status: "QUARANTINED" },
    orderBy: [{ quarantinedAt: "desc" }, { id: "asc" }],
    take,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    include: { item: true },
  });
}
