/**
 * Single money representation for the entire Phase 5 financial subsystem:
 * every amount is an integer minor unit (paise for INR — 1 rupee = 100
 * paise). Never a Float. Every arithmetic helper here rounds exactly once,
 * at the boundary where a fractional value (a percentage, a rate) meets an
 * integer minor-unit amount — never earlier, never twice.
 */

export const DEFAULT_CURRENCY = "INR";

export function rupeesToMinor(rupees: number): number {
  return Math.round(rupees * 100);
}

export function minorToRupees(minor: number): number {
  return minor / 100;
}

export function formatMinor(minor: number, currency: string = DEFAULT_CURRENCY): string {
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${minorToRupees(minor).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Round-half-up on integer paise — the one rounding policy used everywhere in this subsystem. */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

export function applyPercentDiscount(amountMinor: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new Error("percent must be between 0 and 100.");
  return roundHalfUp((amountMinor * percent) / 100);
}

/** quantity is a Float (e.g. 1.5 days, 2 units) — the only place fractional quantity meets integer money. */
export function computeLineGrossAmountMinor(quantity: number, unitPriceMinor: number): number {
  return roundHalfUp(quantity * unitPriceMinor);
}

export function computeLineNetAmountMinor(quantity: number, unitPriceMinor: number, discountMinor: number): number {
  const gross = computeLineGrossAmountMinor(quantity, unitPriceMinor);
  if (discountMinor > gross) throw new Error("discountMinor cannot exceed the gross line amount.");
  if (discountMinor < 0) throw new Error("discountMinor cannot be negative.");
  return gross - discountMinor;
}

export function sumMinor(amounts: number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}

/** Any partial day counts as a full day — the one bounded accommodation-billing policy used at discharge (see admission.ts#finalizeDischarge). Minimum 1 day even for a same-day admission/discharge. */
export function ceilStayDays(admittedAt: Date, dischargedAt: Date): number {
  return Math.max(1, Math.ceil((dischargedAt.getTime() - admittedAt.getTime()) / 86_400_000));
}
