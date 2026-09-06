import { prisma } from "@/lib/db";
import { computeAccountSummary } from "./billingAccount";
import { isPreAuthStale } from "./preauth";

export type FinancialClearanceStatus = "NOT_REQUIRED" | "PENDING" | "CLEARED";

export interface FinancialClearance {
  status: FinancialClearanceStatus;
  reasons: string[];
  outstandingMinor: number;
}

/** Pure classification — extracted so it's unit-testable against a fabricated reasons list, decoupled from the DB queries that build it. */
export function classifyClearance(reasons: string[]): FinancialClearanceStatus {
  return reasons.length === 0 ? "CLEARED" : "PENDING";
}

/**
 * Informational only — mirrors dischargeBarrierEngine.ts's live-computed,
 * non-stored pattern exactly. Does NOT gate finalizeDischarge; the only
 * flags that actually block discharge remain Discharge.billingReady/
 * insuranceReady, unchanged, manually toggled exactly as before this
 * phase. Clinical discharge and financial clearance stay fully decoupled
 * this phase, per explicit instruction. Only 3 states (not the brief's
 * example HOLD) — nothing in this design produces a distinct "held"
 * state beyond "pending," so a 4th enum value would be dead vocabulary;
 * documented here rather than added speculatively.
 */
export async function computeFinancialClearance(encounterId: string, atDate: Date = new Date()): Promise<FinancialClearance> {
  const account = await prisma.billingAccount.findUnique({ where: { encounterId } });
  if (!account) return { status: "NOT_REQUIRED", reasons: [], outstandingMinor: 0 };

  const reasons: string[] = [];
  const summary = await computeAccountSummary(encounterId);
  if (summary.outstandingMinor > 0) reasons.push(`Outstanding balance of ${summary.outstandingMinor} paise across issued invoices.`);

  const [pendingRefunds, openClaims, preAuths] = await Promise.all([
    prisma.refund.findMany({ where: { status: { in: ["REQUESTED", "APPROVED"] }, payment: { billingAccountId: account.id } } }),
    prisma.claim.findMany({ where: { invoice: { billingAccountId: account.id }, status: { notIn: ["SETTLED", "CLOSED", "REJECTED"] } } }),
    prisma.preAuthorization.findMany({ where: { encounterId } }),
  ]);

  if (pendingRefunds.length > 0) reasons.push(`${pendingRefunds.length} refund(s) requested but not yet completed.`);
  if (openClaims.length > 0) reasons.push(`${openClaims.length} claim(s) still in progress with the payer.`);

  const stalePreAuths = preAuths.filter((p) => isPreAuthStale(p, atDate));
  if (stalePreAuths.length > 0) reasons.push(`${stalePreAuths.length} pre-authorization request(s) pending a payer decision for over a week.`);

  return { status: classifyClearance(reasons), reasons, outstandingMinor: summary.outstandingMinor };
}
