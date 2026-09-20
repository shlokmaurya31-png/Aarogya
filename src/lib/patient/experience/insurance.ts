import { prisma } from "@/lib/db";
import { patientLanguage as L } from "./language";
import { assertClass, type PatientAccessScope } from "../context";

/**
 * Phase D11 — patient-facing insurance (brief §25). Projects the canonical
 * PatientCoverage / Payer / PayerPlan / PreAuthorization / Claim models into a
 * patient-safe view. We never expose internal insurer credentials, payer system
 * fields, or fabricate an approval — statuses are the canonical values (set by
 * staff off a real payer decision), translated to patient language. Member IDs
 * are masked to the last 4 characters even for the owner.
 */

function maskMemberId(v: string): string {
  if (v.length <= 4) return "••••";
  return "•".repeat(Math.max(0, v.length - 4)) + v.slice(-4);
}

export interface CoverageDTO {
  id: string;
  payer: string;
  plan: string | null;
  memberIdMasked: string;
  statusLabel: string;
  validFrom: string;
  validTo: string | null;
  isPrimary: boolean;
  preAuths: { statusLabel: string; requestedAt: string; decidedAt: string | null }[];
}

export interface ClaimDTO {
  claimNumber: string | null;
  statusLabel: string;
  submittedAt: string | null;
  decidedAt: string | null;
}

export async function listInsurance(scope: PatientAccessScope): Promise<{ coverages: CoverageDTO[]; claims: ClaimDTO[] }> {
  assertClass(scope, "INSURANCE");
  const [coverages, claims] = await Promise.all([
    prisma.patientCoverage.findMany({
      where: { patientId: { in: scope.patientIds } },
      orderBy: { priorityOrder: "asc" },
      include: {
        payer: { select: { name: true } },
        plan: { select: { name: true } },
        preAuths: { orderBy: { requestedAt: "desc" }, take: 20 },
      },
    }),
    prisma.claim.findMany({
      where: { coverage: { patientId: { in: scope.patientIds } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return {
    coverages: coverages.map((c) => ({
      id: c.id,
      payer: c.payer.name,
      plan: c.plan?.name ?? null,
      memberIdMasked: maskMemberId(c.memberId),
      statusLabel: L.coverageStatus(c.status),
      validFrom: c.validFrom.toISOString(),
      validTo: c.validTo?.toISOString() ?? null,
      isPrimary: c.priorityOrder === 1,
      preAuths: c.preAuths.map((p) => ({
        statusLabel: L.preAuthStatus(p.status),
        requestedAt: p.requestedAt.toISOString(),
        decidedAt: p.decidedAt?.toISOString() ?? null,
      })),
    })),
    claims: claims.map((c) => ({
      claimNumber: c.claimNumber,
      statusLabel: L.claimStatus(c.status),
      submittedAt: c.submittedAt?.toISOString() ?? null,
      decidedAt: c.decidedAt?.toISOString() ?? null,
    })),
  };
}
