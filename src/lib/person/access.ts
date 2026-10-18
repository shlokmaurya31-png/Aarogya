import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";

/**
 * Phase 0 — THE access resolver for person-level data
 * (docs/PERSON_IDENTITY_DESIGN.md §8). Every read of person-scoped rows, and
 * every staff read of a patient's uploads, decides here:
 *
 *   OWNER   the person's own login: everything person-level.
 *   STAFF   never the person's profile, contacts, links or access log. Their
 *           uploads only when the person chose "share my uploads with
 *           hospitals treating me" (an affirmative, recorded choice; no
 *           default) AND the staff member's facility has an active care
 *           relationship with the person's linked record there. Uploads made
 *           before Phase 0 stay visible to the facility they were uploaded to
 *           until the person makes that choice (the approved reversal).
 *
 * Nothing here takes a personId from a request as authority: callers pass the
 * id they are asking about and get a grant or nothing.
 */

export type PersonActor =
  | { kind: "OWNER"; userId: string }
  | { kind: "STAFF"; userId: string; facilityId: string };

export type PersonPurpose = "PROFILE" | "UPLOADS";

export interface PersonGrant {
  personId: string;
  via: "OWNER" | "CARE_RELATIONSHIP";
}

export const SHARE_UPLOADS = "SHARE_UPLOADS_WITH_TREATING" as const;

/** Default and maximum care windows (days). The registry enforces the maximum. */
export const CARE_WINDOW_DEFAULT_DAYS = 30;
export const CARE_WINDOW_MAX_DAYS = 90;

/** The Person an account owns and acts as (OWNER, not ended, ACTIVE), or null. */
export async function ownedPersonId(userId: string): Promise<string | null> {
  const acct = await prisma.personAccount.findUnique({ where: { userId }, select: { personId: true, endedAt: true, role: true, person: { select: { status: true } } } });
  if (!acct || acct.endedAt || acct.role !== "OWNER" || acct.person.status !== "ACTIVE") return null;
  return acct.personId;
}

/** The person's current decision on a person-level consent purpose, or null if they haven't chosen. */
export async function personDecision(personId: string, purpose: typeof SHARE_UPLOADS): Promise<"GRANTED" | "DECLINED" | null> {
  const row = await prisma.personConsent.findFirst({ where: { personId, purpose, status: "ACTIVE" }, select: { decision: true } });
  return row?.decision ?? null;
}

async function windowDays(facilityId: string, key: "identity.care_window_opd_days" | "identity.care_window_ipd_days"): Promise<number> {
  const facility = await prisma.facility.findUnique({ where: { id: facilityId }, select: { organizationId: true } });
  if (!facility?.organizationId) return CARE_WINDOW_DEFAULT_DAYS;
  const eff = await resolveEffectiveInternal({ key, organizationId: facility.organizationId, facilityId, fallbackRaw: String(CARE_WINDOW_DEFAULT_DAYS) });
  const n = typeof eff.value === "number" ? eff.value : CARE_WINDOW_DEFAULT_DAYS;
  return Math.min(Math.max(n, 0), CARE_WINDOW_MAX_DAYS);
}

/**
 * Is there an active care relationship between a facility and a patient
 * record of that facility, at `at`?
 *   - an open encounter (not closed) or an admission not yet discharged;
 *   - OPD (any non-IPD encounter): until the window after the last encounter
 *     ended (or began, if it has no end);
 *   - IPD: the admission, plus the window after discharge.
 * Windows are per facility (identity.care_window_{opd,ipd}_days), capped at 90.
 */
export async function careRelationship(facilityId: string, patientId: string, at = new Date()): Promise<{ active: boolean; kind?: "OPEN" | "OPD" | "IPD"; until?: Date }> {
  const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { facilityId: true } });
  if (!patient || patient.facilityId !== facilityId) return { active: false };
  const ids = await resolvePatientIdsForRead(patientId);
  const encounters = await prisma.encounter.findMany({
    where: { patientId: { in: ids }, facilityId },
    select: { type: true, registeredAt: true, closedAt: true, admission: { select: { discharge: { select: { dischargedAt: true } } } } },
  });
  if (encounters.length === 0) return { active: false };
  const [opd, ipd] = await Promise.all([windowDays(facilityId, "identity.care_window_opd_days"), windowDays(facilityId, "identity.care_window_ipd_days")]);
  const day = 86_400_000;
  let until: Date | undefined;
  let kind: "OPD" | "IPD" | undefined;
  for (const e of encounters) {
    const admitted = e.admission != null;
    const dischargedAt = e.admission?.discharge?.dischargedAt ?? null;
    if ((admitted && !dischargedAt) || (!admitted && !e.closedAt)) return { active: true, kind: "OPEN" };
    const end = admitted ? dischargedAt! : (e.closedAt ?? e.registeredAt);
    const isIpd = admitted || e.type === "IPD";
    const u = new Date(end.getTime() + (isIpd ? ipd : opd) * day);
    if (!until || u > until) { until = u; kind = isIpd ? "IPD" : "OPD"; }
  }
  return until && until > at ? { active: true, kind, until } : { active: false, kind, until };
}

/**
 * The single decision for person-level data. Returns a grant or null; null
 * must be reported 404-shaped by callers.
 */
export async function personAccess(actor: PersonActor, personId: string, purpose: PersonPurpose): Promise<PersonGrant | null> {
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { id: true, status: true } });
  if (!person || person.status !== "ACTIVE") return null;
  if (actor.kind === "OWNER") {
    return (await ownedPersonId(actor.userId)) === personId ? { personId, via: "OWNER" } : null;
  }
  // Staff never read the person's own profile, contacts, links or log.
  if (purpose !== "UPLOADS") return null;
  if ((await personDecision(personId, SHARE_UPLOADS)) !== "GRANTED") return null;
  const links = await prisma.personPatientLink.findMany({ where: { personId, facilityId: actor.facilityId, status: "ACTIVE" }, select: { patientId: true } });
  for (const l of links) {
    if ((await careRelationship(actor.facilityId, l.patientId)).active) return { personId, via: "CARE_RELATIONSHIP" };
  }
  return null;
}

/** For OWNER routes: the caller's own Person, or 404. */
export async function requireOwnedPerson(userId: string): Promise<string> {
  const personId = await ownedPersonId(userId);
  if (!personId || !(await personAccess({ kind: "OWNER", userId }, personId, "PROFILE"))) throw new NotFoundError();
  return personId;
}

/**
 * The where-fragment a STAFF read of a patient's documents must AND in, so a
 * patient's uploads reach staff only under personAccess (above):
 *   - documents the facility made (no uploader account): unchanged;
 *   - uploads with no owning Person (accounts the identity migration hasn't
 *     moved): unchanged, the pre-Phase-0 rule;
 *   - uploads of a Person who chose to share: only with a care relationship;
 *   - uploads of a Person who hasn't chosen yet: only the pre-Phase-0 ones
 *     (legacyFacilityVisible), and only at the facility they were uploaded to;
 *   - a Person who declined, or who removed this facility's link: nothing.
 */
export async function staffDocumentVisibility(facilityId: string, patientIds: string[]): Promise<Prisma.ClinicalDocumentWhereInput> {
  const owners = await prisma.clinicalDocument.findMany({
    where: { patientId: { in: patientIds }, uploadedByUserId: { not: null }, personId: { not: null } },
    select: { personId: true }, distinct: ["personId"],
  });
  const granted: string[] = [];
  const undecided: string[] = [];
  for (const { personId } of owners) {
    const pid = personId!;
    const removed = await prisma.personPatientLink.count({ where: { personId: pid, patientId: { in: patientIds }, status: "UNLINKED" } });
    const live = await prisma.personPatientLink.count({ where: { personId: pid, patientId: { in: patientIds }, status: { in: ["ACTIVE", "REVERIFICATION_REQUIRED", "PENDING_VERIFICATION"] } } });
    if (removed > 0 && live === 0) continue;
    const decision = await personDecision(pid, SHARE_UPLOADS);
    if (decision === "GRANTED") {
      if (await personAccess({ kind: "STAFF", userId: "", facilityId }, pid, "UPLOADS")) granted.push(pid);
    } else if (decision === null) {
      undecided.push(pid);
    }
  }
  return {
    OR: [
      { uploadedByUserId: null },
      { personId: null },
      ...(granted.length ? [{ personId: { in: granted } }] : []),
      ...(undecided.length ? [{ personId: { in: undecided }, legacyFacilityVisible: true, facilityId }] : []),
    ],
  };
}

/** Who is reading a patient's documents: staff of a facility, or the patient side (own scope already resolved). */
export type DocumentViewer = { kind: "STAFF"; facilityId: string } | { kind: "PATIENT" };

/** The document where-fragment for a viewer: the staff filter, or nothing extra for the patient side. */
export async function documentVisibilityFor(viewer: DocumentViewer, patientIds: string[]): Promise<Prisma.ClinicalDocumentWhereInput> {
  return viewer.kind === "STAFF" ? staffDocumentVisibility(viewer.facilityId, patientIds) : {};
}

/** The person documents a viewer sees for these records (staff: the resolver; patient side: the linked person's own). */
export async function personDocumentsFor(viewer: DocumentViewer, patientIds: string[]) {
  const { staffPersonDocuments, linkedPersonDocuments } = await import("./documents");
  return viewer.kind === "STAFF" ? staffPersonDocuments(viewer.facilityId, patientIds) : linkedPersonDocuments(patientIds);
}

/** By-id staff lookups: is this one document visible to staff of `facilityId`? */
export async function staffCanSeeDocument(doc: { id: string; patientId: string; uploadedByUserId: string | null; personId: string | null }, facilityId: string): Promise<boolean> {
  if (!doc.uploadedByUserId || !doc.personId) return true;
  const where = await staffDocumentVisibility(facilityId, await resolvePatientIdsForRead(doc.patientId));
  return (await prisma.clinicalDocument.count({ where: { AND: [{ id: doc.id }, where] } })) === 1;
}
