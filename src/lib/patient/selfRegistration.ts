/**
 * Patient self-registration and connecting facility records to a Person
 * (Phase 0, docs/PERSON_IDENTITY_DESIGN.md §4). Every account owns a Person.
 *
 * A new account (or a signed-in person connecting another hospital) is
 * checked against that facility's records (duplicateDetection, never
 * cross-facility):
 *   - No likely match: a new record is created at the facility and linked to
 *     the Person (SELF_CREATED: the person is the record's source).
 *   - A likely match: NOTHING is created or linked. A link request is opened
 *     and routed (person/linking.ts):
 *       a record already connected to an account → front-desk review;
 *       a phone on the record confirmed within 12 months → the person gives
 *         their date of birth or the UHID (exact match), then a code goes to
 *         THAT phone (not one the registrant typed);
 *       otherwise → in-person ID verification at the front desk.
 *   - The front desk can create a new record or reject, or run in-person
 *     verification (two staff members). It can no longer link by deciding.
 * A likely match is never auto-merged or auto-linked, and the registrant is
 * never told anything about the matched record beyond a masked phone number.
 */

import { Role, type PatientLinkRequest, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { generateCandidateUhid } from "@/lib/hospital/uhid";
import { maskPhone } from "@/lib/messaging/sms";
import { findDuplicateCandidates } from "./duplicateDetection";
import { createRegisteredPatient } from "./registration";
import { createPersonForAccount, recordActiveLink } from "@/lib/person/person";
import { requireOwnedPerson } from "@/lib/person/access";
import { routeFor, recordIsClaimed, verifyLinkCode, type LinkRoute } from "@/lib/person/linking";


export interface SelfRegistrationInput {
  fullName: string;
  email: string;
  passwordHash: string;
  sex: string;
  phone?: string;
  dob?: Date;
  facilityId?: string;
}

export type SelfRegistrationOutcome =
  | { status: "LINKED_NEW"; userId: string; patientId: string }
  /** Give the date of birth or the UHID; then a code goes to the record's (masked) phone. */
  | { status: "VERIFICATION_REQUIRED"; userId: string; maskedPhone: string; next: "SECOND_FACTOR" }
  /** Verify in person at the front desk (no usable phone on the record). */
  | { status: "IN_PERSON_REQUIRED"; userId: string }
  | { status: "PENDING_REVIEW"; userId: string };


/** The facility a self-registration joins: the requested one if active, else the first active one. */
async function registrationFacility(facilityId?: string) {
  const facility = facilityId
    ? await prisma.facility.findFirst({ where: { id: facilityId, status: "ACTIVE" } })
    : await prisma.facility.findFirst({ where: { status: "ACTIVE" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (!facility) throw new BadRequestError(facilityId ? "Unknown facility." : "No facility is open for registration yet.");
  return facility;
}

export async function registerPatientAccount(input: SelfRegistrationInput): Promise<SelfRegistrationOutcome> {
  const facility = await registrationFacility(input.facilityId);
  const claimed = { fullName: input.fullName, phone: input.phone, dob: input.dob ?? null, sex: input.sex };
  const best = await bestCandidate(facility.id, claimed);

  if (!best) {
    const uhid = await generateCandidateUhid(facility.id);
    const { user, patient } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: input.email, passwordHash: input.passwordHash, role: Role.PATIENT, displayName: input.fullName } });
      const patient = await createRegisteredPatient(tx, {
        uhid, facilityId: facility.id, fullName: input.fullName, sex: input.sex, phone: input.phone, dob: input.dob, actorUserId: user.id,
      });
      // The account's Person, linked to the record its own sign-up created.
      const person = await createPersonForAccount(tx, { userId: user.id, displayName: input.fullName, email: input.email, dateOfBirth: input.dob, sex: input.sex, source: "SELF_REGISTRATION" });
      await recordActiveLink(tx, { personId: person.id, patientId: patient.id, facilityId: facility.id, method: "SELF_CREATED", linkedByUserId: user.id });
      return { user, patient };
    });
    await recordAuditEvent("patient.account.registered", user.id, { patientId: patient.id, facilityId: facility.id }, { facilityId: facility.id, patientId: patient.id });
    return { status: "LINKED_NEW", userId: user.id, patientId: patient.id };
  }

  const { user, request, route } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email: input.email, passwordHash: input.passwordHash, role: Role.PATIENT, displayName: input.fullName } });
    const person = await createPersonForAccount(tx, { userId: user.id, displayName: input.fullName, email: input.email, dateOfBirth: input.dob, sex: input.sex, source: "SELF_REGISTRATION" });
    const { request, route } = await openLinkRequest(tx, { userId: user.id, personId: person.id, facilityId: facility.id, best, claimed });
    return { user, request, route };
  });
  return outcomeFor(user.id, request, route);
}

/**
 * A signed-in person connects their record at another facility. The same
 * rules as sign-up: no match creates a record there (SELF_CREATED); a match
 * opens a routed link request. Owner only.
 */
export async function connectFacilityRecord(userId: string, input: { facilityId: string; fullName: string; sex: string; phone?: string; dob?: Date }) {
  const personId = await requireOwnedPerson(userId);
  const facility = await registrationFacility(input.facilityId);
  if (await prisma.personPatientLink.count({ where: { personId, facilityId: facility.id, status: { in: ["ACTIVE", "PENDING_VERIFICATION", "REVERIFICATION_REQUIRED"] } } })) {
    throw new ConflictError("Your record at this facility is already connected or being verified.");
  }
  const claimed = { fullName: input.fullName, phone: input.phone, dob: input.dob ?? null, sex: input.sex };
  const best = await bestCandidate(facility.id, claimed);
  if (!best) {
    const uhid = await generateCandidateUhid(facility.id);
    const patient = await prisma.$transaction(async (tx) => {
      const patient = await createRegisteredPatient(tx, { uhid, facilityId: facility.id, fullName: input.fullName, sex: input.sex, phone: input.phone, dob: input.dob, actorUserId: userId });
      await recordActiveLink(tx, { personId, patientId: patient.id, facilityId: facility.id, method: "SELF_CREATED", linkedByUserId: userId });
      return patient;
    });
    await recordAuditEvent("patient.account.registered", userId, { patientId: patient.id, facilityId: facility.id, via: "connect" }, { facilityId: facility.id, patientId: patient.id });
    return { status: "LINKED_NEW" as const, patientId: patient.id };
  }
  const { request, route } = await prisma.$transaction((tx) => openLinkRequest(tx, { userId, personId, facilityId: facility.id, best, claimed }));
  return outcomeFor(userId, request, route);
}

/** The likeliest match: prefer a record nobody holds; if every match is held, still route it (to review). */
async function bestCandidate(facilityId: string, claimed: { fullName: string; phone?: string; dob: Date | null; sex: string }) {
  const candidates = await findDuplicateCandidates(facilityId, claimed);
  for (const c of candidates) if (!(await recordIsClaimed(c.patientId))) return c;
  return candidates[0];
}

async function openLinkRequest(
  tx: Prisma.TransactionClient,
  args: { userId: string; personId: string; facilityId: string; best: Awaited<ReturnType<typeof findDuplicateCandidates>>[number]; claimed: { fullName: string; phone?: string; dob: Date | null; sex: string } },
) {
  const record = await tx.patient.findUniqueOrThrow({ where: { id: args.best.patientId }, select: { id: true, phone: true, phoneConfirmedAt: true } });
  const { route, reason } = await routeFor(record);
  const request = await tx.patientLinkRequest.create({
    data: {
      userId: args.userId, personId: args.personId, facilityId: args.facilityId, candidatePatientId: args.best.patientId,
      status: route, reviewReason: reason, initiatedBy: "PERSON",
      method: route === "SECOND_FACTOR_REQUIRED" ? "OTP_RECORD_CONTACT" : route === "IN_PERSON_REQUIRED" ? "IN_PERSON_ID" : null,
      matchConfidence: args.best.confidence, matchScore: args.best.score, matchedOn: args.best.matchedOn,
      claimedName: args.claimed.fullName, claimedPhone: args.claimed.phone, claimedDob: args.claimed.dob, claimedSex: args.claimed.sex,
    },
  });
  await tx.personAccessLogEntry.create({ data: { personId: args.personId, kind: "LINK_REQUESTED", accessingFacilityId: args.facilityId, actorUserId: args.userId, detail: { linkRequestId: request.id, route } } });
  await recordAuditEvent("patient.account.linkRequested", args.userId,
    { linkRequestId: request.id, confidence: args.best.confidence, matchedOn: args.best.matchedOn, route }, { facilityId: args.facilityId }, tx);
  return { request, route, phone: record.phone };
}

async function outcomeFor(userId: string, request: PatientLinkRequest, route: LinkRoute): Promise<SelfRegistrationOutcome> {
  if (route === "SECOND_FACTOR_REQUIRED") {
    const rec = await prisma.patient.findUniqueOrThrow({ where: { id: request.candidatePatientId! }, select: { phone: true } });
    return { status: "VERIFICATION_REQUIRED", userId, maskedPhone: maskPhone(rec.phone!), next: "SECOND_FACTOR" };
  }
  if (route === "IN_PERSON_REQUIRED") return { status: "IN_PERSON_REQUIRED", userId };
  return { status: "PENDING_REVIEW", userId };
}

/** The caller's latest record-link request, as the registrant may see it (no record details). */
export async function linkStatusFor(userId: string) {
  const r = await prisma.patientLinkRequest.findFirst({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { candidatePatient: { select: { phone: true } } } });
  if (!r) return null;
  const showPhone = (r.status === "OTP_SENT" || r.status === "SECOND_FACTOR_REQUIRED") && r.candidatePatient?.phone;
  return {
    status: r.status,
    maskedPhone: showPhone ? maskPhone(r.candidatePatient!.phone!) : null,
    expiresAt: r.status === "OTP_SENT" ? r.otpExpiresAt?.toISOString() ?? null : null,
  };
}

/** The code sent to the record's phone (after the second factor). See person/linking.ts. */
export async function verifyLinkOtp(userId: string, code: string) {
  return verifyLinkCode(userId, code);
}

/** Front desk: open link requests of this facility, with what they need to decide or verify in person. */
export async function listLinkRequests(facilityId: string) {
  return prisma.patientLinkRequest.findMany({
    where: { facilityId, status: { in: ["FRONT_DESK_REVIEW", "IN_PERSON_REQUIRED", "SECOND_FACTOR_REQUIRED", "OTP_SENT"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true, status: true, reviewReason: true, matchConfidence: true, matchScore: true, matchedOn: true,
      claimedName: true, claimedPhone: true, claimedDob: true, claimedSex: true, createdAt: true,
      user: { select: { email: true } },
      candidatePatient: { select: { id: true, uhid: true, fullName: true, dob: true, sex: true, phone: true } },
    },
  });
}

/**
 * Front desk decision. CREATE_NEW: a separate record for the person, linked
 * to them (they asked for it; SELF_CREATED). REJECT: neither. LINK is gone:
 * staff can't link a record to a Person by deciding — they verify the
 * person's ID in person (two staff members), or the person enters a code.
 */
export async function decideLinkRequest(input: { facilityId: string; requestId: string; decision: "CREATE_NEW" | "REJECT"; reviewerUserId: string; note?: string }) {
  if ((input.decision as string) === "LINK") throw new BadRequestError("The front desk can't link a record by deciding. Verify the person's ID in person, or the person enters a code.");
  const r = await prisma.patientLinkRequest.findUnique({ where: { id: input.requestId } });
  if (!r || r.facilityId !== input.facilityId) throw new NotFoundError("Link request not found.");
  if (!["FRONT_DESK_REVIEW", "IN_PERSON_REQUIRED", "SECOND_FACTOR_REQUIRED", "OTP_SENT"].includes(r.status)) throw new ConflictError("This request has already been resolved.");

  if (input.decision === "CREATE_NEW") {
    if (!r.personId) throw new BadRequestError("This request predates person accounts; the person must sign in again to connect a record.");
    const uhid = await generateCandidateUhid(r.facilityId);
    const patient = await prisma.$transaction(async (tx) => {
      const patient = await createRegisteredPatient(tx, {
        uhid, facilityId: r.facilityId, fullName: r.claimedName, sex: r.claimedSex, phone: r.claimedPhone, dob: r.claimedDob, actorUserId: input.reviewerUserId,
      });
      await recordActiveLink(tx, { personId: r.personId!, patientId: patient.id, facilityId: r.facilityId, method: "SELF_CREATED", linkedByUserId: r.userId, linkRequestId: r.id });
      await tx.patientLinkRequest.update({ where: { id: r.id }, data: { status: "CREATED_NEW", otpHash: null, resolvedByUserId: input.reviewerUserId, resolvedAt: new Date(), reviewReason: input.note ?? r.reviewReason } });
      return patient;
    });
    await recordAuditEvent("patient.account.linkReviewed", input.reviewerUserId, { linkRequestId: r.id, decision: "CREATE_NEW", patientId: patient.id }, { facilityId: r.facilityId, patientId: patient.id });
    return { status: "CREATED_NEW" as const, patientId: patient.id };
  }
  await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { status: "REJECTED", otpHash: null, resolvedByUserId: input.reviewerUserId, resolvedAt: new Date(), reviewReason: input.note ?? r.reviewReason } });
  if (r.personId) await prisma.personAccessLogEntry.create({ data: { personId: r.personId, kind: "LINK_REFUSED", accessingFacilityId: r.facilityId, actorUserId: input.reviewerUserId, detail: { linkRequestId: r.id } } });
  await recordAuditEvent("patient.account.linkReviewed", input.reviewerUserId, { linkRequestId: r.id, decision: "REJECT" }, { facilityId: r.facilityId });
  return { status: "REJECTED" as const };
}
