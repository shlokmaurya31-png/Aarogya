/**
 * Patient self-registration: one Patient record per person, shared by the
 * patient portal and Hospital OS.
 *
 * A new PATIENT account is checked against the chosen facility's existing
 * records (duplicateDetection, never cross-facility). Records already linked
 * to an account are never linked; if only such records match, the request
 * goes to front-desk review rather than creating a second record silently.
 *   - No likely match: a new Patient is created and linked (as before).
 *   - A likely match: NOTHING is created or linked. A PatientLinkRequest is
 *     opened. If the matched record has a phone, a one-time code is sent to
 *     THAT phone (not one the registrant typed); entering it links the account
 *     to the record. With no phone on record, no SMS delivery, an expired
 *     code or too many wrong attempts, the request goes to front-desk review.
 *   - Front desk (patient:duplicate:review) links, creates a new record, or
 *     rejects.
 * A likely match is never auto-merged, and the registrant is never told
 * anything about the matched record beyond a masked phone number.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { Role, type PatientLinkRequest } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { generateCandidateUhid } from "@/lib/hospital/uhid";
import { sendSms, maskPhone } from "@/lib/messaging/sms";
import { findDuplicateCandidates } from "./duplicateDetection";
import { createRegisteredPatient } from "./registration";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

const OTP_TTL_MS = 10 * 60_000;
const MAX_OTP_ATTEMPTS = 5;

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
  | { status: "VERIFICATION_REQUIRED"; userId: string; maskedPhone: string }
  | { status: "PENDING_REVIEW"; userId: string };

function otpHash(requestId: string, code: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured.");
  return createHmac("sha256", secret).update(`${requestId}:${code}`).digest("hex");
}

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

  // Likely matches among this facility's records that no account owns yet.
  const candidates = await findDuplicateCandidates(facility.id, claimed);
  const owned = new Set(
    (await prisma.patient.findMany({ where: { id: { in: candidates.map((c) => c.patientId) }, userId: { not: null } }, select: { id: true } })).map((p) => p.id)
  );
  // Prefer a record no account owns. If every likely match is already owned,
  // don't quietly create a second record for the same person: review it.
  const best = candidates.find((c) => !owned.has(c.patientId)) ?? candidates[0];
  const bestOwned = best ? owned.has(best.patientId) : false;

  if (!best) {
    const uhid = await generateCandidateUhid(facility.id);
    const { user, patient } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: input.email, passwordHash: input.passwordHash, role: Role.PATIENT, displayName: input.fullName } });
      const patient = await createRegisteredPatient(tx, {
        uhid, facilityId: facility.id, fullName: input.fullName, sex: input.sex, phone: input.phone, dob: input.dob, userId: user.id, actorUserId: user.id,
      });
      return { user, patient };
    });
    await recordAuditEvent("patient.account.registered", user.id, { patientId: patient.id, facilityId: facility.id }, { facilityId: facility.id, patientId: patient.id });
    return { status: "LINKED_NEW", userId: user.id, patientId: patient.id };
  }

  const record = await prisma.patient.findUniqueOrThrow({ where: { id: best.patientId }, select: { phone: true } });
  const { user, request } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email: input.email, passwordHash: input.passwordHash, role: Role.PATIENT, displayName: input.fullName } });
    const request = await tx.patientLinkRequest.create({
      data: {
        userId: user.id, facilityId: facility.id, candidatePatientId: best.patientId,
        status: record.phone && !bestOwned ? "OTP_SENT" : "FRONT_DESK_REVIEW",
        reviewReason: bestOwned ? "the matched record already has an account" : record.phone ? null : "no phone on the matched record",
        matchConfidence: best.confidence, matchScore: best.score, matchedOn: best.matchedOn,
        claimedName: input.fullName, claimedPhone: input.phone, claimedDob: input.dob, claimedSex: input.sex,
      },
    });
    return { user, request };
  });
  await recordAuditEvent(
    "patient.account.linkRequested",
    user.id,
    { linkRequestId: request.id, confidence: best.confidence, matchedOn: best.matchedOn, route: request.status },
    { facilityId: facility.id }
  );

  if (record.phone && !bestOwned && (await issueOtp(request, record.phone))) {
    return { status: "VERIFICATION_REQUIRED", userId: user.id, maskedPhone: maskPhone(record.phone) };
  }
  return { status: "PENDING_REVIEW", userId: user.id };
}

/** Sends a fresh code to the record's phone; on failure the request goes to front-desk review. */
async function issueOtp(request: PatientLinkRequest, phone: string): Promise<boolean> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.patientLinkRequest.update({
    where: { id: request.id },
    data: { status: "OTP_SENT", otpHash: otpHash(request.id, code), otpExpiresAt: new Date(Date.now() + OTP_TTL_MS), otpAttempts: 0 },
  });
  const sent = await sendSms(phone, `Your Aarogya verification code is ${code}. It expires in 10 minutes. Never share it.`);
  if (sent.delivered) return true;
  await prisma.patientLinkRequest.update({ where: { id: request.id }, data: { status: "FRONT_DESK_REVIEW", otpHash: null, otpExpiresAt: null, reviewReason: "verification code could not be delivered" } });
  return false;
}

/** The caller's open link request, as the registrant may see it (no record details). */
export async function linkStatusFor(userId: string) {
  const r = await prisma.patientLinkRequest.findFirst({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { candidatePatient: { select: { phone: true } } } });
  if (!r) return null;
  return {
    status: r.status,
    maskedPhone: r.status === "OTP_SENT" && r.candidatePatient?.phone ? maskPhone(r.candidatePatient.phone) : null,
    expiresAt: r.status === "OTP_SENT" ? r.otpExpiresAt?.toISOString() ?? null : null,
  };
}

/** Links the caller's account to the matched record if `code` is right. */
export async function verifyLinkOtp(userId: string, code: string): Promise<{ status: "LINKED"; patientId: string } | { status: "INVALID"; attemptsLeft: number } | { status: "PENDING_REVIEW" }> {
  const r = await prisma.patientLinkRequest.findFirst({ where: { userId, status: "OTP_SENT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!r || !r.otpHash || !r.candidatePatientId) throw new NotFoundError("No verification is pending for this account.");
  if (!r.otpExpiresAt || r.otpExpiresAt.getTime() < Date.now()) {
    await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { status: "FRONT_DESK_REVIEW", otpHash: null, reviewReason: "verification code expired" } });
    return { status: "PENDING_REVIEW" };
  }
  const expected = Buffer.from(r.otpHash);
  const given = Buffer.from(otpHash(r.id, code.trim()));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    const attempts = r.otpAttempts + 1;
    if (attempts >= MAX_OTP_ATTEMPTS) {
      await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { otpAttempts: attempts, status: "FRONT_DESK_REVIEW", otpHash: null, reviewReason: "too many wrong codes" } });
      return { status: "PENDING_REVIEW" };
    }
    await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { otpAttempts: attempts } });
    return { status: "INVALID", attemptsLeft: MAX_OTP_ATTEMPTS - attempts };
  }
  const linked = await linkRecord(r, userId, null);
  if (!linked) return { status: "PENDING_REVIEW" };
  return { status: "LINKED", patientId: r.candidatePatientId };
}

/**
 * Links the record to the account, but only while no other account owns it.
 * If one does (claimed meanwhile), the request goes to front-desk review.
 */
async function linkRecord(r: PatientLinkRequest, userId: string, reviewerUserId: string | null): Promise<boolean> {
  const done = await prisma.$transaction(async (tx) => {
    const res = await tx.patient.updateMany({ where: { id: r.candidatePatientId!, userId: null, mergedIntoId: null }, data: { userId } });
    if (res.count !== 1) {
      await tx.patientLinkRequest.update({ where: { id: r.id }, data: { status: "FRONT_DESK_REVIEW", otpHash: null, reviewReason: "the record was linked to another account meanwhile" } });
      return false;
    }
    await tx.patientLinkRequest.update({ where: { id: r.id }, data: { status: "LINKED", otpHash: null, resolvedByUserId: reviewerUserId, resolvedAt: new Date() } });
    // Both paths that link (the patient's OTP, the front desk's LINK decision) come through here.
    await emitFacilityEvent(tx, {
      type: "PatientAccountLinked", aggregateId: r.candidatePatientId!, facilityId: r.facilityId, actorUserId: reviewerUserId ?? userId,
      payload: { patientId: r.candidatePatientId!, linkRequestId: r.id, portalUserId: userId, via: reviewerUserId ? "FRONT_DESK" : "OTP" },
    });
    return true;
  });
  if (done) {
    await recordAuditEvent(
      "patient.account.linked",
      reviewerUserId ?? userId,
      { linkRequestId: r.id, patientId: r.candidatePatientId, userId, via: reviewerUserId ? "front-desk" : "otp" },
      { facilityId: r.facilityId, patientId: r.candidatePatientId! }
    );
  }
  return done;
}

/** Front desk: open link requests of this facility, with what they need to decide. */
export async function listLinkRequests(facilityId: string) {
  return prisma.patientLinkRequest.findMany({
    where: { facilityId, status: { in: ["FRONT_DESK_REVIEW", "OTP_SENT"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true, status: true, reviewReason: true, matchConfidence: true, matchScore: true, matchedOn: true,
      claimedName: true, claimedPhone: true, claimedDob: true, claimedSex: true, createdAt: true,
      user: { select: { email: true } },
      candidatePatient: { select: { id: true, uhid: true, fullName: true, dob: true, sex: true, phone: true } },
    },
  });
}

/** Front desk decision. LINK: to the matched record. CREATE_NEW: a separate record. REJECT: neither. */
export async function decideLinkRequest(input: { facilityId: string; requestId: string; decision: "LINK" | "CREATE_NEW" | "REJECT"; reviewerUserId: string; note?: string }) {
  const r = await prisma.patientLinkRequest.findUnique({ where: { id: input.requestId } });
  if (!r || r.facilityId !== input.facilityId) throw new NotFoundError("Link request not found.");
  if (r.status !== "FRONT_DESK_REVIEW" && r.status !== "OTP_SENT") throw new ConflictError("This request has already been resolved.");

  if (input.decision === "LINK") {
    if (!r.candidatePatientId) throw new BadRequestError("This request has no matched record to link.");
    if (!(await linkRecord(r, r.userId, input.reviewerUserId))) throw new ConflictError("The record is already linked to another account.");
    return { status: "LINKED" as const, patientId: r.candidatePatientId };
  }
  if (input.decision === "CREATE_NEW") {
    const uhid = await generateCandidateUhid(r.facilityId);
    const patient = await prisma.$transaction(async (tx) => {
      const patient = await createRegisteredPatient(tx, {
        uhid, facilityId: r.facilityId, fullName: r.claimedName, sex: r.claimedSex, phone: r.claimedPhone, dob: r.claimedDob, userId: r.userId, actorUserId: input.reviewerUserId,
      });
      await tx.patientLinkRequest.update({ where: { id: r.id }, data: { status: "CREATED_NEW", otpHash: null, resolvedByUserId: input.reviewerUserId, resolvedAt: new Date(), reviewReason: input.note ?? r.reviewReason } });
      return patient;
    });
    await recordAuditEvent("patient.account.linkReviewed", input.reviewerUserId, { linkRequestId: r.id, decision: "CREATE_NEW", patientId: patient.id }, { facilityId: r.facilityId, patientId: patient.id });
    return { status: "CREATED_NEW" as const, patientId: patient.id };
  }
  await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { status: "REJECTED", otpHash: null, resolvedByUserId: input.reviewerUserId, resolvedAt: new Date(), reviewReason: input.note ?? r.reviewReason } });
  await recordAuditEvent("patient.account.linkReviewed", input.reviewerUserId, { linkRequestId: r.id, decision: "REJECT" }, { facilityId: r.facilityId });
  return { status: "REJECTED" as const };
}
