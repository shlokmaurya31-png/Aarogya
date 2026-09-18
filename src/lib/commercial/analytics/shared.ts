import type { BillingInvoiceStatus } from "@prisma/client";

/**
 * Phase D5 — shared, deterministic helpers for the commercial intelligence layer.
 *
 * Every financial number in D5 is server-derived from canonical D2/D3/D4 records
 * through these helpers — there is exactly ONE authoritative outstanding
 * calculation, currencies are never summed together, and analytics windows are
 * bounded so a client can never force an unbounded aggregation.
 */

/** Invoice states that still carry a collectible balance. */
export const OPEN_INVOICE_STATES: BillingInvoiceStatus[] = ["OPEN", "PARTIALLY_PAID", "PAST_DUE"];

/**
 * THE authoritative per-invoice outstanding balance. Credits are already baked
 * into `totalMinor` at draft time (D3), and `amountPaidMinor` is the guarded
 * running total of applied payments; refunds are tracked on the payment and do
 * not resurrect a settled invoice. A terminal invoice (DRAFT/PAID/VOID/
 * UNCOLLECTIBLE) is never outstanding. Never negative.
 */
export function invoiceOutstandingMinor(inv: { status: BillingInvoiceStatus; totalMinor: number; amountPaidMinor: number }): number {
  if (!OPEN_INVOICE_STATES.includes(inv.status)) return 0;
  return Math.max(0, inv.totalMinor - inv.amountPaidMinor);
}

/** Group minor-unit sums by currency — currencies are NEVER combined. */
export class CurrencyBuckets {
  private m = new Map<string, number>();
  add(currency: string, minor: number) { this.m.set(currency, (this.m.get(currency) ?? 0) + minor); }
  /** Ensure a currency appears even with a zero total (so the dimension is preserved). */
  ensure(currency: string) { if (!this.m.has(currency)) this.m.set(currency, 0); }
  toArray(): { currency: string; amountMinor: number }[] {
    return [...this.m.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor })).sort((a, b) => a.currency.localeCompare(b.currency));
  }
}

export interface ResolvedPeriod { from: Date; to: Date; days: number }

/**
 * Resolve a bounded UTC analytics window. Dates are treated as UTC day
 * boundaries; the window is [from, to). Defaults to the last 30 days; a client
 * can never exceed `maxDays` (default ~13 months) — an over-wide request is
 * clamped, not honoured, so no unbounded scan is possible.
 */
export function resolvePeriod(fromISO?: string | null, toISO?: string | null, opts?: { defaultDays?: number; maxDays?: number; now?: Date }): ResolvedPeriod {
  const now = opts?.now ?? new Date();
  const maxDays = opts?.maxDays ?? 400;
  const defaultDays = opts?.defaultDays ?? 30;
  const parse = (s?: string | null): Date | null => { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };
  let to = parse(toISO) ?? now;
  let from = parse(fromISO) ?? new Date(to.getTime() - defaultDays * 86_400_000);
  if (from > to) { const t = from; from = to; to = t; }
  const days = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
  if (days > maxDays) from = new Date(to.getTime() - maxDays * 86_400_000);
  return { from, to, days: Math.min(days, maxDays) };
}

/** Percentage with an explicit, safe denominator — never divides by zero. */
export function safeRate(numerator: number, denominator: number): { rate: number | null; numerator: number; denominator: number } {
  return { rate: denominator > 0 ? numerator / denominator : null, numerator, denominator };
}

/** Deterministic CSV. Values are stringified; commas/quotes/newlines are escaped. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
