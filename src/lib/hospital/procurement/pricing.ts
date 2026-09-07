import { roundHalfUp, sumMinor } from "@/lib/hospital/billing/money";

export interface PoLineInput {
  orderedQuantity: number;
  unitPriceMinor: number;
  taxPercent?: number;
}

/** Server-computed line total — never trusted from the client. Reuses billing/money.ts's rounding policy, never reimplemented. */
export function computeLineTotal(line: PoLineInput): number {
  const gross = roundHalfUp(line.orderedQuantity * line.unitPriceMinor);
  const tax = roundHalfUp((gross * (line.taxPercent ?? 0)) / 100);
  return gross + tax;
}

export function computePurchaseOrderTotals(lines: PoLineInput[]): { subtotalMinor: number; taxMinor: number; totalMinor: number } {
  const subtotalMinor = sumMinor(lines.map((l) => roundHalfUp(l.orderedQuantity * l.unitPriceMinor)));
  const totalMinor = sumMinor(lines.map(computeLineTotal));
  return { subtotalMinor, taxMinor: totalMinor - subtotalMinor, totalMinor };
}
