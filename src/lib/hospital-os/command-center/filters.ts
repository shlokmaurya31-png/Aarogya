import { BadRequestError } from "@/lib/auth/rbac";

/**
 * Phase D10 — bounded time windows. Every metric documents whether it is point-in-time,
 * current-state, rolling, or a period aggregate. Unbounded historical queries are
 * refused (§6/§30): custom ranges are capped, and from must precede to.
 */

export interface TimeWindow {
  key: string;
  from: Date;
  to: Date;
  label: string;
}

const MAX_RANGE_DAYS = 400;
const day = 86_400_000;

export function resolveWindow(key?: string | null, fromISO?: string | null, toISO?: string | null, now = new Date()): TimeWindow {
  const to = new Date(now);
  switch (key) {
    case "today": {
      const from = new Date(now); from.setHours(0, 0, 0, 0);
      return { key: "today", from, to, label: "Today" };
    }
    case "7d": return { key: "7d", from: new Date(now.getTime() - 7 * day), to, label: "Last 7 days" };
    case "30d": return { key: "30d", from: new Date(now.getTime() - 30 * day), to, label: "Last 30 days" };
    case "custom": {
      if (!fromISO || !toISO) throw new BadRequestError("custom window requires from and to.");
      const from = new Date(fromISO); const t = new Date(toISO);
      if (Number.isNaN(from.getTime()) || Number.isNaN(t.getTime())) throw new BadRequestError("Invalid custom date range.");
      if (from >= t) throw new BadRequestError("from must be before to.");
      if ((t.getTime() - from.getTime()) / day > MAX_RANGE_DAYS) throw new BadRequestError(`Range exceeds ${MAX_RANGE_DAYS} days.`);
      return { key: "custom", from, to: t, label: "Custom range" };
    }
    case "24h":
    default:
      return { key: "24h", from: new Date(now.getTime() - day), to, label: "Last 24 hours" };
  }
}

export function startOfToday(now = new Date()): Date {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d;
}
