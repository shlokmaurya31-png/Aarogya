import { randomUUID } from "node:crypto";
import type { CashlessDecision, CashlessDecisionReason, CashlessRequest, CashlessStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { decidePreAuth, requestPreAuth } from "@/lib/hospital/billing/preauth";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";
import { sensitiveAllowed } from "@/lib/sharing/history";
import { verifyCheckInCard } from "../cardShares";
import { staffCard } from "../cards";
import { notifyPersonAndProxiesTx } from "../claimDocuments";
import { insurancePerson, personPatientIds } from "../status";
import { cashlessExchange } from "./adapter";

/**
 * Flagship 5, step 5 — cashless insurance, phase 1, behind the mock NHCX
 * adapter (docs/CASHLESS_CLAIMS_DESIGN.md §3, §15).
 *
 *   eligibility    the desk checks a card shared at check-in; "eligible"
 *                  verifies it into the facility's coverage (method ELIGIBILITY)
 *   request        the desk builds a pre-authorisation from the admission
 *                  (diagnosis, planned procedure, estimate) and proposes the
 *                  hospital's documents the insurer needs
 *   approval       the patient, or a household member with INSURANCE for them,
 *                  approves or removes each document; only then is anything
 *                  sent, and only the approved documents
 *   response       the insurer's messages (approved, partial, query, rejected)
 *                  move the request; each is recorded once, so a replay is a
 *                  no-op; the canonical PreAuthorization is written through
 *                  requestPreAuth / decidePreAuth
 *   query          the desk answers; documents it adds go to the patient first
 *
 * The desk works under the facility's tenancy (another facility's request is a
 * 404); the patient side goes through personAccess (insurancePerson). Every
 * state change emits its catalogued event in the same transaction; events
 * carry ids and closed codes only.
 */
type Tx = Prisma.TransactionClient;
type Staff = { userId: string; facilityId: string };
type PatientActor = { userId: string; memberPersonId?: string };

const OPEN: CashlessStatus[] = ["AWAITING_PATIENT", "SUBMITTED", "QUERY"];
const REASONS: CashlessDecisionReason[] = ["NOT_COVERED", "WAITING_PERIOD", "SUB_LIMIT", "ROOM_RENT_LIMIT", "DOCUMENTS_INSUFFICIENT", "POLICY_INACTIVE", "OTHER"];
const MAX_DOCUMENTS = 10;

const REASON_TEXT: Record<CashlessDecisionReason, string> = {
  NOT_COVERED: "the treatment isn't covered by the policy",
  WAITING_PERIOD: "the policy's waiting period hasn't ended",
  SUB_LIMIT: "the policy's limit for this treatment",
  ROOM_RENT_LIMIT: "the policy's room rent limit",
  DOCUMENTS_INSUFFICIENT: "the insurer needed more documents",
  POLICY_INACTIVE: "the policy isn't active",
  OTHER: "the insurer's own reasons (ask the hospital's insurance desk)",
};

async function statusChangedTx(tx: Tx, r: Pick<CashlessRequest, "id" | "facilityId" | "encounterId" | "patientId">, from: CashlessStatus | "NONE", to: CashlessStatus, actorUserId: string | null, decisionReason?: CashlessDecisionReason | null) {
  await emitFacilityEvent(tx, {
    type: "CashlessRequestStatusChanged", aggregateId: r.id, facilityId: r.facilityId, encounterId: r.encounterId, actorUserId,
    payload: { requestId: r.id, encounterId: r.encounterId, patientId: r.patientId, from, to, ...(decisionReason ? { decisionReason } : {}) },
  });
}

/** The Person a facility record belongs to now (an ACTIVE link), if any. */
async function personOf(patientId: string): Promise<string | null> {
  return (await prisma.personPatientLink.findFirst({ where: { patientId: { in: await resolvePatientIdsForRead(patientId) }, status: "ACTIVE" }, select: { personId: true } }))?.personId ?? null;
}

/** Move a request from the status read to another, or refuse: two writers never both win. */
async function moveTx(tx: Tx, r: CashlessRequest, to: CashlessStatus, data: Prisma.CashlessRequestUpdateManyMutationInput, actorUserId: string | null, decisionReason?: CashlessDecisionReason | null) {
  const u = await tx.cashlessRequest.updateMany({ where: { id: r.id, status: r.status, version: r.version }, data: { ...data, status: to, version: { increment: 1 } } });
  if (u.count !== 1) throw new ConflictError("This request changed in the meantime. Refresh and try again.");
  await statusChangedTx(tx, r, r.status, to, actorUserId, decisionReason);
}

// ── Eligibility at check-in ─────────────────────────────────────────────────

/** The desk checks the card a patient shared at check-in. Eligible: verified into the facility's coverage. Never waited for (5c). */
export async function checkEligibilityAtCheckIn(staff: Staff, checkInId: string) {
  const ci = await prisma.preArrivalCheckIn.findUnique({ where: { id: checkInId } });
  if (!ci || ci.facilityId !== staff.facilityId || !ci.cardShareId) throw new NotFoundError();
  const { card } = await staffCard({ userId: staff.userId, facilityId: staff.facilityId, cardShareId: ci.cardShareId });
  const correlationId = randomUUID();
  const { result } = await cashlessExchange().checkEligibility({ correlationId, payerId: card.payerId, memberIdLast4: card.memberIdLast4 });
  let coverageId: string | null = null;
  if (result === "ELIGIBLE") coverageId = (await verifyCheckInCard(staff, checkInId, { outcome: "VERIFIED" }, "ELIGIBILITY")).coverageId;
  const row = await prisma.$transaction(async (tx) => {
    const e = await tx.cashlessEligibility.create({ data: { facilityId: staff.facilityId, checkInId, patientId: ci.patientId, result, coverageId, correlationId, checkedByUserId: staff.userId } });
    await emitFacilityEvent(tx, {
      type: "CashlessEligibilityChecked", aggregateId: e.id, facilityId: staff.facilityId, actorUserId: staff.userId,
      payload: { eligibilityId: e.id, checkInId, patientId: ci.patientId, result, ...(coverageId ? { coverageId } : {}) },
    });
    return e;
  });
  await recordAuditEvent("hospital.cashless.eligibility", staff.userId, { checkInId, result, coverageId }, { facilityId: staff.facilityId, patientId: ci.patientId });
  return { eligibilityId: row.id, result, coverageId };
}

// ── The desk ────────────────────────────────────────────────────────────────

async function proposable(tx: Tx | typeof prisma, facilityId: string, patientId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length || unique.length > MAX_DOCUMENTS) throw new BadRequestError(`Propose 1 to ${MAX_DOCUMENTS} of the hospital's documents for this admission.`);
  const docs = await tx.clinicalDocument.findMany({ where: { id: { in: unique }, facilityId, patientId: { in: await resolvePatientIdsForRead(patientId) }, status: "CURRENT" }, select: { id: true, title: true, type: true, accessPolicy: true } });
  if (docs.length !== unique.length) throw new NotFoundError();
  if (docs.some((d) => d.type === "ID_PROOF")) throw new BadRequestError("ID proofs aren't sent this way: the insurer checks identity through the policy.");
  if (docs.some((d) => d.accessPolicy === "RESTRICTED")) throw new BadRequestError("A restricted document can't be proposed in this phase.");
  return docs;
}

/** The desk builds a pre-authorisation request from an admission and proposes the documents; the patient is asked to approve them. */
export async function startCashlessRequest(staff: Staff, body: { encounterId?: unknown; coverageId?: unknown; diagnosis?: unknown; plannedProcedure?: unknown; estimateMinor?: unknown; documentIds?: unknown }) {
  const encounterId = typeof body.encounterId === "string" ? body.encounterId : "";
  const enc = encounterId ? await prisma.encounter.findUnique({ where: { id: encounterId }, select: { id: true, facilityId: true, patientId: true, type: true, admission: { select: { id: true } }, diagnoses: { where: { type: "PRIMARY" }, orderBy: { createdAt: "desc" }, take: 1, select: { diagnosis: true } }, admissionRequests: { orderBy: { createdAt: "desc" }, take: 1, select: { reason: true } } } }) : null;
  if (!enc || enc.facilityId !== staff.facilityId) throw new NotFoundError();
  if (!enc.admission) throw new BadRequestError("Cashless pre-authorisation is for an admission.");
  const estimateMinor = typeof body.estimateMinor === "number" && Number.isInteger(body.estimateMinor) && body.estimateMinor > 0 && body.estimateMinor <= 1_000_000_000 ? body.estimateMinor : null;
  if (estimateMinor === null) throw new BadRequestError("Give the hospital's estimate, in paise.");
  const text = (x: unknown, n: number) => (typeof x === "string" ? x.trim().slice(0, n) : "");
  const diagnosis = text(body.diagnosis, 300) || enc.diagnoses[0]?.diagnosis || enc.admissionRequests[0]?.reason || "";
  const plannedProcedure = text(body.plannedProcedure, 300);
  if (diagnosis.length < 3 || plannedProcedure.length < 3) throw new BadRequestError("The diagnosis and the planned procedure are needed.");
  const coverage = await prisma.patientCoverage.findFirst({
    where: { patientId: { in: await resolvePatientIdsForRead(enc.patientId) }, status: "ACTIVE", ...(typeof body.coverageId === "string" ? { id: body.coverageId } : {}), payer: { type: { not: "CASH" } } },
    orderBy: { priorityOrder: "asc" }, select: { id: true },
  });
  if (!coverage) throw new BadRequestError("The patient has no active insurance coverage at this hospital: verify their card first.");
  const docs = await proposable(prisma, staff.facilityId, enc.patientId, Array.isArray(body.documentIds) ? body.documentIds.map(String) : []);
  const personId = await personOf(enc.patientId);

  const r = await prisma.$transaction(async (tx) => {
    if (await tx.cashlessRequest.count({ where: { encounterId: enc.id, status: { in: OPEN } } })) throw new ConflictError("This admission already has an open cashless request.");
    const created = await tx.cashlessRequest.create({
      data: { facilityId: staff.facilityId, patientId: enc.patientId, encounterId: enc.id, coverageId: coverage.id, diagnosis, plannedProcedure, estimateMinor, correlationId: randomUUID(), createdByUserId: staff.userId, documents: { create: docs.map((d) => ({ facilityId: staff.facilityId, clinicalDocumentId: d.id, title: d.title })) } },
    });
    await statusChangedTx(tx, created, "NONE", "AWAITING_PATIENT", staff.userId);
    if (personId) await notifyPersonAndProxiesTx(tx, personId, "DOCUMENTS_REQUESTED", `CASHLESS:${created.id}:1`);
    return created;
  });
  await recordAuditEvent("hospital.cashless.started", staff.userId, { requestId: r.id, encounterId: enc.id, documents: docs.length }, { facilityId: staff.facilityId, patientId: enc.patientId });
  return { id: r.id, status: r.status, patientLinked: !!personId };
}

/** The desk's queue: the facility's cashless requests, open ones first. */
export async function deskCashlessQueue(staff: Staff) {
  const rows = await prisma.cashlessRequest.findMany({
    where: { facilityId: staff.facilityId }, orderBy: [{ updatedAt: "desc" }], take: 100,
    include: { documents: { orderBy: [{ round: "asc" }, { createdAt: "asc" }] } },
  });
  const patients = await prisma.patient.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.patientId))] }, facilityId: staff.facilityId }, select: { id: true, fullName: true, uhid: true } });
  // For a query's answer: the hospital documents not yet on the request.
  const extra = await prisma.clinicalDocument.findMany({
    where: { facilityId: staff.facilityId, patientId: { in: rows.filter((r) => r.status === "QUERY").map((r) => r.patientId) }, status: "CURRENT", type: { not: "ID_PROOF" }, accessPolicy: { not: "RESTRICTED" } },
    orderBy: { createdAt: "desc" }, select: { id: true, title: true, patientId: true },
  });
  const view = (r: (typeof rows)[number]) => ({
    id: r.id, status: r.status, encounterId: r.encounterId, patientId: r.patientId,
    patient: patients.find((p) => p.id === r.patientId) ? { name: patients.find((p) => p.id === r.patientId)!.fullName, uhid: patients.find((p) => p.id === r.patientId)!.uhid } : null,
    diagnosis: r.diagnosis, plannedProcedure: r.plannedProcedure, estimateMinor: r.estimateMinor, approvedAmountMinor: r.approvedAmountMinor,
    decisionReason: r.decisionReason, queryText: r.queryText, queryAnswer: r.queryAnswer, queryCount: r.queryCount,
    submittedAt: r.submittedAt?.toISOString() ?? null, decidedAt: r.decidedAt?.toISOString() ?? null, updatedAt: r.updatedAt.toISOString(),
    documents: r.documents.map((d) => ({ id: d.id, title: d.title, round: d.round, status: d.status, decidedVia: d.decidedVia, sentAt: d.sentAt?.toISOString() ?? null })),
    canAdd: r.status === "QUERY" ? extra.filter((d) => d.patientId === r.patientId && !r.documents.some((x) => x.clinicalDocumentId === d.id)).map((d) => ({ id: d.id, title: d.title })) : [],
  });
  const all = rows.map(view);
  return { open: all.filter((r) => OPEN.includes(r.status)), decided: all.filter((r) => !OPEN.includes(r.status)), candidates: await cashlessCandidates(staff.facilityId, rows) };
}

/** Admissions the desk could start a request for: admitted now, with active insurance coverage here and no open request; with the hospital documents it may propose. */
async function cashlessCandidates(facilityId: string, rows: { encounterId: string; status: CashlessStatus }[]) {
  const busy = new Set(rows.filter((r) => OPEN.includes(r.status)).map((r) => r.encounterId));
  const encs = await prisma.encounter.findMany({
    where: { facilityId, type: "IPD", status: "ADMITTED", admission: { isNot: null }, patient: { coverages: { some: { status: "ACTIVE", payer: { type: { not: "CASH" } } } } } },
    orderBy: { registeredAt: "desc" }, take: 50,
    select: { id: true, patientId: true, patient: { select: { fullName: true, uhid: true } }, diagnoses: { where: { type: "PRIMARY" }, orderBy: { createdAt: "desc" }, take: 1, select: { diagnosis: true } } },
  });
  const open = encs.filter((e) => !busy.has(e.id));
  const docs = await prisma.clinicalDocument.findMany({
    where: { facilityId, patientId: { in: open.map((e) => e.patientId) }, status: "CURRENT", type: { not: "ID_PROOF" }, accessPolicy: { not: "RESTRICTED" } },
    orderBy: { createdAt: "desc" }, select: { id: true, title: true, patientId: true },
  });
  return open.map((e) => ({
    encounterId: e.id, patientId: e.patientId, patient: { name: e.patient.fullName, uhid: e.patient.uhid }, diagnosis: e.diagnoses[0]?.diagnosis ?? null,
    documents: docs.filter((d) => d.patientId === e.patientId).map((d) => ({ id: d.id, title: d.title })),
  }));
}

/** The desk answers the insurer's query. Documents it adds go to the patient first; with none, the answer goes now. */
export async function answerCashlessQuery(staff: Staff, requestId: string, body: { answer?: unknown; documentIds?: unknown }) {
  const r = await prisma.cashlessRequest.findUnique({ where: { id: requestId } });
  if (!r || r.facilityId !== staff.facilityId) throw new NotFoundError();
  if (r.status !== "QUERY") throw new ConflictError("There is no question from the insurer waiting on this request.");
  const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, 2000) : "";
  if (answer.length < 5) throw new BadRequestError("Write the answer to the insurer's question.");
  const ids = Array.isArray(body.documentIds) ? body.documentIds.map(String) : [];
  const docs = ids.length ? await proposable(prisma, staff.facilityId, r.patientId, ids) : [];
  const personId = docs.length ? await personOf(r.patientId) : null;
  const round = r.queryCount + 1;
  await prisma.$transaction(async (tx) => {
    if (docs.length) {
      const already = await tx.cashlessDocument.findMany({ where: { requestId: r.id, clinicalDocumentId: { in: docs.map((d) => d.id) } }, select: { id: true } });
      if (already.length) throw new ConflictError("A document already on this request can't be proposed again.");
      await tx.cashlessDocument.createMany({ data: docs.map((d) => ({ requestId: r.id, facilityId: r.facilityId, clinicalDocumentId: d.id, title: d.title, round })) });
      await moveTx(tx, r, "AWAITING_PATIENT", { queryAnswer: answer }, staff.userId);
      if (personId) await notifyPersonAndProxiesTx(tx, personId, "DOCUMENTS_REQUESTED", `CASHLESS:${r.id}:${round}`);
    } else {
      await moveTx(tx, r, "SUBMITTED", { queryAnswer: answer }, staff.userId);
    }
  });
  if (!docs.length) await cashlessExchange().answerQuery({ correlationId: r.correlationId, requestId: r.id, answer, documents: [] });
  await recordAuditEvent("hospital.cashless.queryAnswered", staff.userId, { requestId: r.id, documents: docs.length }, { facilityId: r.facilityId, patientId: r.patientId });
  return { id: r.id, status: docs.length ? ("AWAITING_PATIENT" as const) : ("SUBMITTED" as const) };
}

/** The desk withdraws a request that hasn't been decided (the patient pays and claims later, or a new request follows). */
export async function cancelCashlessRequest(staff: Staff, requestId: string) {
  const r = await prisma.cashlessRequest.findUnique({ where: { id: requestId } });
  if (!r || r.facilityId !== staff.facilityId) throw new NotFoundError();
  if (!OPEN.includes(r.status)) throw new ConflictError("This request is already decided.");
  await prisma.$transaction((tx) => moveTx(tx, r, "CANCELLED", {}, staff.userId));
  await recordAuditEvent("hospital.cashless.cancelled", staff.userId, { requestId: r.id }, { facilityId: r.facilityId, patientId: r.patientId });
  return { id: r.id, status: "CANCELLED" as const };
}

// ── The patient (or their INSURANCE proxy) ──────────────────────────────────

const PATIENT_TEXT: Record<CashlessStatus, string> = {
  AWAITING_PATIENT: "The hospital needs your approval of the documents to send your insurer",
  SUBMITTED: "The hospital has asked your insurer to pay directly; waiting for your insurer",
  QUERY: "Your insurer asked the hospital a question. The hospital is answering",
  APPROVED: "Your insurer approved cashless for this stay",
  PARTIAL: "Your insurer approved part of the estimate",
  REJECTED: "Your insurer did not approve cashless for this stay",
  CANCELLED: "The hospital withdrew the cashless request",
};

async function logProxy(personId: string, a: PatientActor, action: "CASHLESS_VIEWED" | "CASHLESS_DOCUMENTS", detail: Record<string, unknown>) {
  if (!a.memberPersonId) return;
  await prisma.personAccessLogEntry.create({ data: { personId, kind: "PROXY_ACTION", actorUserId: a.userId, detail: { via: "PROXY", action, ...detail } as Prisma.InputJsonValue } });
}

/** The person's cashless requests, in plain words: decided values only, the share from the hospital's own estimate, labelled as such. */
export async function patientCashless(a: PatientActor) {
  const personId = await insurancePerson(a);
  const patientIds = await personPatientIds(personId);
  const rows = await prisma.cashlessRequest.findMany({
    where: { patientId: { in: patientIds }, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" }, take: 20,
    include: { documents: { orderBy: [{ round: "asc" }, { createdAt: "asc" }] } },
  });
  const facilities = await prisma.facility.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.facilityId))] } }, select: { id: true, name: true } });
  await logProxy(personId, a, "CASHLESS_VIEWED", { requests: rows.length });
  return {
    requests: rows.map((r) => {
      const decided = r.status === "APPROVED" || r.status === "PARTIAL";
      const shareMinor = decided && r.approvedAmountMinor !== null ? Math.max(0, r.estimateMinor - r.approvedAmountMinor) : null;
      return {
        id: r.id, hospital: facilities.find((f) => f.id === r.facilityId)?.name ?? "The hospital", status: r.status, text: PATIENT_TEXT[r.status],
        approvedAmountMinor: decided ? r.approvedAmountMinor : null, estimateMinor: r.estimateMinor, shareMinor,
        shareText: shareMinor !== null ? "Based on the hospital's estimate; the final bill is at discharge" : null,
        reasonText: (r.status === "PARTIAL" || r.status === "REJECTED") && r.decisionReason ? `Reason: ${REASON_TEXT[r.decisionReason]}` : null,
        documents: r.documents.map((d) => ({ id: d.id, title: d.title, status: d.status, toDecide: d.status === "PROPOSED" && r.status === "AWAITING_PATIENT" })),
      };
    }),
  };
}

/** Approve or remove each proposed document. When none is left to decide, the request (or the desk's answer) goes, with exactly the approved ones. */
export async function decideCashlessDocuments(a: PatientActor, requestId: string, body: { decisions?: unknown; confirmSensitive?: unknown }) {
  const personId = await insurancePerson(a);
  const r = await prisma.cashlessRequest.findUnique({ where: { id: requestId }, include: { documents: true } });
  if (!r || !(await personPatientIds(personId)).includes(r.patientId)) throw new NotFoundError();
  if (r.status !== "AWAITING_PATIENT") throw new ConflictError("Nothing is waiting for your approval on this request.");
  const decisions = Array.isArray(body.decisions) ? (body.decisions as { documentId?: unknown; decision?: unknown }[]) : [];
  const proposed = r.documents.filter((d) => d.status === "PROPOSED");
  const byId = new Map(decisions.map((d) => [String(d.documentId), d.decision]));
  if (byId.size !== decisions.length || proposed.length !== byId.size || proposed.some((d) => byId.get(d.id) !== "APPROVE" && byId.get(d.id) !== "REMOVE")) {
    throw new BadRequestError("Approve or remove each document the hospital proposed.");
  }
  const approving = proposed.filter((d) => byId.get(d.id) === "APPROVE");
  if (approving.some((d) => !sensitiveAllowed([], { texts: [d.title] })) && body.confirmSensitive !== true) {
    throw new ConflictError("One of these documents may be sensitive (for example HIV or mental health). Confirm you want it sent to your insurer.");
  }
  const via = a.memberPersonId ? ("PROXY" as const) : ("OWNER" as const);
  const now = new Date();
  const answering = r.preAuthorizationId !== null;
  const out = await prisma.$transaction(async (tx) => {
    for (const d of proposed) {
      const to = byId.get(d.id) === "APPROVE" ? ("APPROVED" as const) : ("REMOVED" as const);
      const u = await tx.cashlessDocument.updateMany({ where: { id: d.id, status: "PROPOSED" }, data: { status: to, decidedByUserId: a.userId, decidedVia: via, decidedAt: now, ...(to === "APPROVED" ? { sentAt: now } : {}) } });
      if (u.count !== 1) throw new ConflictError("This request changed in the meantime. Refresh and try again.");
      await emitFacilityEvent(tx, {
        type: "CashlessDocumentDecided", aggregateId: r.id, facilityId: r.facilityId, encounterId: r.encounterId, actorUserId: a.userId,
        payload: { requestId: r.id, documentId: d.id, patientId: r.patientId, to, via },
      });
    }
    let preAuthorizationId = r.preAuthorizationId;
    if (!answering) preAuthorizationId = (await requestPreAuth(tx, { coverageId: r.coverageId, encounterId: r.encounterId, requestedAmountMinor: r.estimateMinor, requestedByUserId: r.createdByUserId, notes: "Cashless request through the exchange" })).id;
    await moveTx(tx, r, "SUBMITTED", { preAuthorizationId, ...(answering ? {} : { submittedAt: now }) }, a.userId);
    return { preAuthorizationId };
  });
  // Exactly the approved documents leave; a removed one never does.
  const sent = approving.map((d) => ({ id: d.clinicalDocumentId, title: d.title }));
  if (answering) await cashlessExchange().answerQuery({ correlationId: r.correlationId, requestId: r.id, answer: r.queryAnswer ?? "", documents: sent });
  else await cashlessExchange().submitPreAuth({ correlationId: r.correlationId, requestId: r.id, estimateMinor: r.estimateMinor, diagnosis: r.diagnosis, plannedProcedure: r.plannedProcedure, documents: sent });
  await logProxy(personId, a, "CASHLESS_DOCUMENTS", { requestId: r.id, approved: approving.length, removed: proposed.length - approving.length });
  await recordAuditEvent("patient.cashless.documentsDecided", a.userId, { requestId: r.id, approved: approving.length, removed: proposed.length - approving.length, via }, { facilityId: r.facilityId, patientId: r.patientId });
  return { id: r.id, status: "SUBMITTED" as const, approved: approving.length, removed: proposed.length - approving.length, preAuthorizationId: out.preAuthorizationId };
}

// ── The insurer's responses (the exchange's callbacks; the mock's, for now) ──

export interface InsurerMessage { correlationId: string; externalMessageId: string; decision: CashlessDecision; approvedAmountMinor?: number; reason?: CashlessDecisionReason; queryText?: string }

/**
 * One insurer message, recorded once per facility and external id: a replay
 * is a no-op. Applied only to a SUBMITTED request of this facility; a message
 * for a request that has moved on is kept with applied = false.
 */
export async function receiveInsurerResponse(facilityId: string, m: InsurerMessage): Promise<{ applied: boolean; replayed: boolean; status: CashlessStatus | null }> {
  if (!m.externalMessageId || !["APPROVED", "PARTIAL", "QUERY", "REJECTED"].includes(m.decision)) throw new BadRequestError("A message needs its id and a decision.");
  if (m.reason !== undefined && !REASONS.includes(m.reason)) throw new BadRequestError("Unknown reason category.");
  const r = await prisma.cashlessRequest.findUnique({ where: { correlationId: m.correlationId } });
  if (!r || r.facilityId !== facilityId) throw new NotFoundError();
  if (await prisma.cashlessInsurerMessage.findUnique({ where: { facilityId_externalMessageId: { facilityId, externalMessageId: m.externalMessageId } } })) return { applied: false, replayed: true, status: r.status };
  const amount = m.decision === "APPROVED" || m.decision === "PARTIAL" ? m.approvedAmountMinor : undefined;
  if ((m.decision === "APPROVED" || m.decision === "PARTIAL") && (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0)) throw new BadRequestError("An approval carries its amount.");
  if (m.decision === "PARTIAL" && amount! >= r.estimateMinor) throw new BadRequestError("A partial approval is less than the estimate.");
  try {
    return await prisma.$transaction(async (tx) => {
      const cur = await tx.cashlessRequest.findUniqueOrThrow({ where: { id: r.id } });
      const applies = cur.status === "SUBMITTED";
      const msg = await tx.cashlessInsurerMessage.create({ data: { facilityId, requestId: r.id, externalMessageId: m.externalMessageId, decision: m.decision, approvedAmountMinor: amount ?? null, reason: m.reason ?? null, applied: applies } });
      await emitFacilityEvent(tx, {
        type: "CashlessInsurerResponseReceived", aggregateId: r.id, facilityId, encounterId: r.encounterId, actorUserId: null,
        payload: { requestId: r.id, messageId: msg.id, patientId: r.patientId, decision: m.decision, applied: applies },
      });
      if (!applies) return { applied: false, replayed: false, status: cur.status };
      const now = new Date();
      if (m.decision === "QUERY") {
        await moveTx(tx, cur, "QUERY", { queryText: (m.queryText ?? "").slice(0, 2000) || null, queryAnswer: null, queryCount: { increment: 1 } }, null);
        const personId = await personOf(r.patientId);
        if (personId) await notifyPersonAndProxiesTx(tx, personId, "INSURANCE_UPDATE", `CASHLESS_QUERY:${r.id}:${cur.queryCount + 1}`);
        return { applied: true, replayed: false, status: "QUERY" as const };
      }
      const to: CashlessStatus = m.decision === "REJECTED" ? "REJECTED" : m.decision === "PARTIAL" ? "PARTIAL" : "APPROVED";
      // The canonical pre-authorisation: its own events, and the patient told by patient-insurance-notify.
      if (cur.preAuthorizationId) await decidePreAuth(tx, cur.preAuthorizationId, m.decision === "REJECTED" ? { status: "DENIED", byUserId: null } : { status: "APPROVED", approvedAmountMinor: amount, byUserId: null });
      const reason = to === "APPROVED" ? null : (m.reason ?? "OTHER");
      await moveTx(tx, cur, to, { approvedAmountMinor: amount ?? null, decisionReason: reason, decidedAt: now }, null, reason);
      return { applied: true, replayed: false, status: to };
    });
  } catch (e) {
    // Two deliveries of one message at once: the unique key let one in; the other is the replay.
    if ((e as { code?: string }).code === "P2002") return { applied: false, replayed: true, status: (await prisma.cashlessRequest.findUniqueOrThrow({ where: { id: r.id } })).status };
    throw e;
  }
}

/** The mock insurer (gates, the browser journey's hospital step): a fresh message for a request, through the same path as a real callback. */
export async function mockInsurerRespond(facilityId: string, requestId: string, d: { decision: CashlessDecision; approvedAmountMinor?: number; reason?: CashlessDecisionReason; queryText?: string; externalMessageId?: string }) {
  cashlessExchange();
  const r = await prisma.cashlessRequest.findUnique({ where: { id: requestId }, select: { correlationId: true, facilityId: true } });
  if (!r || r.facilityId !== facilityId) throw new NotFoundError();
  const externalMessageId = d.externalMessageId ?? `mock-${randomUUID()}`;
  return { externalMessageId, ...(await receiveInsurerResponse(facilityId, { correlationId: r.correlationId, externalMessageId, decision: d.decision, approvedAmountMinor: d.approvedAmountMinor, reason: d.reason, queryText: d.queryText })) };
}
