import type { ConsultMode, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { ensurePrimaryMembership } from "../../../prisma/seedData/staffMembership";
import { requireOwnDoctor } from "./profile";

/**
 * Week 5a — staff links and practice locations (docs/DOCTOR_NETWORK_DESIGN.md
 * §2, §5).
 *   - A doctor claims their own staff profile at a hospital; that facility's
 *     admin approves it (DoctorStaffLinkChanged). One staff profile, one doctor.
 *   - HOSPITAL location: a facility with an ACTIVE link. Its fee is ALWAYS the
 *     hospital's own consultation tariff (CONSULT_OPD, cash), read live; the
 *     doctor can't set one (5a decision).
 *   - CLINIC location: the doctor's own practice, a Facility in the doctor's
 *     own Organization, with the doctor's staff profile as its only staff, so
 *     the one booking engine (sessions, absences, the double-booking guard)
 *     applies unchanged. Its fee is the doctor's.
 *   - Modes: IN_PERSON and VIDEO. No home visits at launch. VIDEO is booked as
 *     a TELEMEDICINE appointment; the call provider is not chosen and nothing
 *     is recorded (5a decision).
 *   - Timings are the location's DoctorScheduleBlock rows; no second copy.
 */
const MODES: ConsultMode[] = ["IN_PERSON", "VIDEO"];

function parseModes(v: unknown): ConsultMode[] {
  if (!Array.isArray(v) || !v.length || v.some((m) => !MODES.includes(m as ConsultMode))) {
    throw new BadRequestError("modes must be IN_PERSON and/or VIDEO (home visits aren't offered).");
  }
  return [...new Set(v as ConsultMode[])];
}

function parsePoint(b: Record<string, unknown>) {
  const lat = b.lat === undefined ? null : Number(b.lat), lng = b.lng === undefined ? null : Number(b.lng);
  if ((lat !== null && (!Number.isFinite(lat) || lat < 6 || lat > 38)) || (lng !== null && (!Number.isFinite(lng) || lng < 68 || lng > 98))) {
    throw new BadRequestError("The location must be a point in India.");
  }
  const pincode = b.pincode === undefined ? null : String(b.pincode);
  if (pincode !== null && !/^\d{6}$/.test(pincode)) throw new BadRequestError("pincode must be 6 digits.");
  return { lat, lng, pincode, addressLine: typeof b.addressLine === "string" ? b.addressLine.trim().slice(0, 200) || null : null };
}

async function linkStatusTx(tx: Prisma.TransactionClient, link: { id: string; doctorId: string; staffId: string; facilityId: string }, from: string | null, to: string, actorUserId: string) {
  await emitFacilityEvent(tx, {
    type: "DoctorStaffLinkChanged", aggregateId: link.id, facilityId: link.facilityId, actorUserId,
    payload: { linkId: link.id, doctorId: link.doctorId, staffId: link.staffId, from, to },
  });
}

/** The doctor claims their own staff profile at a hospital (it must be theirs: the same login). */
export async function claimStaffProfile(userId: string, facilityId: string) {
  const d = await requireOwnDoctor(userId);
  const staff = await prisma.hospitalStaffProfile.findUnique({ where: { userId }, select: { id: true, status: true } });
  const member = staff ? await prisma.facilityMembership.findFirst({ where: { userId, facilityId, status: "ACTIVE" }, select: { id: true } }) : null;
  if (!staff || staff.status !== "ACTIVE" || !member) throw new NotFoundError();
  if (await prisma.doctorStaffLink.findFirst({ where: { staffId: staff.id, facilityId, status: { in: ["PENDING", "ACTIVE"] } } })) throw new ConflictError("That staff profile is already linked or waiting.");
  // One staff profile, one doctor (the unique staffId): a profile linked here before can't be claimed for another facility row.
  const existing = await prisma.doctorStaffLink.findUnique({ where: { staffId: staff.id } });
  if (existing && existing.status !== "ENDED" && existing.status !== "REJECTED") throw new ConflictError("That staff profile is already linked.");
  return prisma.$transaction(async (tx) => {
    const link = existing
      ? await tx.doctorStaffLink.update({ where: { id: existing.id }, data: { doctorId: d.id, facilityId, status: "PENDING", decidedAt: null, decidedByUserId: null, endedAt: null, version: { increment: 1 } } })
      : await tx.doctorStaffLink.create({ data: { doctorId: d.id, staffId: staff.id, facilityId } });
    await linkStatusTx(tx, link, existing?.status ?? null, "PENDING", userId);
    return link;
  });
}

/** The facility's admin approves or rejects a doctor's claim on one of its staff profiles. */
export async function decideStaffLink(admin: { userId: string; facilityId: string }, linkId: string, approve: boolean) {
  const link = await prisma.doctorStaffLink.findUnique({ where: { id: linkId } });
  if (!link || link.facilityId !== admin.facilityId) throw new NotFoundError();
  if (link.status !== "PENDING") throw new ConflictError("This link has been decided.");
  const to = approve ? "ACTIVE" : "REJECTED";
  await prisma.$transaction(async (tx) => {
    const r = await tx.doctorStaffLink.updateMany({ where: { id: link.id, status: "PENDING" }, data: { status: to, decidedAt: new Date(), decidedByUserId: admin.userId, version: { increment: 1 } } });
    if (r.count !== 1) throw new ConflictError("This link has been decided.");
    await linkStatusTx(tx, link, "PENDING", to, admin.userId);
  });
  await recordAuditEvent("doctor.staffLink.decided", admin.userId, { linkId, to }, { facilityId: admin.facilityId });
  return { status: to };
}

/** Links waiting for this facility's admin. */
export async function pendingStaffLinks(facilityId: string) {
  const links = await prisma.doctorStaffLink.findMany({ where: { facilityId, status: "PENDING" }, include: { doctor: { select: { displayName: true, registrationNumber: true, stateCouncil: true, verificationStatus: true } } }, orderBy: { createdAt: "asc" } });
  return links.map((l) => ({ id: l.id, staffId: l.staffId, createdAt: l.createdAt.toISOString(), doctor: l.doctor }));
}

async function locationEventTx(tx: Prisma.TransactionClient, loc: { id: string; doctorId: string; kind: string; active: boolean; modes: ConsultMode[] }, actorUserId: string) {
  await emitDomainEvent(tx, { type: "PracticeLocationChanged", aggregateId: loc.id, actorUserId, payload: { locationId: loc.id, doctorId: loc.doctorId, kind: loc.kind as "HOSPITAL" | "CLINIC", active: loc.active, modes: loc.modes } });
}

/** A HOSPITAL location at a facility where the doctor's staff link is ACTIVE. No fee: the hospital's tariff applies. */
export async function addHospitalLocation(userId: string, body: Record<string, unknown>) {
  const d = await requireOwnDoctor(userId);
  const facilityId = String(body.facilityId ?? "");
  const link = await prisma.doctorStaffLink.findFirst({ where: { doctorId: d.id, facilityId, status: "ACTIVE" } });
  if (!link) throw new NotFoundError();
  if (body.feeMinor !== undefined) throw new BadRequestError("At a hospital the hospital's own consultation fee applies.");
  const modes = parseModes(body.modes ?? ["IN_PERSON"]);
  const point = parsePoint(body);
  return prisma.$transaction(async (tx) => {
    if (await tx.practiceLocation.findUnique({ where: { doctorId_facilityId: { doctorId: d.id, facilityId } }, select: { id: true } })) throw new ConflictError("You already practise at this hospital.");
    const loc = await tx.practiceLocation.create({ data: { doctorId: d.id, kind: "HOSPITAL", facilityId, staffId: link.staffId, modes, ...point } });
    await locationEventTx(tx, loc, userId);
    return loc;
  });
}

/**
 * The doctor's own clinic: its own Organization and Facility (ACTIVE), a
 * department, and the doctor's staff profile there (created if the doctor
 * has none: an independent doctor). The doctor sets the fee.
 */
export async function addClinicLocation(userId: string, body: Record<string, unknown>) {
  const d = await requireOwnDoctor(userId);
  if (d.verificationStatus !== "VERIFIED") throw new ConflictError("Add your clinic once your registration is verified.");
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : `${d.displayName}'s clinic`;
  const fee = Number(body.feeMinor);
  if (!Number.isInteger(fee) || fee < 0 || fee > 10_000_00) throw new BadRequestError("feeMinor must be a whole number of paise (up to ₹10,000).");
  const modes = parseModes(body.modes ?? ["IN_PERSON"]);
  const point = parsePoint(body);
  if (point.lat === null || point.lng === null) throw new BadRequestError("A clinic needs its public address point (lat, lng).");
  const city = typeof body.city === "string" ? body.city.trim().slice(0, 80) || null : null;
  const loc = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name, slug: `clinic-${d.id}-${Date.now().toString(36)}`, status: "ACTIVE" } });
    const facility = await tx.facility.create({ data: { name, city, organizationId: org.id, status: "ACTIVE" } });
    const dept = await tx.department.create({ data: { facilityId: facility.id, name: "Clinic" } });
    let staff = await tx.hospitalStaffProfile.findUnique({ where: { userId } });
    if (!staff) staff = await tx.hospitalStaffProfile.create({ data: { userId, departmentId: dept.id, displayRole: "Doctor" } });
    await ensurePrimaryMembership(tx, userId, facility.id, { isAdmin: true });
    const loc = await tx.practiceLocation.create({ data: { doctorId: d.id, kind: "CLINIC", facilityId: facility.id, staffId: staff.id, feeMinor: fee, modes, ...point } });
    await locationEventTx(tx, loc, userId);
    return loc;
  });
  await recordAuditEvent("doctor.clinic.created", userId, { doctorId: d.id, locationId: loc.id }, { facilityId: loc.facilityId });
  return loc;
}

/** Changes a location's modes, fee (clinic only), point, or takes it off (active false). */
export async function updateLocation(userId: string, locationId: string, body: Record<string, unknown>) {
  const d = await requireOwnDoctor(userId);
  const loc = await prisma.practiceLocation.findUnique({ where: { id: locationId } });
  if (!loc || loc.doctorId !== d.id) throw new NotFoundError();
  const data: Prisma.PracticeLocationUpdateManyMutationInput = {};
  if (body.modes !== undefined) data.modes = parseModes(body.modes);
  if (body.feeMinor !== undefined) {
    if (loc.kind !== "CLINIC") throw new BadRequestError("At a hospital the hospital's own consultation fee applies.");
    const fee = Number(body.feeMinor);
    if (!Number.isInteger(fee) || fee < 0 || fee > 10_000_00) throw new BadRequestError("feeMinor must be a whole number of paise.");
    data.feeMinor = fee;
  }
  if (body.active !== undefined) data.active = Boolean(body.active);
  if (body.lat !== undefined || body.lng !== undefined || body.pincode !== undefined || body.addressLine !== undefined) Object.assign(data, parsePoint({ ...loc, ...body }));
  return prisma.$transaction(async (tx) => {
    const r = await tx.practiceLocation.updateMany({ where: { id: loc.id, version: loc.version }, data: { ...data, version: { increment: 1 } } });
    if (r.count !== 1) throw new ConflictError("This location changed in the meantime.");
    const after = await tx.practiceLocation.findUniqueOrThrow({ where: { id: loc.id } });
    await locationEventTx(tx, after, userId);
    return after;
  });
}

/** The fee a patient sees for a location: the hospital's live tariff, or the clinic's own. */
export async function locationFeeMinor(loc: { kind: string; facilityId: string; feeMinor: number | null }, at = new Date()): Promise<number | null> {
  if (loc.kind === "CLINIC") return loc.feeMinor;
  const t = await prisma.tariff.findFirst({
    where: { facilityId: loc.facilityId, chargeCode: "CONSULT_OPD", active: true, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }], payer: { type: "CASH" } },
    orderBy: { effectiveFrom: "desc" }, select: { unitPriceMinor: true },
  });
  return t?.unitPriceMinor ?? null;
}
