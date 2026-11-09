import { createHash, createHmac, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { createRegisteredPatient } from "@/lib/patient/registration";
import { generateCandidateUhid } from "@/lib/hospital/uhid";
import { dayKey, facilityTimeZone } from "@/lib/time/zone";
import { requireOwnedPerson } from "@/lib/person/access";
import { scanShareGateway, type AbdmProfileShare, type ScanShareGateway } from "@/lib/hospital/interoperability/abdm/scanShare";

/**
 * Flagship 6 — Scan and Share check-in (docs/ABDM_CERTIFICATION_PLAN.md §8).
 *
 *   Counters     the hospital admin names its counters; each has a QR
 *                (the facility's HIP id and the counter) the desk shows.
 *   The share    the HIP side (receiveProfileShare) takes a profile from the
 *                ABDM adapter: one check-in per gateway request; the ABHA
 *                verified (verify-only); the facility record matched only by
 *                an exact, verified ABHA number; a token for the day in the
 *                facility's zone; the on-share answer. A known record goes
 *                straight into the registration queue; an unknown one waits
 *                for the desk, who registers it from the shared profile (the
 *                patient fills in no form). An Aadhaar number is never stored:
 *                a profile carrying one is refused whole.
 *   The patient  in the Aarogya app (standing in for the PHR app until it is
 *                certified, §7.1) scans the QR, confirms the ABHA, and gets
 *                the token.
 */

type Tx = Prisma.TransactionClient;
const ABHA_SYSTEM = "https://healthid.abdm.gov.in";
/** 12 digits, with or without spaces or dashes: what an Aadhaar number looks like. */
const AADHAAR_LIKE = /(^|\D)\d{4}[\s-]?\d{4}[\s-]?\d{4}(\D|$)/;

function qrSecret() {
  return process.env.SCAN_SHARE_QR_SECRET || process.env.SESSION_SECRET || "aarogya-scan-share-dev";
}
/** The QR's signature: the counter can't be made up or changed by hand. */
export function qrSignature(hipId: string, counterCode: string) {
  return createHmac("sha256", qrSecret()).update(`${hipId}:${counterCode}`).digest("base64url").slice(0, 16);
}

// ── Counters and their QR ───────────────────────────────────────────────────

export async function createCounter(admin: { userId: string; facilityId: string }, body: { code?: unknown; label?: unknown }) {
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase().slice(0, 20) : "";
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
  if (!/^[A-Z0-9-]{2,20}$/.test(code) || !label) throw new BadRequestError("A counter needs a code (letters, digits, dashes) and a label.");
  try {
    return await prisma.$transaction(async (tx) => {
      const c = await tx.scanShareCounter.create({ data: { facilityId: admin.facilityId, code, label, createdByUserId: admin.userId } });
      await emitFacilityEvent(tx, { type: "ScanShareCounterCreated", aggregateId: c.id, facilityId: admin.facilityId, actorUserId: admin.userId, payload: { counterId: c.id, code } });
      return c;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new ConflictError("This facility already has a counter with that code.");
    throw e;
  }
}

/** The facility's active counters, each with its QR (the link a phone opens, and its SVG). */
export async function countersWithQr(facilityId: string, origin: string) {
  const counters = await prisma.scanShareCounter.findMany({ where: { facilityId, active: true }, orderBy: { code: "asc" } });
  return Promise.all(counters.map(async (c) => {
    const url = `${origin.replace(/\/$/, "")}/patient/scan?hip=${encodeURIComponent(facilityId)}&counter=${encodeURIComponent(c.code)}&sig=${qrSignature(facilityId, c.code)}`;
    return { id: c.id, code: c.code, label: c.label, url, svg: await QRCode.toString(url, { type: "svg", margin: 1, width: 192 }) };
  }));
}

async function counterFor(hipId: string, counterCode: string) {
  const c = await prisma.scanShareCounter.findUnique({ where: { facilityId_code: { facilityId: hipId, code: counterCode } } });
  if (!c || !c.active) throw new NotFoundError("This counter isn't taking Scan and Share check-ins.");
  return c;
}

// ── The HIP side: a shared profile ──────────────────────────────────────────

async function nextToken(tx: Tx, facilityId: string, tokenDay: string) {
  const n = await tx.scanShareCheckIn.count({ where: { facilityId, tokenDay } });
  return `S-${String(n + 1).padStart(3, "0")}`;
}

function normalizedPhone(raw: string | null) {
  const m = raw ? /^(?:\+?91)?([6-9]\d{9})$/.exec(raw.replace(/[\s()-]/g, "")) : null;
  return m ? `+91${m[1]}` : null;
}

/**
 * The profile the adapter delivered. Refused whole (nothing stored) when it
 * names an unknown counter, carries an Aadhaar-like number, lacks a name or
 * sex, or its ABHA doesn't verify. A request seen before answers the same.
 */
export async function receiveProfileShare(share: AbdmProfileShare, gateway: ScanShareGateway = scanShareGateway(), opts: { personId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const p = share.profile;
  // Never an Aadhaar number, anywhere in what we keep. The ABHA number (14 digits) is checked on its own,
  // and the phone is kept only as a valid Indian mobile (+91 and 10 digits), else not at all.
  const phone = normalizedPhone(p.phoneNumber);
  if ([p.name, p.abhaAddress, share.counterId, share.hipId].some((f) => AADHAAR_LIKE.test(f)) || (p.phoneNumber && !phone && AADHAAR_LIKE.test(p.phoneNumber))) throw new BadRequestError("The shared profile carries an Aadhaar-like number; Aarogya never stores one. Nothing was kept.");
  const abhaNumberDigits = p.abhaNumber ? p.abhaNumber.replace(/\D/g, "") : null;
  if (abhaNumberDigits !== null && !/^\d{14}$/.test(abhaNumberDigits)) throw new BadRequestError("An ABHA number has 14 digits. Nothing was kept.");
  if (!p.name.trim() || !["M", "F", "O"].includes(p.gender) || !p.abhaAddress.trim()) throw new BadRequestError("The shared profile needs a name, sex and ABHA address.");
  const counter = await counterFor(share.hipId, share.counterId);
  const again = await prisma.scanShareCheckIn.findUnique({ where: { facilityId_requestId: { facilityId: counter.facilityId, requestId: share.requestId } } });
  if (again) return { checkInId: again.id, token: again.token, status: again.status, matched: Boolean(again.patientId), replayed: true };

  const verified = await gateway.verifyAbha({ abhaAddress: p.abhaAddress, abhaNumber: abhaNumberDigits });
  if (!verified.verified) throw new ConflictError("The ABHA couldn't be verified with ABDM, so the profile wasn't shared.");
  const abhaNumber = verified.abhaNumber;
  // The facility record only by an exact, verified ABHA number (never by name, birth date or phone).
  const ids = await prisma.externalIdentifier.findMany({ where: { facilityId: counter.facilityId, entityType: "PATIENT", system: ABHA_SYSTEM, status: "ACTIVE", verificationStatus: "VERIFIED" }, select: { entityId: true, value: true } });
  const matches = [...new Set(ids.filter((i) => i.value.replace(/\D/g, "") === abhaNumber).map((i) => i.entityId))];
  const patientId = matches.length === 1 ? matches[0] : null;
  const tokenDay = dayKey(now, await facilityTimeZone(prisma, counter.facilityId));
  const dob = p.yearOfBirth && p.monthOfBirth && p.dayOfBirth ? new Date(Date.UTC(p.yearOfBirth, p.monthOfBirth - 1, p.dayOfBirth)) : null;

  for (let attempt = 0; ; attempt++) {
    try {
      const out = await prisma.$transaction(async (tx) => {
        const ci = await tx.scanShareCheckIn.create({
          data: {
            facilityId: counter.facilityId, counterId: counter.id, requestId: share.requestId, gateway: gateway.mode, abhaAddress: p.abhaAddress.trim().toLowerCase(),
            abhaNumberHash: createHash("sha256").update(abhaNumber).digest("hex"), abhaNumberLast4: abhaNumber.slice(-4),
            name: p.name.trim().slice(0, 200), sex: p.gender, yearOfBirth: p.yearOfBirth, dob, phone,
            token: await nextToken(tx, counter.facilityId, tokenDay), tokenDay, patientId,
          },
        });
        let queueEntryId: string | null = null;
        if (patientId) queueEntryId = (await queueTx(tx, ci.id, counter.facilityId, patientId, counter.departmentId, null, now)).queueEntryId;
        await emitFacilityEvent(tx, { type: "ScanShareReceived", aggregateId: ci.id, facilityId: counter.facilityId, payload: { checkInId: ci.id, counterId: counter.id, matched: Boolean(patientId), gateway: gateway.mode, ...(patientId ? { patientId } : {}) } });
        return { checkInId: ci.id, token: ci.token, status: patientId ? ("QUEUED" as const) : ("WAITING" as const), matched: Boolean(patientId), queueEntryId, replayed: false };
      });
      await gateway.acknowledgeShare({ requestId: share.requestId, hipId: share.hipId, counterId: share.counterId, abhaAddress: p.abhaAddress, tokenNumber: out.token, expiresAt: new Date(now.getTime() + 4 * 3_600_000).toISOString() });
      return out;
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002" || attempt >= 4) throw e;
      // The same request at once (answer what it recorded), or the token taken: try again.
      const dup = await prisma.scanShareCheckIn.findUnique({ where: { facilityId_requestId: { facilityId: counter.facilityId, requestId: share.requestId } } });
      if (dup) return { checkInId: dup.id, token: dup.token, status: dup.status, matched: Boolean(dup.patientId), replayed: true };
    }
  }
}

/** Into the registration queue (a QueueEntry), with its event. */
async function queueTx(tx: Tx, checkInId: string, facilityId: string, patientId: string, departmentId: string | null, byUserId: string | null, now: Date) {
  const q = await tx.queueEntry.create({ data: { facilityId, departmentId, queueType: "REGISTRATION", patientId, priorityReason: "Scan and Share" } });
  const u = await tx.scanShareCheckIn.updateMany({ where: { id: checkInId, status: { not: "CANCELLED" } }, data: { status: "QUEUED", patientId, queueEntryId: q.id, queuedAt: now, queuedByUserId: byUserId } });
  if (u.count !== 1) throw new ConflictError("This check-in changed in the meantime.");
  await emitFacilityEvent(tx, { type: "ScanShareQueued", aggregateId: checkInId, facilityId, actorUserId: byUserId, payload: { checkInId, patientId, queueEntryId: q.id } });
  return { queueEntryId: q.id };
}

// ── The desk ────────────────────────────────────────────────────────────────

/** The day's Scan and Share check-ins (default: the facility's today), by token. */
export async function deskQueue(facilityId: string, day?: string) {
  const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : dayKey(new Date(), await facilityTimeZone(prisma, facilityId));
  const rows = await prisma.scanShareCheckIn.findMany({ where: { facilityId, tokenDay: d }, orderBy: { token: "asc" }, include: { counter: { select: { label: true } } }, take: 300 });
  const patients = new Map((await prisma.patient.findMany({ where: { id: { in: rows.map((r) => r.patientId).filter((x): x is string => !!x) }, facilityId }, select: { id: true, uhid: true } })).map((p) => [p.id, p.uhid]));
  return {
    day: d,
    checkIns: rows.map((r) => ({
      id: r.id, token: r.token, status: r.status, counter: r.counter.label, name: r.name, sex: r.sex, yearOfBirth: r.yearOfBirth, phoneLast4: r.phone ? r.phone.slice(-4) : null,
      abhaAddress: r.abhaAddress, abhaLast4: r.abhaNumberLast4, uhid: r.patientId ? patients.get(r.patientId) ?? null : null, at: r.createdAt.toISOString(),
    })),
  };
}

/**
 * The desk puts a waiting check-in in the registration queue: for the record
 * they name by its exact UHID, or a new record registered from the shared
 * (ABHA-verified) profile. Audited.
 */
export async function queueCheckIn(staff: { userId: string; facilityId: string }, checkInId: string, body: { uhid?: unknown }) {
  const ci = await prisma.scanShareCheckIn.findUnique({ where: { id: checkInId }, include: { counter: { select: { departmentId: true } } } });
  if (!ci || ci.facilityId !== staff.facilityId) throw new NotFoundError("Check-in not found.");
  if (ci.status !== "WAITING") throw new ConflictError("This check-in is already in the queue.");
  const uhid = typeof body.uhid === "string" && body.uhid.trim() ? body.uhid.trim() : null;
  const existing = uhid ? await prisma.patient.findFirst({ where: { facilityId: staff.facilityId, uhid }, select: { id: true } }) : null;
  if (uhid && !existing) throw new NotFoundError("No patient with that UHID here.");
  const now = new Date();
  for (let attempt = 0; ; attempt++) {
    const candidate = existing ? null : await generateCandidateUhid(staff.facilityId);
    try {
      const out = await prisma.$transaction(async (tx) => {
        const patientId = existing?.id ?? (await createRegisteredPatient(tx, {
          facilityId: staff.facilityId, uhid: candidate!, fullName: ci.name, sex: ci.sex, phone: ci.phone,
          ...(ci.dob ? { dob: ci.dob, dobPrecision: "DAY" as const } : ci.yearOfBirth ? { dob: new Date(Date.UTC(ci.yearOfBirth, 6, 1)), dobPrecision: "YEAR" as const } : {}),
          actorUserId: staff.userId,
        })).id;
        return { patientId, ...(await queueTx(tx, ci.id, staff.facilityId, patientId, ci.counter.departmentId, staff.userId, now)) };
      });
      await recordAuditEvent("hospital.scan-share.queued", staff.userId, { checkInId: ci.id, patientId: out.patientId, registered: !existing }, { facilityId: staff.facilityId, patientId: out.patientId });
      return { checkInId: ci.id, status: "QUEUED" as const, patientId: out.patientId, queueEntryId: out.queueEntryId, registered: !existing };
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002" || existing || attempt >= 4) throw e; // a UHID taken meanwhile: another
    }
  }
}

// ── The patient (the Aarogya app standing in for the PHR app) ───────────────

export async function scanTarget(hipId: string, counterCode: string, sig: string) {
  if (sig !== qrSignature(hipId, counterCode)) throw new NotFoundError("This QR code isn't one of Aarogya's.");
  const c = await counterFor(hipId, counterCode);
  const f = await prisma.facility.findUniqueOrThrow({ where: { id: c.facilityId }, select: { name: true } });
  return { facility: f.name, counter: c.label };
}

/**
 * The patient shares their profile through the mock gateway: the ABHA they
 * confirm, with their Aarogya profile (name, sex, date of birth, verified
 * phone). Their own Person only (another's is a 404 upstream).
 */
export async function shareFromApp(userId: string, body: { hip?: unknown; counter?: unknown; sig?: unknown; abhaAddress?: unknown }) {
  const hip = typeof body.hip === "string" ? body.hip : "";
  const counter = typeof body.counter === "string" ? body.counter : "";
  await scanTarget(hip, counter, typeof body.sig === "string" ? body.sig : "");
  const abhaAddress = typeof body.abhaAddress === "string" ? body.abhaAddress.trim().toLowerCase() : "";
  if (!abhaAddress) throw new BadRequestError("Your ABHA address is required (e.g. name@sbx).");
  const personId = await requireOwnedPerson(userId);
  const person = await prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { displayName: true, sex: true, dateOfBirth: true, dobPrecision: true } });
  const phone = await prisma.personContact.findFirst({ where: { personId, kind: "PHONE", status: "ACTIVE", verifiedAt: { not: null } }, orderBy: { verifiedAt: "desc" }, select: { value: true } });
  const sex = person.sex === "M" || person.sex === "F" ? person.sex : "O";
  const dob = person.dateOfBirth;
  const exactDay = dob && (person.dobPrecision === "DAY" || person.dobPrecision === null);
  const share: AbdmProfileShare = {
    requestId: randomUUID(), timestamp: new Date().toISOString(), hipId: hip, counterId: counter,
    profile: {
      abhaNumber: null, abhaAddress, name: person.displayName, gender: sex,
      yearOfBirth: dob ? dob.getUTCFullYear() : null, monthOfBirth: dob && exactDay ? dob.getUTCMonth() + 1 : null, dayOfBirth: dob && exactDay ? dob.getUTCDate() : null,
      phoneNumber: phone?.value ?? null,
    },
  };
  const out = await receiveProfileShare(share, scanShareGateway(), { personId });
  const f = await prisma.facility.findUniqueOrThrow({ where: { id: hip }, select: { name: true } });
  return { token: out.token, status: out.status, facility: f.name };
}
