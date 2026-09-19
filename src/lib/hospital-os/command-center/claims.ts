import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import type { CommandSection } from "./types";

/**
 * CLAIMS — local claim lifecycle state (Claim). Reports the ACTUAL local exchange state;
 * it does not claim external payer/NHCX connectivity. Financial section — requires
 * `billing:view`. Exceptions (rejected/partially-approved) are D8-configurable.
 */
export async function getClaims(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const [pending, submitted, approved, denied, partial, settled, settlementPending, oldestSubmitted] = await Promise.all([
    prisma.claim.count({ where: { facilityId: f, status: { in: ["DRAFT", "SUBMITTED", "UNDER_REVIEW"] } } }),
    prisma.claim.count({ where: { facilityId: f, status: "SUBMITTED" } }),
    prisma.claim.count({ where: { facilityId: f, status: "APPROVED" } }),
    prisma.claim.count({ where: { facilityId: f, status: "REJECTED" } }),
    prisma.claim.count({ where: { facilityId: f, status: "PARTIALLY_APPROVED" } }),
    prisma.claim.count({ where: { facilityId: f, status: "SETTLED" } }),
    prisma.claim.count({ where: { facilityId: f, status: { in: ["APPROVED", "PARTIALLY_APPROVED"] }, settledAt: null } }),
    prisma.claim.findFirst({ where: { facilityId: f, status: { in: ["SUBMITTED", "UNDER_REVIEW"] }, submittedAt: { not: null } }, orderBy: { submittedAt: "asc" }, select: { submittedAt: true } }),
  ]);
  const exceptions = denied + partial;
  const agingDays = oldestSubmitted?.submittedAt ? Math.round((ctx.now.getTime() - oldestSubmitted.submittedAt.getTime()) / 86_400_000) : 0;

  const metrics = [
    metric({ key: "claimsExceptions", label: "Claim exceptions (denied / partial)", value: exceptions, unit: "claims", timeSemantics: "CURRENT_STATE", threshold: ctx.thresholds.claimsExceptions, source: "Claim" }),
    metric({ key: "claimsPending", label: "Claims pending", value: pending, unit: "claims", timeSemantics: "CURRENT_STATE", source: "Claim" }),
    metric({ key: "claimsSettlementPending", label: "Settlement pending", value: settlementPending, unit: "claims", timeSemantics: "CURRENT_STATE", source: "Claim" }),
    metric({ key: "claimsAging", label: "Oldest submitted-undecided", value: agingDays, unit: "days", timeSemantics: "CURRENT_STATE", source: "Claim" }),
  ];
  const drivers = [
    driver("Denied", denied, "DIRECT", "/api/hospital/command-center/drilldown?kind=claims-denied"),
    driver("Partially approved", partial, "DIRECT"),
    driver("Settlement pending", settlementPending, "CONTRIBUTING"),
    driver("Submitted awaiting decision", submitted, "CONTRIBUTING"),
    driver("Approved", approved, "CONTRIBUTING"),
    driver("Settled", settled, "CONTRIBUTING"),
  ];
  return section(ctx, { key: "claims", label: "Claims", metrics, drivers, drillDown: "/api/hospital/command-center/drilldown?kind=claims-denied" });
}
