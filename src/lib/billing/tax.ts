/**
 * Phase D3 — tax calculation BOUNDARY (foundation only).
 *
 * This is deliberately NOT an Indian tax engine. It establishes the seam: a
 * taxCode maps to a rate in basis points, and tax is computed once on a
 * minor-unit taxable amount. The default rate table is empty except for the
 * codes the pricing registry actually uses, and an unknown code resolves to 0
 * rather than guessing — so D3 makes NO unsupported compliance claim. Real GST
 * logic (place-of-supply, CGST/SGST/IGST split, HSN/SAC, filing) is explicitly
 * out of scope and documented as deferred. See docs/enterprise/invoicing.md.
 */

import { applyRateBps } from "./money";

/** taxCode -> rate in basis points. 1800 = 18%. Extend only with authority. */
const TAX_RATE_BPS: Record<string, number> = {
  GST_18: 1800,
};

export function resolveTaxRateBps(taxCode: string | null | undefined): number {
  if (!taxCode) return 0;
  return TAX_RATE_BPS[taxCode] ?? 0;
}

/** Compute the tax on a taxable minor-unit amount for a given code. Rounds once. */
export function computeTaxMinor(taxableMinor: number, taxCode: string | null | undefined): { taxAmountMinor: number; rateBps: number } {
  const rateBps = resolveTaxRateBps(taxCode);
  return { taxAmountMinor: applyRateBps(taxableMinor, rateBps), rateBps };
}
