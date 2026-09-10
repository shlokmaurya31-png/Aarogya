import { prisma } from "@/lib/db";

/**
 * Quality / Patient-Safety Command Center (Phase B10) — every count is a live,
 * facility-scoped, indexed DB query. Aging/overdue is derived from timestamps
 * vs the record's own dueAt (no background scheduler, no fabricated metrics).
 */
export async function getQualityCommandCenter(facilityId: string) {
  const now = new Date();
  const [
    incReported, incTriaged, incInvestigation, incActionRequired, incResolved, incCritical, incOverdue,
    capaOpen, capaInProgress, capaOverdue, capaAwaitingVerification,
    rcaOpen, findingsOpen, standardsReviewDue, auditsPlanned, auditsInProgress,
  ] = await Promise.all([
    prisma.qualityIncident.count({ where: { facilityId, status: "REPORTED" } }),
    prisma.qualityIncident.count({ where: { facilityId, status: "TRIAGED" } }),
    prisma.qualityIncident.count({ where: { facilityId, status: "UNDER_INVESTIGATION" } }),
    prisma.qualityIncident.count({ where: { facilityId, status: "ACTION_REQUIRED" } }),
    prisma.qualityIncident.count({ where: { facilityId, status: "RESOLVED" } }),
    prisma.qualityIncident.count({ where: { facilityId, severity: "CRITICAL", status: { notIn: ["CLOSED", "CANCELLED"] } } }),
    prisma.qualityIncident.count({ where: { facilityId, status: { notIn: ["CLOSED", "CANCELLED"] }, dueAt: { not: null, lte: now } } }),
    prisma.capaAction.count({ where: { facilityId, status: "OPEN" } }),
    prisma.capaAction.count({ where: { facilityId, status: "IN_PROGRESS" } }),
    prisma.capaAction.count({ where: { facilityId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { not: null, lte: now } } }),
    prisma.capaAction.count({ where: { facilityId, status: "COMPLETED" } }),
    prisma.rootCauseAnalysis.count({ where: { facilityId, status: { in: ["DRAFT", "UNDER_REVIEW"] } } }),
    prisma.qualityFinding.count({ where: { facilityId, status: { in: ["OPEN", "IN_PROGRESS"] } } }),
    prisma.qualityStandard.count({ where: { facilityId, status: "ACTIVE", reviewDueAt: { not: null, lte: now } } }),
    prisma.qualityAudit.count({ where: { facilityId, status: "PLANNED" } }),
    prisma.qualityAudit.count({ where: { facilityId, status: "IN_PROGRESS" } }),
  ]);

  return {
    incidents: { reported: incReported, triaged: incTriaged, investigation: incInvestigation, actionRequired: incActionRequired, resolved: incResolved, critical: incCritical, overdue: incOverdue },
    capa: { open: capaOpen, inProgress: capaInProgress, overdue: capaOverdue, awaitingVerification: capaAwaitingVerification },
    rca: { open: rcaOpen },
    findings: { open: findingsOpen },
    compliance: { standardsReviewDue },
    audits: { planned: auditsPlanned, inProgress: auditsInProgress },
  };
}
