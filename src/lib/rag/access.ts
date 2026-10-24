import type { RagCategory, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";
import { selfPatientIds } from "@/lib/person/self";
import { careRelationship, ownedPersonId, personAccess } from "@/lib/person/access";
import { aiAssistancePermit, type AiDataOwner, type AiRefusal } from "@/lib/ai/realData";
import type { AiPermit } from "@/lib/ai/record/types";
import { MODES, type AiAudience, type AiMode } from "./modes";
import { ALL_CATEGORIES, ALL_SENSITIVE, type RetrievalScope, type ScopeSegment } from "./scope";
import { resolveShare } from "@/lib/sharing/resolve";
import { ragCategoriesFor } from "@/lib/sharing/categories";
import { staffIsSubject } from "@/lib/doctors/self";

const latest = (a?: Date, b?: Date) => (a && b ? (a > b ? a : b) : a ?? b);
const earliest = (a?: Date, b?: Date) => (a && b ? (a < b ? a : b) : a ?? b);

/**
 * Week 4b — who may ask what about whom (docs/RAG_DESIGN.md §1, §7.1). The AI
 * has no access rules of its own: every path is the same decision the app
 * makes elsewhere, expressed as a retrieval scope, from server-side values
 * only (the session, the caller's facility and staff profile); the request
 * names only the patient, the mode and, where needed, the share or report.
 *
 *   TREATING      a doctor or nurse at the patient's facility, with an active
 *                 care relationship (the resolver's, OPD/IPD windows); a nurse
 *                 only for a patient assigned to them (an open
 *                 NursingAssignment), and only chart Q&A and the handoff; the
 *                 Person's uploads and confirmed facts only with their
 *                 "share my uploads" choice (personAccess)
 *   SHARE         a share (Week 4c, src/lib/sharing/resolve.ts): a visit code
 *                 this doctor redeemed (its consult open) or a request the
 *                 person approved for them or their facility: only the share's
 *                 categories (and allergies), its period, its sensitive
 *                 opt-ins; uploads only with UPLOADS. A code from before 4c
 *                 reads under the legacy code scope
 *   ORG_CONSENT   a doctor at another facility of the same organization, with
 *                 the patient's consent to that organization (InteropConsent,
 *                 recipient ORGANIZATION): its scopes only, never sensitive
 *   OWN           the patient (their OWNER login): their own records (every
 *                 ACTIVE link) and their own uploads and facts, patient-
 *                 visible entries only
 *   PROXY         (Week 5b) a household proxy with USE_AI for the record's
 *                 Person: the patient-audience modes only, over what the
 *                 grant's categories and sensitive opt-ins allow, with the
 *                 member's own AI consent (a guardian's for a child). A
 *                 facility delegation (PatientDelegation) is not a proxy and
 *                 stays refused. Every refusal is 404-shaped for a record the caller can't
 * see, 403 for a mode or path they can't use.
 */
export type AiActor =
  | { kind: "STAFF"; userId: string; role: Role; facilityId: string }
  | { kind: "PATIENT"; userId: string };

export type AccessPath = "TREATING" | "NURSE_ASSIGNED" | "SHARE" | "ORG_CONSENT" | "OWN" | "PROXY";

export interface AiAccess {
  mode: AiMode;
  audience: AiAudience;
  path: AccessPath;
  scope: RetrievalScope;
  /** The record asked about (canonical id), its facility and organization, and its Person if linked. */
  subject: { patientId: string; patientIds: string[]; facilityId: string; organizationId: string; personId: string | null };
  /** The caller's facility (staff), for the interaction record and the budget. */
  callerFacilityId: string | null;
  callerOrganizationId: string | null;
  shareId?: string;
  consentId?: string;
  /** Live facts (§7.4): read from these records, if the scope allows their categories. */
  live: { patientIds: string[]; facilityIds: string[]; medications: boolean; allergies: boolean; patientProvidedAllergies: boolean; nurseView: boolean; period?: { from?: Date; to?: Date } };
  /** Week 4c: the share's person (for the access log) and how the caller got in. */
  share?: { personId: string | null; via: "SHARE_CODE" | "ACCESS_REQUEST" | "BOOKING"; categories: string[] };
  permit: AiPermit;
  real: boolean;
}

export class AiAccessError extends Error {
  constructor(readonly status: 403 | 404, readonly code: string) {
    super(code);
    this.name = "AiAccessError";
  }
}

const STAFF_MODES: Record<string, readonly AiMode[]> = {
  DOCTOR: ["VISIT_BRIEF", "CHART_QA", "HEALTH_TIMELINE"],
  NURSE: ["CHART_QA", "NURSE_HANDOFF"],
};
const PATIENT_MODES: readonly AiMode[] = ["EXPLAIN_REPORT", "HEALTH_TIMELINE", "PREVISIT_QUESTIONS"];

/** InteropConsent scopes → sharing categories (ORG_CONSENT). */
const SCOPE_CATEGORIES: Record<string, RagCategory[]> = {
  ALL_CLINICAL: ["PRESCRIPTIONS", "LABS", "IMAGING", "DISCHARGE_SUMMARIES", "CLINICAL_NOTES", "DIAGNOSES", "ALLERGIES", "VITALS", "REFERRALS"],
  DIAGNOSIS: ["DIAGNOSES"], LAB: ["LABS"], IMAGING: ["IMAGING"], MEDICATION: ["PRESCRIPTIONS"], DOCUMENTS: ["DISCHARGE_SUMMARIES", "CLINICAL_NOTES"],
  ENCOUNTER: ["CLINICAL_NOTES", "REFERRALS"], ALLERGY: ["ALLERGIES"], VITALS: ["VITALS"], CARE_PLAN: ["CLINICAL_NOTES"],
};

async function aiEnabled(organizationId: string, facilityId: string): Promise<boolean> {
  const eff = await resolveEffectiveInternal({ key: "ai.enabled", organizationId, facilityId, fallbackRaw: "false" });
  return eff.value === true;
}

async function gate(owner: AiDataOwner): Promise<{ permit: AiPermit; real: boolean }> {
  const g = await aiAssistancePermit(owner);
  if (!g.allowed) throw new AiAccessError(403, `AI_${(g.reason as AiRefusal)}`);
  return { permit: g.permit, real: g.real };
}

const NON_SENSITIVE: [] = [];

export interface AccessRequest { mode: AiMode; patientId: string; shareId?: string; documentId?: string; period?: { from?: Date; to?: Date } }

export async function resolveAiAccess(actor: AiActor, req: AccessRequest): Promise<AiAccess> {
  const spec = MODES[req.mode];
  const patient = await prisma.patient.findUnique({ where: { id: req.patientId }, select: { id: true, facilityId: true, facility: { select: { organizationId: true } } } });
  if (!patient) throw new AiAccessError(404, "NOT_FOUND");
  const patientIds = await resolvePatientIdsForRead(patient.id);
  const link = await prisma.personPatientLink.findFirst({ where: { patientId: patient.id, facilityId: patient.facilityId, status: "ACTIVE" }, select: { personId: true } });
  const subject = { patientId: patient.id, patientIds, facilityId: patient.facilityId, organizationId: patient.facility.organizationId, personId: link?.personId ?? null };
  const period = { recordedFrom: req.period?.from, recordedTo: req.period?.to };

  if (actor.kind === "PATIENT") {
    if (!PATIENT_MODES.includes(req.mode)) throw new AiAccessError(403, "MODE_NOT_ALLOWED");
    const own = await selfPatientIds(actor.userId);
    // Not their own record: only a household proxy with USE_AI for its Person (Week 5b); anything else is "not yours".
    if (!own.includes(patient.id)) return proxyAccess(actor.userId, req, spec.audience, subject, period);
    const personId = await ownedPersonId(actor.userId);
    if (!personId || !(await personAccess({ kind: "OWNER", userId: actor.userId }, personId, "PROFILE"))) throw new AiAccessError(404, "NOT_FOUND");
    const links = await prisma.personPatientLink.findMany({ where: { personId, status: "ACTIVE" }, select: { patientId: true, facilityId: true } });
    const ownIds = [...new Set((await Promise.all(links.map((l) => resolvePatientIdsForRead(l.patientId)))).flat())];
    const g = await gate({ personId });
    const segments: ScopeSegment[] = [
      { path: "OWN", facility: { patientIds: ownIds, facilityIds: [...new Set(links.map((l) => l.facilityId))] }, categories: ALL_CATEGORIES, sensitive: ALL_SENSITIVE, audiences: ["PATIENT_VISIBLE"], origins: ["VERIFIED"], ...period },
      { path: "OWN", personId, categories: ALL_CATEGORIES, sensitive: ALL_SENSITIVE, audiences: ["PATIENT_VISIBLE"], origins: ["PATIENT_PROVIDED"], ...period },
    ];
    return {
      mode: req.mode, audience: spec.audience, path: "OWN", scope: { segments }, subject: { ...subject, personId }, callerFacilityId: null, callerOrganizationId: null,
      live: { patientIds: ownIds, facilityIds: [...new Set(links.map((l) => l.facilityId))], medications: true, allergies: true, patientProvidedAllergies: false, nurseView: false },
      permit: g.permit, real: g.real,
    };
  }

  // Staff.
  const modes = STAFF_MODES[actor.role] ?? [];
  if (!modes.includes(req.mode)) throw new AiAccessError(403, "MODE_NOT_ALLOWED");
  // Week 5a: a doctor never reads their own record through doctor tools (the same human, src/lib/doctors/self.ts).
  if (await staffIsSubject(actor.userId, subject.personId)) throw new AiAccessError(404, "NOT_FOUND");
  const caller = await prisma.facility.findUnique({ where: { id: actor.facilityId }, select: { organizationId: true } });
  if (!caller) throw new AiAccessError(403, "NO_FACILITY");
  if (!(await aiEnabled(caller.organizationId, actor.facilityId))) throw new AiAccessError(403, "AI_NOT_ENABLED");
  const staff = await prisma.hospitalStaffProfile.findFirst({ where: { userId: actor.userId, department: { facilityId: actor.facilityId } }, select: { id: true } });
  const recordGate = () => gate({ facilityId: patient.facilityId, patientId: patient.id });
  const base = { mode: req.mode, audience: spec.audience, subject, callerFacilityId: actor.facilityId, callerOrganizationId: caller.organizationId };

  // A share: a visit code this doctor redeemed, or a request the person approved (Week 4c,
  // docs/CONSENT_SHARING_DESIGN.md §8). Only its categories (and allergies), its period,
  // its sensitive opt-ins, and the person's uploads only with UPLOADS.
  if (req.shareId) {
    if (actor.role !== "DOCTOR") throw new AiAccessError(403, "MODE_NOT_ALLOWED");
    const share = await resolveShare({ userId: actor.userId, facilityId: actor.facilityId, role: actor.role }, req.shareId);
    if (!share || !share.patientIds.includes(patient.id)) throw new AiAccessError(404, "NOT_FOUND");
    const g = await recordGate();
    const from = latest(share.recordedFrom ?? undefined, req.period?.from);
    const to = earliest(share.recordedTo ?? undefined, req.period?.to);
    const sharePeriod = { recordedFrom: from, recordedTo: to };
    const categories = ragCategoriesFor(share.categories);
    const segments: ScopeSegment[] = [{ path: "SHARE", facility: { patientIds: share.patientIds, facilityIds: share.facilityIds }, categories: categories.filter((c) => c !== "UPLOADS"), sensitive: share.sensitive, audiences: ["STAFF_ONLY", "PATIENT_VISIBLE"], origins: ["VERIFIED"], ...sharePeriod }];
    if (share.categories.includes("UPLOADS") && share.personId) {
      segments.push({ path: "SHARE_UPLOADS", personId: share.personId, categories, sensitive: share.sensitive, audiences: ["PATIENT_VISIBLE"], origins: ["PATIENT_PROVIDED"], ...sharePeriod });
    }
    return {
      ...base, path: "SHARE", shareId: share.shareId ?? share.ref, scope: { segments },
      live: { patientIds: share.patientIds, facilityIds: share.facilityIds, medications: share.categories.includes("PRESCRIPTIONS"), allergies: true, patientProvidedAllergies: share.categories.includes("UPLOADS"), nurseView: false, period: { from, to } },
      share: { personId: share.personId ?? subject.personId, via: share.via, categories: share.categories },
      permit: g.permit, real: g.real,
    };
  }

  // Another facility of the same organization: only with the patient's consent to the organization.
  if (patient.facilityId !== actor.facilityId) {
    if (patient.facility.organizationId !== caller.organizationId || actor.role !== "DOCTOR") throw new AiAccessError(404, "NOT_FOUND");
    const now = new Date();
    const consent = await prisma.interopConsent.findFirst({
      where: { patientId: { in: patientIds }, recipientType: "ORGANIZATION", recipientIdentifier: caller.organizationId, status: { in: ["GRANTED", "ACTIVE"] }, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      include: { scopes: true },
    });
    if (!consent) throw new AiAccessError(404, "NOT_FOUND");
    const categories = [...new Set(consent.scopes.flatMap((x) => SCOPE_CATEGORIES[x.scope] ?? []))];
    if (!categories.length) throw new AiAccessError(404, "NOT_FOUND");
    const g = await recordGate();
    return {
      ...base, path: "ORG_CONSENT", consentId: consent.id,
      scope: { segments: [{ path: "ORG_CONSENT", facility: { patientIds, facilityIds: [patient.facilityId] }, categories, sensitive: NON_SENSITIVE, audiences: ["STAFF_ONLY", "PATIENT_VISIBLE"], origins: ["VERIFIED"], ...period }] },
      live: { patientIds, facilityIds: [patient.facilityId], medications: categories.includes("PRESCRIPTIONS"), allergies: categories.includes("ALLERGIES"), patientProvidedAllergies: false, nurseView: false },
      permit: g.permit, real: g.real,
    };
  }

  // The treating facility.
  if (actor.role === "NURSE") {
    const now = new Date();
    const assigned = staff ? await prisma.nursingAssignment.count({ where: { nurseStaffId: staff.id, patientId: { in: patientIds }, facilityId: actor.facilityId, startAt: { lte: now }, OR: [{ endAt: null }, { endAt: { gt: now } }] } }) : 0;
    if (!assigned) throw new AiAccessError(404, "NOT_FOUND");
  } else if (!(await careRelationship(actor.facilityId, patient.id)).active) {
    throw new AiAccessError(404, "NOT_FOUND");
  }
  const g = await recordGate();
  const segments: ScopeSegment[] = [
    // The chart permission already shows the treating team every category, sensitive ones included.
    { path: actor.role === "NURSE" ? "NURSE_ASSIGNED" : "TREATING", facility: { patientIds, facilityIds: [actor.facilityId] }, categories: ALL_CATEGORIES, sensitive: ALL_SENSITIVE, audiences: ["STAFF_ONLY", "PATIENT_VISIBLE"], origins: ["VERIFIED"], ...period },
  ];
  const personGrant = subject.personId ? await personAccess({ kind: "STAFF", userId: actor.userId, facilityId: actor.facilityId }, subject.personId, "UPLOADS") : null;
  if (personGrant) segments.push({ path: "TREATING_UPLOADS", personId: subject.personId!, categories: ALL_CATEGORIES, sensitive: ALL_SENSITIVE, audiences: ["PATIENT_VISIBLE"], origins: ["PATIENT_PROVIDED"], ...period });
  return {
    ...base, path: actor.role === "NURSE" ? "NURSE_ASSIGNED" : "TREATING", scope: { segments },
    live: { patientIds, facilityIds: [actor.facilityId], medications: true, allergies: true, patientProvidedAllergies: !!personGrant, nurseView: actor.role === "NURSE" },
    permit: g.permit, real: g.real,
  };
}

/** Week 5b: a household proxy's AI over the member's record, within the grant. */
async function proxyAccess(userId: string, req: AccessRequest, audience: AiAudience, subject: AiAccess["subject"], period: { recordedFrom?: Date; recordedTo?: Date }): Promise<AiAccess> {
  if (!subject.personId) throw new AiAccessError(404, "NOT_FOUND");
  const grant = await personAccess({ kind: "PROXY", userId, permission: "USE_AI" }, subject.personId, "UPLOADS");
  if (!grant?.proxy) throw new AiAccessError(404, "NOT_FOUND");
  const p = grant.proxy;
  const links = await prisma.personPatientLink.findMany({ where: { personId: subject.personId, status: "ACTIVE" }, select: { patientId: true, facilityId: true } });
  const ids = [...new Set((await Promise.all(links.map((l) => resolvePatientIdsForRead(l.patientId)))).flat())];
  const facilityIds = [...new Set(links.map((l) => l.facilityId))];
  const categories = ragCategoriesFor(p.categories);
  const g = await gate({ personId: subject.personId });
  const segments: ScopeSegment[] = [
    { path: "PROXY", facility: { patientIds: ids, facilityIds }, categories: categories.filter((c) => c !== "UPLOADS"), sensitive: p.sensitive, audiences: ["PATIENT_VISIBLE"], origins: ["VERIFIED"], ...period },
  ];
  if (p.categories.includes("UPLOADS")) segments.push({ path: "PROXY", personId: subject.personId, categories, sensitive: p.sensitive, audiences: ["PATIENT_VISIBLE"], origins: ["PATIENT_PROVIDED"], ...period });
  await prisma.personAccessLogEntry.create({ data: { personId: subject.personId, kind: "PROXY_ACTION", actorUserId: userId, detail: { via: "PROXY", proxyPersonId: p.proxyPersonId, action: "USE_AI", mode: req.mode } } });
  return {
    mode: req.mode, audience, path: "PROXY", scope: { segments }, subject, callerFacilityId: null, callerOrganizationId: null,
    live: { patientIds: ids, facilityIds, medications: p.categories.includes("PRESCRIPTIONS"), allergies: true, patientProvidedAllergies: p.categories.includes("UPLOADS"), nurseView: false },
    permit: g.permit, real: g.real,
  };
}
