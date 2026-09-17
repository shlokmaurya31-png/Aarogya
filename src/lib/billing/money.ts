/**
 * Phase D3 — money representation for the SaaS billing domain.
 *
 * Every amount is an integer minor unit (paise for INR — 1 rupee = 100 paise),
 * NEVER a Float. This is the SAME discipline as the hospital revenue cycle's
 * money.ts, but a deliberately separate module so the two financial domains stay
 * decoupled (see docs/enterprise/saas-billing.md). Rounding happens exactly once,
 * at the boundary where a rate/percentage meets an integer amount.
 */

export const DEFAULT_BILLING_CURRENCY = "INR";

/** Round-half-up on integer minor units — the one rounding policy used here. */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** Basis points (1800 = 18%) applied to a minor-unit amount, rounded once. */
export function applyRateBps(amountMinor: number, rateBps: number): number {
  if (rateBps < 0) throw new Error("rateBps cannot be negative.");
  return roundHalfUp((amountMinor * rateBps) / 10_000);
}

export function sumMinor(amounts: number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}

export function rupeesToMinor(rupees: number): number {
  return Math.round(rupees * 100);
}

export function minorToRupees(minor: number): number {
  return minor / 100;
}

export function formatMinor(minor: number, currency: string = DEFAULT_BILLING_CURRENCY): string {
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${minorToRupees(minor).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
