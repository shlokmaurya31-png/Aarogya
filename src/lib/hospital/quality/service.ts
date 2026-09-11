import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import {
  INCIDENT_TRANSITIONS, CAPA_TRANSITIONS, AUDIT_TRANSITIONS, INCIDENT_SEVERITIES, INCIDENT_CATEGORIES,
  isTransitionAllowed, assertQualityStaffInFacility, assertPatientInFacility, assertEncounterInFacility,
  assertQualityRefsInFacility,
} from "@/lib/hospital/quality/shared";

/**
 * Phase B10 Quality / Patient-Safety service — incident reporting, lifecycle,
 * RCA, CAPA, evidence, compliance framework, internal audits. Reuses canonical
 * Patient/Encounter/Department/Staff/ClinicalDocument/AuditEvent. Every lifecycle
 * uses a guarded status-preconditioned updateMany (single-winner); closed/
 * terminal records are protected from ordinary mutation. NO clinical scoring,
 * NO certification logic — severity/category/methodology are documentary.
 */

export class QualityConcurrencyError extends BadRequestError {
  constructor(message = "This record changed state concurrently. Refresh and try again.") { super(message); }
}

/**
 * Translate ONLY a unique-constraint violation into the caller-facing duplicate
 * message. A blanket `.catch(() => throw BadRequestError(...))` reported an
 * unrelated failure — a foreign-key violation, a dropped connection, a bug — as
 * "already exists", which both misleads the user and hides real faults from the
 * 500 path and the server log (gate §46).
 */
function asDuplicateError(message: string) {
  return (e: unknown): never => {
    const code = (e as { code?: unknown })?.code;
    if (code === "P2002" || (e instanceof Error && /unique/i.test(e.message))) throw new BadRequestError(message);
    throw e;
  };
}

// ══ INCIDENTS ════════════════════════════════════════════════════════════════
export async function createQualityIncident(input: {
  facilityId: string; category: string; severity?: string; title: string; description: string;
  patientId?: string; encounterId?: string; departmentId?: string; immediateAction?: string;
  occurrenceAt?: Date; dueAt?: Date; confidentiality?: string; reportedByStaffId: string;
  relatedEntityType?: string; relatedEntityId?: string; infectionIncidentId?: string; source?: string; byUserId: string;
}) {
  if (!INCIDENT_CATEGORIES.includes(input.category as (typeof INCIDENT_CATEGORIES)[number])) throw new BadRequestError("Unknown incident category.");
  if (input.severity && !INCIDENT_SEVERITIES.includes(input.severity as (typeof INCIDENT_SEVERITIES)[number])) throw new BadRequestError("Unknown severity.");
  if (input.patientId) await assertPatientInFacility(prisma, input.patientId, input.facilityId);
  if (input.encounterId) await assertEncounterInFacility(prisma, input.encounterId, input.facilityId, input.patientId);
  await assertQualityRefsInFacility(prisma, input.facilityId, { departmentId: input.departmentId });
  if (input.infectionIncidentId) {
    const inf = await prisma.infectionIncident.findUnique({ where: { id: input.infectionIncidentId } });
    if (!inf || inf.facilityId !== input.facilityId) throw new NotFoundError("Infection incident not found in this facility.");
  }
  const incident = await prisma.qualityIncident.create({
    data: {
      facilityId: input.facilityId, category: input.category, severity: input.severity ?? "MODERATE",
      confidentiality: input.confidentiality ?? "STANDARD", title: input.title, description: input.description,
      immediateAction: input.immediateAction, patientId: input.patientId, encounterId: input.encounterId,
      departmentId: input.departmentId, occurrenceAt: input.occurrenceAt, dueAt: input.dueAt,
      reportedByStaffId: input.reportedByStaffId, relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId, infectionIncidentId: input.infectionIncidentId, source: input.source,
    },
  });
  await recordAuditEvent("hospital.quality.incidentReported", input.byUserId, { incidentId: incident.id, category: incident.category, severity: incident.severity }, { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId });
  return incident;
}

const INCIDENT_STATUS_AUDIT: Record<string, Parameters<typeof recordAuditEvent>[0]> = {
  TRIAGED: "hospital.quality.incidentTriaged",
  UNDER_INVESTIGATION: "hospital.quality.incidentInvestigationStarted",
  ACTION_REQUIRED: "hospital.quality.incidentActionRequired",
  RESOLVED: "hospital.quality.incidentResolved",
  CLOSED: "hospital.quality.incidentClosed",
  CANCELLED: "hospital.quality.incidentCancelled",
};

export async function transitionIncident(input: {
  incidentId: string; facilityId: string; to: string; actorStaffId: string;
  reason?: string; assignedInvestigatorStaffId?: string; byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const inc = await tx.qualityIncident.findUnique({ where: { id: input.incidentId } });
    if (!inc || inc.facilityId !== input.facilityId) throw new NotFoundError("Quality incident not found.");
    // actorStaffId is persisted onto the transition record as the accountable
    // party, so it must be a real active staff member of this facility rather
    // than any id the client cares to send (gate §38 audit-actor forgery).
    await assertQualityStaffInFacility(tx, input.actorStaffId, input.facilityId);
    if (!isTransitionAllowed(INCIDENT_TRANSITIONS, inc.status, input.to)) throw new BadRequestError(`Illegal incident transition ${inc.status} -> ${input.to}.`);
    const data: Record<string, unknown> = { status: input.to };
    if (input.to === "UNDER_INVESTIGATION") {
      if (input.assignedInvestigatorStaffId) { await assertQualityStaffInFacility(tx, input.assignedInvestigatorStaffId, input.facilityId); data.assignedInvestigatorStaffId = input.assignedInvestigatorStaffId; }
      if (!inc.investigationStartedAt) data.investigationStartedAt = new Date();
    }
    if (input.to === "RESOLVED") data.resolvedAt = new Date();
    if (input.to === "CLOSED") data.closedAt = new Date();
    if (input.to === "CANCELLED") data.cancelledAt = new Date();
    const r = await tx.qualityIncident.updateMany({ where: { id: inc.id, status: inc.status }, data });
    if (r.count !== 1) throw new QualityConcurrencyError();
    await tx.qualityIncidentTransition.create({ data: { facilityId: inc.facilityId, incidentId: inc.id, fromStatus: inc.status, toStatus: input.to, reason: input.reason, actorStaffId: input.actorStaffId } });
    await tx.auditEvent.create({ data: { type: INCIDENT_STATUS_AUDIT[input.to] ?? "hospital.quality.incidentUpdated", userId: input.byUserId, detail: { incidentId: inc.id, from: inc.status, to: input.to, reason: input.reason }, facilityId: inc.facilityId, patientId: inc.patientId, encounterId: inc.encounterId } });
    return tx.qualityIncident.findUniqueOrThrow({ where: { id: inc.id } });
  });
}

/** Reopening a closed incident is an explicit, separately-authorized, audited transition (brief §5). */
export async function reopenIncident(input: { incidentId: string; facilityId: string; actorStaffId: string; reason: string; byUserId: string }) {
  if (!input.reason?.trim()) throw new BadRequestError("A reason is required to reopen a closed incident.");
  return prisma.$transaction(async (tx) => {
    const inc = await tx.qualityIncident.findUnique({ where: { id: input.incidentId } });
    if (!inc || inc.facilityId !== input.facilityId) throw new NotFoundError("Quality incident not found.");
    await assertQualityStaffInFacility(tx, input.actorStaffId, input.facilityId);
    const r = await tx.qualityIncident.updateMany({ where: { id: inc.id, status: "CLOSED" }, data: { status: "UNDER_INVESTIGATION", reopenedAt: new Date(), closedAt: null } });
    if (r.count !== 1) throw new BadRequestError("Only a closed incident can be reopened.");
    await tx.qualityIncidentTransition.create({ data: { facilityId: inc.facilityId, incidentId: inc.id, fromStatus: "CLOSED", toStatus: "UNDER_INVESTIGATION", reason: input.reason, actorStaffId: input.actorStaffId } });
    await tx.auditEvent.create({ data: { type: "hospital.quality.incidentReopened", userId: input.byUserId, detail: { incidentId: inc.id, reason: input.reason }, facilityId: inc.facilityId, patientId: inc.patientId } });
    return tx.qualityIncident.findUniqueOrThrow({ where: { id: inc.id } });
  });
}

// ══ ROOT CAUSE ANALYSIS ══════════════════════════════════════════════════════
export async function createRca(input: {
  facilityId: string; incidentId: string; methodology?: string; problemStatement: string;
  contributingFactors?: string; rootCauses?: string; findings?: string; recommendations?: string;
  authoredByStaffId: string; byUserId: string;
}) {
  const inc = await prisma.qualityIncident.findUnique({ where: { id: input.incidentId } });
  if (!inc || inc.facilityId !== input.facilityId) throw new NotFoundError("Quality incident not found.");
  if (inc.status === "CANCELLED") throw new BadRequestError("Cannot add an RCA to a cancelled incident.");
  const rca = await prisma.rootCauseAnalysis.create({
    data: {
      facilityId: input.facilityId, incidentId: input.incidentId, methodology: input.methodology ?? "FIVE_WHYS",
      problemStatement: input.problemStatement, contributingFactors: input.contributingFactors,
      rootCauses: input.rootCauses, findings: input.findings, recommendations: input.recommendations,
      authoredByStaffId: input.authoredByStaffId,
    },
  }).catch(asDuplicateError("An RCA already exists for this incident."));
  await recordAuditEvent("hospital.quality.rcaCreated", input.byUserId, { rcaId: rca.id, incidentId: input.incidentId }, { facilityId: input.facilityId });
  return rca;
}

/** Editing an RCA is guarded to the DRAFT/UNDER_REVIEW states — a REVIEWED RCA is protected from uncontrolled mutation (brief §8). */
export async function updateRca(input: { rcaId: string; facilityId: string; patch: Partial<{ methodology: string; problemStatement: string; contributingFactors: string; rootCauses: string; findings: string; recommendations: string; status: string }>; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const rca = await tx.rootCauseAnalysis.findUnique({ where: { id: input.rcaId } });
    if (!rca || rca.facilityId !== input.facilityId) throw new NotFoundError("RCA not found.");
    if (rca.status === "REVIEWED") throw new BadRequestError("A reviewed RCA is locked; create a new version to make changes.");
    if (input.patch.status && !["DRAFT", "UNDER_REVIEW"].includes(input.patch.status)) throw new BadRequestError("Use reviewRca to mark an RCA reviewed.");
    // Allow-list the patch. The caller is untrusted JSON: spreading it straight
    // into the update let a client set facilityId (moving an RCA into another
    // facility), reviewedByStaffId/reviewedAt (forging a review attestation and
    // defeating maker/checker), incidentId (re-pointing the RCA at a different
    // incident) or authoredByStaffId. Only these fields are ever writable here;
    // review is exclusively reviewRca()'s job.
    const EDITABLE = ["methodology", "problemStatement", "contributingFactors", "rootCauses", "findings", "recommendations", "status"] as const;
    const data: Record<string, unknown> = { version: { increment: 1 } };
    for (const key of EDITABLE) {
      if (input.patch[key] !== undefined) data[key] = input.patch[key];
    }
    const r = await tx.rootCauseAnalysis.updateMany({ where: { id: rca.id, version: rca.version }, data });
    if (r.count !== 1) throw new QualityConcurrencyError();
    await tx.auditEvent.create({ data: { type: "hospital.quality.rcaUpdated", userId: input.byUserId, detail: { rcaId: rca.id, incidentId: rca.incidentId, fields: Object.keys(data).filter((k) => k !== "version") }, facilityId: rca.facilityId } });
    return tx.rootCauseAnalysis.findUniqueOrThrow({ where: { id: rca.id } });
  });
}

export async function reviewRca(input: { rcaId: string; facilityId: string; reviewedByStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const rca = await tx.rootCauseAnalysis.findUnique({ where: { id: input.rcaId } });
    if (!rca || rca.facilityId !== input.facilityId) throw new NotFoundError("RCA not found.");
    await assertQualityStaffInFacility(tx, input.reviewedByStaffId, input.facilityId);
    // Maker/checker: the author of an RCA cannot sign off their own analysis.
    // This mirrors approvePurchaseOrder/approveRequisition's same-actor guard —
    // an RCA review is the attestation that an independent reviewer examined the
    // investigation, and it is worthless if the author can self-certify.
    if (rca.authoredByStaffId === input.reviewedByStaffId) {
      throw new BadRequestError("An RCA must be reviewed by someone other than its author.");
    }
    const r = await tx.rootCauseAnalysis.updateMany({ where: { id: rca.id, status: { in: ["DRAFT", "UNDER_REVIEW"] } }, data: { status: "REVIEWED", reviewedByStaffId: input.reviewedByStaffId, reviewedAt: new Date() } });
    if (r.count !== 1) throw new BadRequestError("RCA is already reviewed.");
    await tx.auditEvent.create({ data: { type: "hospital.quality.rcaReviewed", userId: input.byUserId, detail: { rcaId: rca.id, incidentId: rca.incidentId }, facilityId: rca.facilityId } });
    return tx.rootCauseAnalysis.findUniqueOrThrow({ where: { id: rca.id } });
  });
}

// ══ CAPA ═════════════════════════════════════════════════════════════════════
export async function createCapa(input: {
  facilityId: string; title: string; description: string; actionType: "CORRECTIVE" | "PREVENTIVE";
  incidentId?: string; findingId?: string; ownerStaffId?: string; departmentId?: string; dueAt?: Date;
  createdByStaffId: string; byUserId: string;
}) {
  if (!["CORRECTIVE", "PREVENTIVE"].includes(input.actionType)) throw new BadRequestError("actionType must be CORRECTIVE or PREVENTIVE.");
  // incidentId/findingId/departmentId are all client-supplied; each must be
  // proven to live in this facility before it is persisted (gate §25).
  await assertQualityRefsInFacility(prisma, input.facilityId, {
    incidentId: input.incidentId, findingId: input.findingId, departmentId: input.departmentId,
  });
  if (input.ownerStaffId) await assertQualityStaffInFacility(prisma, input.ownerStaffId, input.facilityId);
  const capa = await prisma.capaAction.create({
    data: {
      facilityId: input.facilityId, title: input.title, description: input.description, actionType: input.actionType,
      incidentId: input.incidentId, findingId: input.findingId, ownerStaffId: input.ownerStaffId,
      departmentId: input.departmentId, dueAt: input.dueAt, createdByStaffId: input.createdByStaffId,
    },
  });
  await recordAuditEvent("hospital.quality.capaCreated", input.byUserId, { capaId: capa.id, incidentId: input.incidentId, actionType: capa.actionType }, { facilityId: input.facilityId });
  return capa;
}

export async function transitionCapa(input: {
  capaId: string; facilityId: string; to: string; actorStaffId: string;
  evidenceDocumentId?: string; completionNote?: string; byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const capa = await tx.capaAction.findUnique({ where: { id: input.capaId } });
    if (!capa || capa.facilityId !== input.facilityId) throw new NotFoundError("CAPA action not found.");
    if (!isTransitionAllowed(CAPA_TRANSITIONS, capa.status, input.to)) throw new BadRequestError(`Illegal CAPA transition ${capa.status} -> ${input.to}.`);
    const data: Record<string, unknown> = { status: input.to };
    if (input.to === "COMPLETED") {
      // Completion must not be silent: require an owner and either a completion note or evidence (brief §9).
      if (!capa.ownerStaffId) throw new BadRequestError("Assign an owner before completing this CAPA.");
      if (!input.completionNote?.trim() && !input.evidenceDocumentId && !capa.evidenceDocumentId) throw new BadRequestError("Record a completion note or attach evidence before completing this CAPA.");
      data.completedAt = new Date();
      if (input.evidenceDocumentId) data.evidenceDocumentId = input.evidenceDocumentId;
    }
    if (input.to === "VERIFIED") {
      await assertQualityStaffInFacility(tx, input.actorStaffId, input.facilityId);
      // Maker/checker: effectiveness verification is an independent check, so
      // neither the owner who performed the action nor its creator may verify it.
      if (capa.ownerStaffId === input.actorStaffId || capa.createdByStaffId === input.actorStaffId) {
        throw new BadRequestError("A CAPA must be verified by someone other than its owner or creator.");
      }
      data.verifiedByStaffId = input.actorStaffId; data.verifiedAt = new Date();
    }
    if (input.to === "CLOSED") data.closedAt = new Date();
    if (input.to === "CANCELLED") data.cancelledAt = new Date();
    const r = await tx.capaAction.updateMany({ where: { id: capa.id, status: capa.status }, data });
    if (r.count !== 1) throw new QualityConcurrencyError();
    const auditType = input.to === "COMPLETED" ? "hospital.quality.capaCompleted" : input.to === "VERIFIED" ? "hospital.quality.capaVerified" : input.to === "CLOSED" ? "hospital.quality.capaClosed" : "hospital.quality.capaUpdated";
    await tx.auditEvent.create({ data: { type: auditType, userId: input.byUserId, detail: { capaId: capa.id, from: capa.status, to: input.to }, facilityId: capa.facilityId } });
    return tx.capaAction.findUniqueOrThrow({ where: { id: capa.id } });
  });
}

// ══ COMPLIANCE FRAMEWORK (NABH-oriented, configurable — no certification logic) ═
export async function createStandard(input: { facilityId: string; code: string; title: string; description?: string; category?: string; ownerStaffId?: string; reviewDueAt?: Date; createdByStaffId: string; byUserId: string }) {
  const standard = await prisma.qualityStandard.create({
    data: { facilityId: input.facilityId, code: input.code, title: input.title, description: input.description, category: input.category, ownerStaffId: input.ownerStaffId, reviewDueAt: input.reviewDueAt, createdByStaffId: input.createdByStaffId },
  }).catch(asDuplicateError("A standard with this code already exists for this facility."));
  await recordAuditEvent("hospital.quality.standardCreated", input.byUserId, { standardId: standard.id, code: standard.code }, { facilityId: input.facilityId });
  return standard;
}

export async function addMeasure(input: { facilityId: string; standardId: string; code: string; title: string; description?: string; ownerStaffId?: string; byUserId: string }) {
  const standard = await prisma.qualityStandard.findUnique({ where: { id: input.standardId } });
  if (!standard || standard.facilityId !== input.facilityId) throw new NotFoundError("Standard not found in this facility.");
  const measure = await prisma.qualityMeasure.create({
    data: { facilityId: input.facilityId, standardId: input.standardId, code: input.code, title: input.title, description: input.description, ownerStaffId: input.ownerStaffId },
  }).catch(asDuplicateError("A measure with this code already exists for this standard."));
  await recordAuditEvent("hospital.quality.measureCreated", input.byUserId, { measureId: measure.id, standardId: input.standardId }, { facilityId: input.facilityId });
  return measure;
}

export async function setMeasureStatus(input: { facilityId: string; measureId: string; status: string; reviewedByStaffId: string; byUserId: string }) {
  const valid = ["PENDING", "COMPLIANT", "PARTIAL", "NON_COMPLIANT", "NOT_APPLICABLE"];
  if (!valid.includes(input.status)) throw new BadRequestError("Unknown measure status.");
  const measure = await prisma.qualityMeasure.findUnique({ where: { id: input.measureId } });
  if (!measure || measure.facilityId !== input.facilityId) throw new NotFoundError("Measure not found.");
  await assertQualityStaffInFacility(prisma, input.reviewedByStaffId, input.facilityId);
  const updated = await prisma.qualityMeasure.update({ where: { id: measure.id }, data: { status: input.status, reviewedByStaffId: input.reviewedByStaffId, reviewedAt: new Date() } });
  await recordAuditEvent("hospital.quality.measureReviewed", input.byUserId, { measureId: measure.id, status: input.status }, { facilityId: input.facilityId });
  return updated;
}

// ══ EVIDENCE (references existing ClinicalDocument — no second document store) ══
export async function attachEvidence(input: {
  facilityId: string; description: string; evidenceType?: string; documentId?: string;
  incidentId?: string; rcaId?: string; capaId?: string; standardId?: string; measureId?: string; findingId?: string; auditId?: string;
  providedByStaffId: string; byUserId: string;
}) {
  if (!input.incidentId && !input.rcaId && !input.capaId && !input.standardId && !input.measureId && !input.findingId && !input.auditId) {
    throw new BadRequestError("Evidence must be associated with at least one record.");
  }
  if (input.documentId) {
    const doc = await prisma.clinicalDocument.findUnique({ where: { id: input.documentId } });
    if (!doc || doc.facilityId !== input.facilityId) throw new NotFoundError("Document not found in this facility.");
  }
  // Every target this evidence can be hung off is client-supplied. Validating
  // only the document left the parent links open: a reporter in facility A
  // could attach evidence onto facility B's incident/RCA/CAPA/audit purely by
  // guessing an id (gate §25 evidence IDOR).
  await assertQualityRefsInFacility(prisma, input.facilityId, {
    incidentId: input.incidentId, rcaId: input.rcaId, capaId: input.capaId, standardId: input.standardId,
    measureId: input.measureId, findingId: input.findingId, auditId: input.auditId,
  });
  const evidence = await prisma.complianceEvidence.create({
    data: {
      facilityId: input.facilityId, description: input.description, evidenceType: input.evidenceType, documentId: input.documentId,
      incidentId: input.incidentId, rcaId: input.rcaId, capaId: input.capaId, standardId: input.standardId,
      measureId: input.measureId, findingId: input.findingId, auditId: input.auditId, providedByStaffId: input.providedByStaffId,
    },
  }).catch(asDuplicateError("This document is already attached to that measurable element."));
  await recordAuditEvent("hospital.quality.evidenceAttached", input.byUserId, { evidenceId: evidence.id, documentId: input.documentId }, { facilityId: input.facilityId });
  return evidence;
}

// ══ INTERNAL AUDITS + FINDINGS ═════════════════════════════════════════════════
export async function createAudit(input: { facilityId: string; title: string; scope?: string; departmentId?: string; auditorStaffId: string; plannedStartAt?: Date; createdByStaffId: string; byUserId: string }) {
  await assertQualityStaffInFacility(prisma, input.auditorStaffId, input.facilityId);
  const audit = await prisma.qualityAudit.create({
    data: { facilityId: input.facilityId, title: input.title, scope: input.scope, departmentId: input.departmentId, auditorStaffId: input.auditorStaffId, plannedStartAt: input.plannedStartAt, createdByStaffId: input.createdByStaffId },
  });
  await recordAuditEvent("hospital.quality.auditCreated", input.byUserId, { auditId: audit.id, title: audit.title }, { facilityId: input.facilityId });
  return audit;
}

export async function transitionAudit(input: { auditId: string; facilityId: string; to: string; summary?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const audit = await tx.qualityAudit.findUnique({ where: { id: input.auditId } });
    if (!audit || audit.facilityId !== input.facilityId) throw new NotFoundError("Audit not found.");
    if (!isTransitionAllowed(AUDIT_TRANSITIONS, audit.status, input.to)) throw new BadRequestError(`Illegal audit transition ${audit.status} -> ${input.to}.`);
    const data: Record<string, unknown> = { status: input.to, ...(input.summary !== undefined ? { summary: input.summary } : {}) };
    if (input.to === "IN_PROGRESS") data.startedAt = new Date();
    if (input.to === "COMPLETED") data.completedAt = new Date();
    if (input.to === "CLOSED") data.closedAt = new Date();
    const r = await tx.qualityAudit.updateMany({ where: { id: audit.id, status: audit.status }, data });
    if (r.count !== 1) throw new QualityConcurrencyError();
    await tx.auditEvent.create({ data: { type: input.to === "COMPLETED" ? "hospital.quality.auditCompleted" : "hospital.quality.auditUpdated", userId: input.byUserId, detail: { auditId: audit.id, from: audit.status, to: input.to }, facilityId: audit.facilityId } });
    return tx.qualityAudit.findUniqueOrThrow({ where: { id: audit.id } });
  });
}

export async function createFinding(input: {
  facilityId: string; title: string; description: string; sourceType?: string; severity?: string;
  auditId?: string; standardId?: string; measureId?: string; incidentId?: string; identifiedByStaffId: string; byUserId: string;
}) {
  // auditId was validated but standardId/measureId/incidentId were written
  // straight through, so a finding could be linked across facilities (gate §25).
  await assertQualityRefsInFacility(prisma, input.facilityId, {
    auditId: input.auditId, standardId: input.standardId, measureId: input.measureId, incidentId: input.incidentId,
  });
  const finding = await prisma.qualityFinding.create({
    data: { facilityId: input.facilityId, title: input.title, description: input.description, sourceType: input.sourceType, severity: input.severity, auditId: input.auditId, standardId: input.standardId, measureId: input.measureId, incidentId: input.incidentId, identifiedByStaffId: input.identifiedByStaffId },
  });
  await recordAuditEvent("hospital.quality.findingCreated", input.byUserId, { findingId: finding.id, auditId: input.auditId }, { facilityId: input.facilityId });
  return finding;
}

export async function closeFinding(input: { facilityId: string; findingId: string; closedByStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const finding = await tx.qualityFinding.findUnique({ where: { id: input.findingId } });
    if (!finding || finding.facilityId !== input.facilityId) throw new NotFoundError("Finding not found.");
    const r = await tx.qualityFinding.updateMany({ where: { id: finding.id, status: { in: ["OPEN", "IN_PROGRESS"] } }, data: { status: "CLOSED", closedByStaffId: input.closedByStaffId, closedAt: new Date() } });
    if (r.count !== 1) throw new BadRequestError("Finding is already closed.");
    await tx.auditEvent.create({ data: { type: "hospital.quality.findingClosed", userId: input.byUserId, detail: { findingId: finding.id }, facilityId: finding.facilityId } });
    return tx.qualityFinding.findUniqueOrThrow({ where: { id: finding.id } });
  });
}
