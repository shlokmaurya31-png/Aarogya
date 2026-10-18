import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { $Enums, type PatientLinkRequest, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { parseEnum } from "@/lib/enumValue";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { sendSms, maskPhone } from "@/lib/messaging/sms";
import { sendEmail } from "@/lib/email/send";
import { recordActiveLink } from "./person";
import { requireOwnedPerson } from "./access";
import { resolveEffectiveInternal } from "@/lib/config/resolver";

/**
 * Phase 0 — linking a facility record to a Person, and unlinking it
 * (docs/PERSON_IDENTITY_DESIGN.md §4–§5). A link becomes ACTIVE only after:
 *   (a) a phone code with a second factor: the record's phone was confirmed
 *       within 12 months, the person's date of birth OR the record's UHID
 *       matches the record exactly, and the code sent to THE RECORD'S phone
 *       is entered by the person;
 *   (b) ABHA verified on both sides through ABDM (behind a disabled flag; no
 *       path verifies an ABHA yet, so it cannot happen today);
 *   (c) in-person ID verification: one staff member records the ID type and
 *       its last 4 characters (never a full number) with a reason, a
 *       DIFFERENT staff member approves, and the person confirms in the app.
 * Never on a fuzzy match, and never by a front-desk decision. Every step is
 * audited at the facility and written to the person's access log; the person
 * is notified of every link and unlink.
 */

const OTP_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
export const PHONE_CONFIRMATION_MAX_AGE_MS = 365 * 86_400_000;
const LIVE_LINK: $Enums.PersonPatientLinkStatus[] = ["PENDING_VERIFICATION", "ACTIVE", "REVERIFICATION_REQUIRED"];

/** E.164-ish for Indian numbers: "+91 98765 43210" / "9876543210" → "+919876543210". */
export function normalizePhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  return `+${d}`;
}

export const ABHA_LINKING_ENABLED = () => process.env.PERSON_ABHA_LINKING === "enabled";

function codeHash(requestId: string, code: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured.");
  return createHmac("sha256", secret).update(`${requestId}:${code}`).digest("hex");
}

type PhoneFacts = { phone: string | null; phoneConfirmedAt: Date | null; phoneSetByStaffAt?: Date | null };
export const STAFF_PHONE_HOLD_DEFAULT_DAYS = 7;

/**
 * Can the record's phone receive a link code? Confirmed within 12 months,
 * and (insider-takeover fix) not set or changed by staff within the hold
 * (`holdMs`): a staff member can't point a record at their own phone and
 * link it to an account by code. In-person verification is unaffected.
 */
export function phoneUsable(p: PhoneFacts, holdMs = STAFF_PHONE_HOLD_DEFAULT_DAYS * 86_400_000, now = new Date()): boolean {
  if (!p.phone || !p.phoneConfirmedAt || now.getTime() - p.phoneConfirmedAt.getTime() > PHONE_CONFIRMATION_MAX_AGE_MS) return false;
  return !(p.phoneSetByStaffAt && now.getTime() - p.phoneSetByStaffAt.getTime() < holdMs);
}

/** The facility's staff-phone hold, in ms (identity.staff_phone_hold_days, capped at 90 by the registry). */
export async function staffPhoneHoldMs(facilityId: string): Promise<number> {
  const facility = await prisma.facility.findUnique({ where: { id: facilityId }, select: { organizationId: true } });
  if (!facility?.organizationId) return STAFF_PHONE_HOLD_DEFAULT_DAYS * 86_400_000;
  const eff = await resolveEffectiveInternal({ key: "identity.staff_phone_hold_days", organizationId: facility.organizationId, facilityId, fallbackRaw: String(STAFF_PHONE_HOLD_DEFAULT_DAYS) });
  return (typeof eff.value === "number" ? eff.value : STAFF_PHONE_HOLD_DEFAULT_DAYS) * 86_400_000;
}

/** Why the record's phone can't take a code, or null if it can. */
async function phoneBlock(p: PhoneFacts & { facilityId: string }): Promise<"NO_PHONE_ON_RECORD" | "PHONE_NOT_CONFIRMED" | "PHONE_RECENTLY_CHANGED" | null> {
  if (!p.phone) return "NO_PHONE_ON_RECORD";
  if (!phoneUsable({ ...p, phoneSetByStaffAt: null })) return "PHONE_NOT_CONFIRMED";
  return phoneUsable(p, await staffPhoneHoldMs(p.facilityId)) ? null : "PHONE_RECENTLY_CHANGED";
}

/**
 * Does this facility record already belong to a Person (a live link), or to a
 * pre-Phase-0 account? `exceptPersonId`: that person's own link awaiting
 * reverification (after the identity migration) doesn't count against them.
 */
export async function recordIsClaimed(patientId: string, exceptPersonId?: string | null): Promise<boolean> {
  const [live, legacy] = await Promise.all([
    prisma.personPatientLink.count({
      where: { patientId, status: { in: LIVE_LINK }, ...(exceptPersonId ? { NOT: { personId: exceptPersonId, status: "REVERIFICATION_REQUIRED" } } : {}) },
    }),
    prisma.patient.count({ where: { id: patientId, userId: { not: null } } }),
  ]);
  return live > 0 || legacy > 0;
}

/** Tells the person, without naming the facility or anything clinical. */
async function notifyPerson(personId: string, what: "LINKED" | "UNLINKED") {
  const acct = await prisma.personAccount.findFirst({ where: { personId, role: "OWNER", endedAt: null }, select: { user: { select: { email: true } } } });
  if (!acct?.user.email) return;
  await sendEmail({
    to: acct.user.email,
    subject: what === "LINKED" ? "A hospital record was connected to your Aarogya account" : "A hospital record was disconnected from your Aarogya account",
    text: `${what === "LINKED" ? "A hospital record was connected to" : "A hospital record was disconnected from"} your Aarogya account. Open the app to see which one and when. If this wasn't you, contact the hospital.`,
  }).catch(() => undefined);
}

async function logForPerson(tx: Prisma.TransactionClient, personId: string, kind: $Enums.PersonAccessLogKind, facilityId: string, actorUserId: string | null, detail: Record<string, string>) {
  await tx.personAccessLogEntry.create({ data: { personId, kind, accessingFacilityId: facilityId, actorUserId, detail } });
}

// ── Opening a request ───────────────────────────────────────────────────────

export type LinkRoute = "SECOND_FACTOR_REQUIRED" | "IN_PERSON_REQUIRED" | "FRONT_DESK_REVIEW";

/**
 * The route a likely match takes. A record another Person (or a pre-Phase-0
 * account) holds goes to front-desk review; a record with a phone confirmed
 * within 12 months asks for the second factor; anything else is in-person.
 */
export async function routeFor(candidate: { id: string; phone: string | null; phoneConfirmedAt: Date | null }, personId?: string | null): Promise<{ route: LinkRoute; reason: string | null }> {
  if (await recordIsClaimed(candidate.id, personId)) return { route: "FRONT_DESK_REVIEW", reason: "the matched record is already connected to an account" };
  const p = await prisma.patient.findUniqueOrThrow({ where: { id: candidate.id }, select: { phone: true, phoneConfirmedAt: true, phoneSetByStaffAt: true, facilityId: true } });
  const blocked = await phoneBlock(p);
  if (!blocked) return { route: "SECOND_FACTOR_REQUIRED", reason: null };
  return { route: "IN_PERSON_REQUIRED", reason: blocked };
}

/** The person's open request (latest first), or 404. */
async function openRequestFor(personId: string, statuses: $Enums.PatientLinkStatus[]): Promise<PatientLinkRequest> {
  const r = await prisma.patientLinkRequest.findFirst({ where: { personId, status: { in: statuses } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!r) throw new NotFoundError("No verification is pending for this account.");
  return r;
}

async function toInPerson(r: PatientLinkRequest, reason: string) {
  await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { status: "IN_PERSON_REQUIRED", otpHash: null, otpExpiresAt: null, reviewReason: reason } });
}

// ── (a) Phone code with a second factor ─────────────────────────────────────

/**
 * The person gives their date of birth or the UHID. It must match the record
 * exactly; then a code goes to the record's phone. A wrong factor counts as
 * a failed attempt (shared with wrong codes); after five the request moves
 * to in-person verification. The response never says which part was wrong.
 */
export async function submitSecondFactor(userId: string, input: { kind: string; value: string }) {
  const kind = parseEnum($Enums.PersonSecondFactor, input.kind, "kind");
  const personId = await requireOwnedPerson(userId);
  const r = await openRequestFor(personId, ["SECOND_FACTOR_REQUIRED"]);
  const record = await prisma.patient.findUniqueOrThrow({ where: { id: r.candidatePatientId! }, select: { id: true, uhid: true, dob: true, dobPrecision: true, phone: true, phoneConfirmedAt: true, phoneSetByStaffAt: true, facilityId: true } });
  const value = (input.value ?? "").trim();
  const ok = kind === "UHID"
    ? value.length > 0 && value === record.uhid
    : record.dobPrecision === "DAY" && Boolean(record.dob) && /^\d{4}-\d{2}-\d{2}$/.test(value) && record.dob!.toISOString().slice(0, 10) === value;
  if (!ok) {
    const attempts = r.otpAttempts + 1;
    await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { otpAttempts: attempts, secondFactor: kind, secondFactorOk: false } });
    await recordAuditEvent("patient.person.link.secondFactorFailed", userId, { linkRequestId: r.id, kind, attempts }, { facilityId: r.facilityId });
    if (attempts >= MAX_ATTEMPTS) {
      await toInPerson(r, "SECOND_FACTOR_UNAVAILABLE");
      return { status: "IN_PERSON_REQUIRED" as const };
    }
    return { status: "INVALID" as const, attemptsLeft: MAX_ATTEMPTS - attempts };
  }
  // The phone may have aged out, or been changed by staff, since the request opened.
  const blocked = await phoneBlock(record);
  if (blocked) {
    await toInPerson(r, blocked);
    return { status: "IN_PERSON_REQUIRED" as const };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.patientLinkRequest.update({
    where: { id: r.id },
    data: { status: "OTP_SENT", method: "OTP_RECORD_CONTACT", secondFactor: kind, secondFactorOk: true, otpHash: codeHash(r.id, code), otpExpiresAt: new Date(Date.now() + OTP_TTL_MS) },
  });
  const sent = await sendSms(record.phone!, `Your Aarogya verification code is ${code}. It expires in 10 minutes. Never share it.`);
  if (!sent.delivered) {
    await toInPerson(r, "PHONE_UNREACHABLE");
    return { status: "IN_PERSON_REQUIRED" as const };
  }
  await recordAuditEvent("patient.person.link.codeSent", userId, { linkRequestId: r.id, to: maskPhone(record.phone!) }, { facilityId: r.facilityId });
  return { status: "CODE_SENT" as const, maskedPhone: maskPhone(record.phone!) };
}

/**
 * The code sent to the record's phone. Accepted only after the second factor
 * matched. Correct: the link becomes ACTIVE (OTP_RECORD_CONTACT) and the
 * record's phone counts as confirmed now.
 */
export async function verifyLinkCode(userId: string, code: string) {
  const personId = await requireOwnedPerson(userId);
  const r = await openRequestFor(personId, ["OTP_SENT"]);
  if (!r.otpHash || !r.candidatePatientId || r.secondFactorOk !== true) throw new NotFoundError("No verification is pending for this account.");
  if (!r.otpExpiresAt || r.otpExpiresAt.getTime() < Date.now()) {
    await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { status: "SECOND_FACTOR_REQUIRED", otpHash: null, otpExpiresAt: null, secondFactorOk: null, reviewReason: "verification code expired" } });
    return { status: "EXPIRED" as const };
  }
  // A staff phone change after the code went out voids it (insider-takeover fix).
  const rec = await prisma.patient.findUniqueOrThrow({ where: { id: r.candidatePatientId }, select: { phone: true, phoneConfirmedAt: true, phoneSetByStaffAt: true, facilityId: true } });
  const blocked = await phoneBlock(rec);
  if (blocked) {
    await toInPerson(r, blocked);
    return { status: "IN_PERSON_REQUIRED" as const };
  }
  const expected = Buffer.from(r.otpHash);
  const given = Buffer.from(codeHash(r.id, String(code ?? "").trim()));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    const attempts = r.otpAttempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { otpAttempts: attempts } });
      await toInPerson(r, "SECOND_FACTOR_UNAVAILABLE");
      return { status: "IN_PERSON_REQUIRED" as const };
    }
    await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { otpAttempts: attempts } });
    return { status: "INVALID" as const, attemptsLeft: MAX_ATTEMPTS - attempts };
  }
  const linked = await completeLink(r, personId, userId, "OTP_RECORD_CONTACT", async (tx) => {
    await tx.patient.update({ where: { id: r.candidatePatientId! }, data: { phoneConfirmedAt: new Date() } });
    // The person just proved control of this phone: it becomes their verified
    // contact, unless another Person already holds it as verified (then not).
    const phone = rec.phone ? normalizePhone(rec.phone) : null;
    if (phone && !(await tx.personContact.findFirst({ where: { kind: "PHONE", value: phone, status: "ACTIVE", verifiedAt: { not: null } } }))) {
      await tx.personContact.create({ data: { personId, kind: "PHONE", value: phone, verifiedAt: new Date() } });
    }
  });
  if (!linked) return { status: "PENDING_REVIEW" as const };
  return { status: "LINKED" as const, patientId: r.candidatePatientId };
}

/**
 * Makes the link ACTIVE for a request, but only while no other Person holds
 * the record (the partial unique index decides a race). If one does, the
 * request goes to front-desk review.
 */
async function completeLink(r: PatientLinkRequest, personId: string, userId: string, method: "OTP_RECORD_CONTACT" | "ABHA_BOTH_VERIFIED", extra?: (tx: Prisma.TransactionClient) => Promise<void>): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      const p = await tx.patient.findUnique({ where: { id: r.candidatePatientId! }, select: { mergedIntoId: true, userId: true } });
      if (!p || p.mergedIntoId || (p.userId && p.userId !== userId)) throw new ConflictError("claimed");
      const done = await tx.patientLinkRequest.updateMany({ where: { id: r.id, status: r.status }, data: { status: "LINKED", otpHash: null, resolvedAt: new Date() } });
      if (done.count !== 1) throw new ConflictError("claimed");
      await recordActiveLink(tx, { personId, patientId: r.candidatePatientId!, facilityId: r.facilityId, method, linkedByUserId: userId, linkRequestId: r.id });
      if (extra) await extra(tx);
    });
  } catch (err) {
    const unique = (err as { code?: string }).code === "P2002";
    if (!(err instanceof ConflictError) && !unique) throw err;
    await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { status: "FRONT_DESK_REVIEW", otpHash: null, reviewReason: "the record was connected to another account meanwhile" } });
    return false;
  }
  await recordAuditEvent("patient.person.link.linked", userId, { linkRequestId: r.id, patientId: r.candidatePatientId, personId, method }, { facilityId: r.facilityId, patientId: r.candidatePatientId! });
  await notifyPerson(personId, "LINKED");
  return true;
}

// ── Reverification (links the identity migration couldn't trust) ────────────

/**
 * The person verifies a link the identity migration marked
 * REVERIFICATION_REQUIRED: the same routes as a new link (second factor +
 * code to the record's phone, or in person). Verifying makes it ACTIVE.
 */
export async function startReverification(userId: string, linkId: string) {
  const personId = await requireOwnedPerson(userId);
  const link = await prisma.personPatientLink.findUnique({ where: { id: linkId }, include: { person: { select: { displayName: true, sex: true } }, patient: { select: { id: true, phone: true, phoneConfirmedAt: true, sex: true } } } });
  if (!link || link.personId !== personId) throw new NotFoundError();
  if (link.status !== "REVERIFICATION_REQUIRED") throw new ConflictError("This connection doesn't need verifying.");
  const open = await prisma.patientLinkRequest.findFirst({ where: { personId, candidatePatientId: link.patientId, status: { in: ["SECOND_FACTOR_REQUIRED", "OTP_SENT", "IN_PERSON_REQUIRED", "FRONT_DESK_REVIEW"] } } });
  if (open) return { requestId: open.id, status: open.status };
  const { route, reason } = await routeFor(link.patient, personId);
  const request = await prisma.patientLinkRequest.create({
    data: {
      userId, personId, facilityId: link.facilityId, candidatePatientId: link.patientId, status: route, reviewReason: reason ?? "reverification after the identity migration",
      initiatedBy: "PERSON", method: route === "SECOND_FACTOR_REQUIRED" ? "OTP_RECORD_CONTACT" : route === "IN_PERSON_REQUIRED" ? "IN_PERSON_ID" : null,
      matchConfidence: "REVERIFY", matchScore: 0, matchedOn: [], claimedName: link.person.displayName, claimedSex: link.person.sex ?? link.patient.sex,
    },
  });
  await recordAuditEvent("patient.person.link.requested", userId, { linkRequestId: request.id, linkId, route, reverification: true }, { facilityId: link.facilityId, patientId: link.patientId });
  return { requestId: request.id, status: route };
}

// ── (c) In-person ID verification ───────────────────────────────────────────

const ID_LAST4 = /^[A-Za-z0-9]{4}$/;

/**
 * Staff member A: checked a government ID against the record and the person
 * (who is present). Stores the ID type and its last 4 characters only — a
 * full number (anything that isn't exactly 4 letters or digits) is refused,
 * never truncated. Creates a PENDING_VERIFICATION link awaiting a second
 * staff member and then the person.
 */
export async function startInPersonVerification(input: { facilityId: string; requestId: string; staffId: string; byUserId: string; idType: string; idLast4: string; reason: string }) {
  const idType = parseEnum($Enums.PersonIdDocumentType, input.idType, "idType");
  const reason = parseEnum($Enums.PersonInPersonReason, input.reason, "reason");
  if (typeof input.idLast4 !== "string" || !ID_LAST4.test(input.idLast4)) {
    throw new BadRequestError("Enter only the last 4 characters of the ID. Never enter or store the full number.");
  }
  const r = await prisma.patientLinkRequest.findUnique({ where: { id: input.requestId } });
  if (!r || r.facilityId !== input.facilityId) throw new NotFoundError("Link request not found.");
  if (!["IN_PERSON_REQUIRED", "FRONT_DESK_REVIEW", "SECOND_FACTOR_REQUIRED"].includes(r.status)) throw new ConflictError("This request has already been resolved.");
  if (!r.candidatePatientId || !r.personId) throw new BadRequestError("This request has no matched record or person.");
  if (await recordIsClaimed(r.candidatePatientId, r.personId)) throw new ConflictError("The record is already connected to an account.");
  const inPerson = { method: "IN_PERSON_ID" as const, linkRequestId: r.id, idType, idLast4: input.idLast4, inPersonReason: reason, verifiedByStaffId: input.staffId };
  // The person's own link awaiting reverification is verified in place.
  const pending = await prisma.personPatientLink.findFirst({ where: { personId: r.personId, patientId: r.candidatePatientId, status: "REVERIFICATION_REQUIRED" } });
  let link;
  try {
    link = pending
      ? await prisma.personPatientLink.update({ where: { id: pending.id }, data: { ...inPerson, status: "PENDING_VERIFICATION", version: { increment: 1 } } })
      : await prisma.personPatientLink.create({ data: { personId: r.personId, patientId: r.candidatePatientId, facilityId: r.facilityId, status: "PENDING_VERIFICATION", ...inPerson } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ConflictError("A verification for this record is already in progress.");
    throw err;
  }
  await prisma.patientLinkRequest.update({ where: { id: r.id }, data: { method: "IN_PERSON_ID", status: "IN_PERSON_REQUIRED", otpHash: null } });
  await recordAuditEvent("patient.person.link.inPersonStarted", input.byUserId, { linkRequestId: r.id, linkId: link.id, idType, reason, staffId: input.staffId }, { facilityId: r.facilityId, patientId: r.candidatePatientId });
  return { linkId: link.id, status: link.status };
}

/** Staff member B (never A) approves the in-person verification. The person still confirms. */
export async function approveInPersonVerification(input: { facilityId: string; linkId: string; staffId: string; byUserId: string }) {
  const link = await prisma.personPatientLink.findUnique({ where: { id: input.linkId } });
  if (!link || link.facilityId !== input.facilityId || link.method !== "IN_PERSON_ID") throw new NotFoundError("Verification not found.");
  if (link.status !== "PENDING_VERIFICATION" || link.approvedByStaffId) throw new ConflictError("This verification has already been decided.");
  if (link.verifiedByStaffId === input.staffId) throw new BadRequestError("A second, different staff member must approve.");
  const r = await prisma.personPatientLink.updateMany({ where: { id: link.id, status: "PENDING_VERIFICATION", approvedByStaffId: null, version: link.version }, data: { approvedByStaffId: input.staffId, version: { increment: 1 } } });
  if (r.count !== 1) throw new ConflictError("This verification changed concurrently. Refresh and try again.");
  await recordAuditEvent("patient.person.link.inPersonApproved", input.byUserId, { linkId: link.id, verifiedByStaffId: link.verifiedByStaffId, approvedByStaffId: input.staffId }, { facilityId: link.facilityId, patientId: link.patientId });
  return { linkId: link.id, awaiting: "PERSON_CONFIRMATION" as const };
}

/** The links waiting for this person's confirmation (in-person or ABHA), without the ID digits. */
export async function pendingConfirmations(userId: string) {
  const personId = await requireOwnedPerson(userId);
  const links = await prisma.personPatientLink.findMany({
    where: { personId, status: "PENDING_VERIFICATION", OR: [{ method: "IN_PERSON_ID", approvedByStaffId: { not: null } }, { method: "ABHA_BOTH_VERIFIED" }] },
    select: { id: true, method: true, createdAt: true, facility: { select: { id: true, name: true } } },
  });
  return links.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() }));
}

/** The person confirms ("Connect your record at …?"): the link becomes ACTIVE. */
export async function confirmPendingLink(userId: string, linkId: string) {
  const personId = await requireOwnedPerson(userId);
  const link = await prisma.personPatientLink.findUnique({ where: { id: linkId } });
  if (!link || link.personId !== personId) throw new NotFoundError();
  if (link.status !== "PENDING_VERIFICATION") throw new ConflictError("This connection has already been decided.");
  if (link.method === "IN_PERSON_ID" && !link.approvedByStaffId) throw new ConflictError("A second staff member hasn't approved this yet.");
  if (link.method === "ABHA_BOTH_VERIFIED" && !ABHA_LINKING_ENABLED()) throw new BadRequestError("ABHA linking is not available.");
  await prisma.$transaction(async (tx) => {
    const p = await tx.patient.findUnique({ where: { id: link.patientId }, select: { mergedIntoId: true, userId: true } });
    if (!p || p.mergedIntoId || (p.userId && p.userId !== userId)) throw new ConflictError("The record is already connected to an account.");
    const r = await tx.personPatientLink.updateMany({
      where: { id: link.id, status: "PENDING_VERIFICATION", version: link.version },
      data: { status: "ACTIVE", linkedAt: new Date(), linkedByUserId: userId, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ConflictError("This connection changed concurrently. Refresh and try again.");
    if (link.linkRequestId) await tx.patientLinkRequest.updateMany({ where: { id: link.linkRequestId }, data: { status: "LINKED", resolvedAt: new Date() } });
    await logForPerson(tx, personId, "LINKED", link.facilityId, userId, { linkId: link.id, method: link.method! });
    await emitFacilityEvent(tx, {
      type: "PersonPatientLinked", aggregateId: link.id, facilityId: link.facilityId, personId, actorUserId: userId,
      payload: { linkId: link.id, personId, patientId: link.patientId, method: link.method! },
    });
  });
  await recordAuditEvent("patient.person.link.linked", userId, { linkId: link.id, personId, method: link.method, verifiedByStaffId: link.verifiedByStaffId, approvedByStaffId: link.approvedByStaffId }, { facilityId: link.facilityId, patientId: link.patientId });
  await notifyPerson(personId, "LINKED");
  return { status: "LINKED" as const, patientId: link.patientId };
}

// ── (b) ABHA, behind a disabled flag ────────────────────────────────────────

const ABHA_SYSTEM = "https://healthid.abdm.gov.in";

/**
 * Offers a link when the person's ABDM-verified ABHA equals the facility
 * record's ABDM-verified ABHA. Disabled unless PERSON_ABHA_LINKING=enabled,
 * and even then only VERIFIED-via-ABDM identifiers count (no path sets that
 * yet). The person still confirms (confirmPendingLink).
 */
export async function offerAbhaLink(userId: string, facilityId: string) {
  if (!ABHA_LINKING_ENABLED()) throw new BadRequestError("ABHA linking is not available.");
  const personId = await requireOwnedPerson(userId);
  const mine = await prisma.personIdentifier.findMany({ where: { personId, system: "ABHA_NUMBER", verificationStatus: "VERIFIED", verifiedVia: "ABDM_AUTH" }, select: { valueHash: true } });
  if (mine.length === 0) throw new NotFoundError("No verified ABHA on your account.");
  const theirs = await prisma.externalIdentifier.findMany({ where: { facilityId, entityType: "PATIENT", system: ABHA_SYSTEM, status: "ACTIVE", verificationStatus: "VERIFIED" }, select: { entityId: true, value: true } });
  const hashes = new Set(mine.map((m) => m.valueHash));
  const match = theirs.find((t) => hashes.has(createHash("sha256").update(t.value.replace(/\D/g, "")).digest("hex")));
  if (!match) throw new NotFoundError("No record at this facility carries your verified ABHA.");
  if (await recordIsClaimed(match.entityId)) throw new ConflictError("The record is already connected to an account.");
  const link = await prisma.personPatientLink.create({ data: { personId, patientId: match.entityId, facilityId, status: "PENDING_VERIFICATION", method: "ABHA_BOTH_VERIFIED" } });
  return { linkId: link.id, awaiting: "PERSON_CONFIRMATION" as const };
}

// ── Unlinking ───────────────────────────────────────────────────────────────

async function finishUnlink(link: { id: string; personId: string; patientId: string; facilityId: string; version: number }, data: Prisma.PersonPatientLinkUpdateManyMutationInput, by: $Enums.PersonUnlinkActor, reason: $Enums.PersonUnlinkReason, actorUserId: string) {
  await prisma.$transaction(async (tx) => {
    const r = await tx.personPatientLink.updateMany({
      where: { id: link.id, status: "ACTIVE", version: link.version },
      data: { ...data, status: "UNLINKED", unlinkedAt: new Date(), unlinkedBy: by, unlinkedReason: reason, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ConflictError("This connection changed concurrently. Refresh and try again.");
    await logForPerson(tx, link.personId, "UNLINKED", link.facilityId, actorUserId, { linkId: link.id, by, reason });
    await emitFacilityEvent(tx, {
      type: "PersonPatientUnlinked", aggregateId: link.id, facilityId: link.facilityId, personId: link.personId, actorUserId,
      payload: { linkId: link.id, personId: link.personId, patientId: link.patientId, by, reason },
    });
  });
  await recordAuditEvent("patient.person.link.unlinked", actorUserId, { linkId: link.id, personId: link.personId, by, reason }, { facilityId: link.facilityId, patientId: link.patientId });
  await notifyPerson(link.personId, "UNLINKED");
}

/** The person disconnects a facility record, any time. Nothing clinical is deleted on either side. */
export async function unlinkByPerson(userId: string, linkId: string) {
  const personId = await requireOwnedPerson(userId);
  const link = await prisma.personPatientLink.findUnique({ where: { id: linkId } });
  if (!link || link.personId !== personId) throw new NotFoundError();
  if (link.status !== "ACTIVE") throw new ConflictError("This record isn't connected.");
  await finishUnlink(link, { unlinkedByUserId: userId }, "PERSON", "PERSON_REQUEST", userId);
  return { status: "UNLINKED" as const };
}

/** Staff member A asks to unlink (wrong person, or a security incident); B must approve. */
export async function requestFacilityUnlink(input: { facilityId: string; linkId: string; reason: string; byUserId: string }) {
  const reason = parseEnum($Enums.PersonUnlinkReason, input.reason, "reason");
  if (reason !== "WRONG_PERSON" && reason !== "SECURITY") throw new BadRequestError("A facility can unlink for WRONG_PERSON or SECURITY.");
  const link = await prisma.personPatientLink.findUnique({ where: { id: input.linkId } });
  if (!link || link.facilityId !== input.facilityId) throw new NotFoundError("Link not found.");
  if (link.status !== "ACTIVE") throw new ConflictError("This record isn't connected.");
  if (link.unlinkRequestedAt) throw new ConflictError("An unlink is already waiting for approval.");
  const r = await prisma.personPatientLink.updateMany({ where: { id: link.id, status: "ACTIVE", version: link.version, unlinkRequestedAt: null }, data: { unlinkRequestedByUserId: input.byUserId, unlinkRequestedAt: new Date(), unlinkRequestedReason: reason, version: { increment: 1 } } });
  if (r.count !== 1) throw new ConflictError("This connection changed concurrently. Refresh and try again.");
  await recordAuditEvent("patient.person.link.unlinkRequested", input.byUserId, { linkId: link.id, reason }, { facilityId: link.facilityId, patientId: link.patientId });
  return { linkId: link.id, awaiting: "SECOND_STAFF_APPROVAL" as const };
}

/** Staff member B (never A) approves the facility unlink; the person is notified. */
export async function approveFacilityUnlink(input: { facilityId: string; linkId: string; byUserId: string }) {
  const link = await prisma.personPatientLink.findUnique({ where: { id: input.linkId } });
  if (!link || link.facilityId !== input.facilityId) throw new NotFoundError("Link not found.");
  if (link.status !== "ACTIVE" || !link.unlinkRequestedAt || !link.unlinkRequestedByUserId || !link.unlinkRequestedReason) throw new ConflictError("No unlink is waiting for approval.");
  if (link.unlinkRequestedByUserId === input.byUserId) throw new BadRequestError("A second, different staff member must approve.");
  await finishUnlink(link, { unlinkedByUserId: link.unlinkRequestedByUserId, unlinkApprovedByUserId: input.byUserId }, "FACILITY", link.unlinkRequestedReason, input.byUserId);
  return { status: "UNLINKED" as const };
}

// ── Phone changes notify the previous contact ───────────────────────────────

/**
 * Every phone change on a record, by staff or by the patient, tells the
 * previous number, with no clinical or facility detail (insider-takeover fix).
 */
export async function notifyPreviousPhone(input: { patientId: string; facilityId: string; previousPhone: string | null; changedBy: "STAFF" | "PATIENT"; byUserId: string }) {
  if (!input.previousPhone) return;
  const sent = await sendSms(input.previousPhone, "The phone number on your hospital record with Aarogya was changed. If you didn't ask for this, contact the hospital.").catch(() => ({ delivered: false as const }));
  await recordAuditEvent("patient.contact.changeNotified", input.byUserId, { patientId: input.patientId, changedBy: input.changedBy, to: maskPhone(input.previousPhone), delivered: sent.delivered }, { facilityId: input.facilityId, patientId: input.patientId });
}

// ── Contact confirmation ────────────────────────────────────────────────────

/**
 * Staff confirm the phone on the record with the patient present (check-in,
 * the desk). Only this, a staff phone entry, or a correct link code counts as
 * "confirmed" for the 12-month rule.
 */
export async function confirmPatientContact(input: { facilityId: string; patientId: string; byUserId: string }) {
  const patient = await prisma.patient.findUnique({ where: { id: input.patientId }, select: { id: true, facilityId: true, phone: true } });
  if (!patient || patient.facilityId !== input.facilityId) throw new NotFoundError("Patient not found.");
  if (!patient.phone) throw new BadRequestError("There is no phone on this record to confirm.");
  await prisma.$transaction(async (tx) => {
    await tx.patient.update({ where: { id: patient.id }, data: { phoneConfirmedAt: new Date() } });
    await emitFacilityEvent(tx, {
      type: "PatientContactConfirmed", aggregateId: patient.id, facilityId: patient.facilityId, actorUserId: input.byUserId,
      payload: { patientId: patient.id, contact: "PHONE", via: "STAFF_IN_PERSON" },
    });
  });
  await recordAuditEvent("patient.contact.confirmed", input.byUserId, { patientId: patient.id, contact: "PHONE" }, { facilityId: patient.facilityId, patientId: patient.id });
  return { patientId: patient.id, phoneConfirmedAt: new Date().toISOString() };
}
