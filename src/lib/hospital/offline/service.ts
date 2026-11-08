import type { DoseLease, MedicationAdministration, MedicationOrder, OfflineCommand, OfflineConflictKind, OfflineConflictSeverity, OfflineRefusalReason, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { isStaffInFacility } from "@/lib/auth/staffFacility";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { createTask } from "@/lib/hospital/task";
import { administerMedicationTx, recordOfflineGivenTx } from "@/lib/hospital/medicationLifecycle";

/**
 * Flagship 2, step 5 — offline nursing, phase 1: the server side
 * (docs/OFFLINE_NURSING_DESIGN.md §3–5, §12 decisions, §13 as built).
 *
 *   Devices    a facility registers its shared ward tablets (WardDevice);
 *              revoking one ends its leases.
 *   Packs      at shift start a device downloads the pack for the nurse
 *              signed in: her assigned patients (doses, allergies), a
 *              read-only summary of the rest of the ward, and the formulary
 *              barcodes; it takes a DoseLease on each due dose (one ACTIVE
 *              lease per dose, by a partial unique index), for the
 *              facility's offline limit (4 hours by default, up to 12).
 *   Leases     renewed while online, expire on their own, or are taken over
 *              by the ward's charge nurse with a reason (the holder is told).
 *   Sync       commands applied in order, each in its own transaction with
 *              its events; a replayed client operation id answers what it
 *              answered before and changes nothing. A dose recorded as given
 *              is never discarded, only flagged; controlled and high-alert
 *              medicines are refused offline.
 */

type Tx = Prisma.TransactionClient;
export interface NurseActor { userId: string; staffId: string; facilityId: string }
export interface AdminActor { userId: string; facilityId: string }

/** Only the ward's charge nurse may take a dose over from a device (403). */
export class NotChargeNurseError extends Error {
  constructor() { super("Only the ward's charge nurse can take over a dose from a device."); }
}

export const PACK_HISTORY_MS = 2 * 3_600_000;
export const DOUBLE_DOSE_RESPONSE_MS = 15 * 60_000;
const CLOCK_FUTURE_SLACK_MS = 2 * 60_000;
const CLOCK_PAST_LIMIT_MS = 12 * 3_600_000;

// ── Devices and charge nurses ────────────────────────────────────────────────

export async function registerWardDevice(admin: AdminActor, body: { wardId?: unknown; label?: unknown }) {
  const ward = typeof body.wardId === "string" ? await prisma.ward.findUnique({ where: { id: body.wardId }, select: { id: true, facilityId: true } }) : null;
  if (!ward || ward.facilityId !== admin.facilityId) throw new NotFoundError("Ward not found.");
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
  if (!label) throw new BadRequestError("A label for the device is required (e.g. \"Ward 3 tablet 2\").");
  return prisma.$transaction(async (tx) => {
    const d = await tx.wardDevice.create({ data: { facilityId: admin.facilityId, wardId: ward.id, label, registeredByUserId: admin.userId } });
    await emitFacilityEvent(tx, { type: "WardDeviceRegistered", aggregateId: d.id, facilityId: admin.facilityId, actorUserId: admin.userId, payload: { deviceId: d.id, wardId: ward.id } });
    return d;
  });
}

export async function revokeWardDevice(admin: AdminActor, deviceId: string) {
  const d = await prisma.wardDevice.findUnique({ where: { id: deviceId } });
  if (!d || d.facilityId !== admin.facilityId) throw new NotFoundError("Device not found.");
  if (d.status === "REVOKED") return d;
  return prisma.$transaction(async (tx) => {
    const r = await tx.wardDevice.updateMany({ where: { id: d.id, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: new Date() } });
    if (r.count !== 1) throw new ConflictError("The device changed in the meantime.");
    const ended = await endLeasesTx(tx, { deviceId: d.id, status: "ACTIVE" }, "RELEASED", admin.userId);
    await emitFacilityEvent(tx, { type: "WardDeviceRevoked", aggregateId: d.id, facilityId: d.facilityId, actorUserId: admin.userId, payload: { deviceId: d.id, leasesEnded: ended } });
    return tx.wardDevice.findUniqueOrThrow({ where: { id: d.id } });
  });
}

/** The ward's charge nurse (a NURSE at the facility), or none. */
export async function designateChargeNurse(admin: AdminActor, wardId: string, body: { staffId?: unknown }) {
  const ward = await prisma.ward.findUnique({ where: { id: wardId }, select: { id: true, facilityId: true } });
  if (!ward || ward.facilityId !== admin.facilityId) throw new NotFoundError("Ward not found.");
  const staffId = body.staffId === null ? null : typeof body.staffId === "string" ? body.staffId : undefined;
  if (staffId === undefined) throw new BadRequestError("staffId (or null to clear) is required.");
  if (staffId) {
    const s = await prisma.hospitalStaffProfile.findUnique({ where: { id: staffId }, select: { id: true, user: { select: { role: true } } } });
    if (!s || s.user.role !== "NURSE" || !(await isStaffInFacility(prisma, s.id, admin.facilityId))) throw new NotFoundError("Nurse not found at this facility.");
  }
  return prisma.$transaction(async (tx) => {
    await tx.ward.update({ where: { id: ward.id }, data: { chargeNurseStaffId: staffId } });
    await emitFacilityEvent(tx, { type: "WardChargeNurseDesignated", aggregateId: ward.id, facilityId: admin.facilityId, actorUserId: admin.userId, payload: { wardId: ward.id, ...(staffId ? { chargeNurseStaffId: staffId } : {}) } });
    return { wardId: ward.id, chargeNurseStaffId: staffId };
  });
}

async function activeDevice(facilityId: string, deviceId: unknown) {
  const d = typeof deviceId === "string" ? await prisma.wardDevice.findUnique({ where: { id: deviceId } }) : null;
  if (!d || d.facilityId !== facilityId || d.status !== "ACTIVE") throw new NotFoundError("Device not found.");
  return d;
}

// ── Online-only medicines ────────────────────────────────────────────────────

/**
 * Never offline (design §6.1): a controlled order, or a drug the facility's
 * formulary marks high-alert or controlled, by its name or generic name, or by
 * the item it was dispensed from.
 */
export async function onlineOnlyOrders(facilityId: string, orders: Pick<MedicationOrder, "id" | "drugName" | "isControlled">[]): Promise<Set<string>> {
  const names = [...new Set(orders.map((o) => o.drugName.trim().toLowerCase()))];
  const flagged = await prisma.item.findMany({
    where: { OR: [{ facilityId }, { facilityId: null }], AND: [{ OR: [{ highAlert: true }, { controlledClass: { not: null } }] }] },
    select: { id: true, name: true, genericName: true },
  });
  const flaggedNames = new Set(flagged.flatMap((i) => [i.name, i.genericName].filter((x): x is string => !!x).map((x) => x.trim().toLowerCase())));
  const flaggedIds = new Set(flagged.map((i) => i.id));
  const dispensed = await prisma.dispensingRecord.findMany({ where: { medicationOrderId: { in: orders.map((o) => o.id) }, itemId: { not: null } }, select: { medicationOrderId: true, itemId: true } });
  const out = new Set<string>();
  for (const o of orders) {
    if (o.isControlled || flaggedNames.has(o.drugName.trim().toLowerCase())) out.add(o.id);
  }
  for (const d of dispensed) if (d.itemId && flaggedIds.has(d.itemId)) out.add(d.medicationOrderId);
  void names;
  return out;
}

// ── Leases ──────────────────────────────────────────────────────────────────

async function endLeasesTx(tx: Tx, where: Prisma.DoseLeaseWhereInput, to: "RELEASED" | "EXPIRED", byUserId: string | null, now = new Date()) {
  const leases = await tx.doseLease.findMany({ where, select: { id: true, facilityId: true, administrationId: true, deviceId: true } });
  for (const l of leases) {
    const r = await tx.doseLease.updateMany({ where: { id: l.id, status: "ACTIVE" }, data: { status: to, endedAt: now, endedByUserId: byUserId } });
    if (r.count === 1) {
      await emitFacilityEvent(tx, { type: "DoseLeaseEnded", aggregateId: l.id, facilityId: l.facilityId, actorUserId: byUserId, payload: { leaseId: l.id, administrationId: l.administrationId, deviceId: l.deviceId, to } });
    }
  }
  return leases.length;
}

/** Runner sweep: ACTIVE leases past their expiry become EXPIRED, with their events. */
export async function sweepExpiredLeases(opts: { now?: Date; batchSize?: number } = {}) {
  const now = opts.now ?? new Date();
  const due = await prisma.doseLease.findMany({ where: { status: "ACTIVE", expiresAt: { lte: now } }, select: { id: true }, take: opts.batchSize ?? 500 });
  let expired = 0;
  for (const l of due) expired += await prisma.$transaction((tx) => endLeasesTx(tx, { id: l.id, status: "ACTIVE" }, "EXPIRED", null, now));
  return { expired };
}

async function packHours(facilityId: string): Promise<number> {
  const f = await prisma.facility.findUniqueOrThrow({ where: { id: facilityId }, select: { offlinePackHours: true } });
  return Math.min(12, Math.max(1, f.offlinePackHours));
}

// ── The pack ─────────────────────────────────────────────────────────────────

/**
 * The pack for the nurse signed in on the device, and leases on her patients'
 * due doses (those another device holds stay read-only, "not on this device").
 */
export async function issuePack(nurse: NurseActor, body: { deviceId?: unknown; deviceClock?: unknown }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const device = await activeDevice(nurse.facilityId, body.deviceId);
  const deviceClock = typeof body.deviceClock === "string" ? Date.parse(body.deviceClock) : NaN;
  const clockOffsetMs = Number.isFinite(deviceClock) ? Math.max(-86_400_000, Math.min(86_400_000, now.getTime() - deviceClock)) : 0;
  const expiresAt = new Date(now.getTime() + (await packHours(nurse.facilityId)) * 3_600_000);
  await sweepExpiredLeases({ now });

  const assignments = await prisma.nursingAssignment.findMany({ where: { facilityId: nurse.facilityId, nurseStaffId: nurse.staffId, endAt: null }, select: { patientId: true, encounterId: true, bed: { select: { label: true, wardId: true } } } });
  const patientIds = assignments.map((a) => a.patientId);
  const doses = await prisma.medicationAdministration.findMany({
    where: { status: "DUE", lateForAdministrationId: null, scheduledAt: { gte: new Date(now.getTime() - PACK_HISTORY_MS), lte: expiresAt }, medicationOrder: { patientId: { in: patientIds }, encounter: { facilityId: nurse.facilityId }, status: { in: ["ACTIVE", "DISPENSED"] } } },
    include: { medicationOrder: { select: { id: true, patientId: true, drugName: true, dose: true, route: true, frequency: true, isControlled: true } } },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
  });
  const onlineOnly = await onlineOnlyOrders(nurse.facilityId, [...new Map(doses.map((d) => [d.medicationOrder.id, d.medicationOrder])).values()]);
  const held = new Set((await prisma.doseLease.findMany({ where: { administrationId: { in: doses.map((d) => d.id) }, status: "ACTIVE", expiresAt: { gt: now } }, select: { administrationId: true } })).map((l) => l.administrationId));
  const leasable = doses.filter((d) => !onlineOnly.has(d.medicationOrderId) && !held.has(d.id));

  const { pack, leases } = await prisma.$transaction(async (tx) => {
    const pack = await tx.wardPack.create({ data: { facilityId: nurse.facilityId, deviceId: device.id, nurseStaffId: nurse.staffId, issuedAt: now, expiresAt, clockOffsetMs } });
    const leases: DoseLease[] = [];
    for (const d of leasable) {
      // The partial unique index (one ACTIVE lease per dose) is the guard against a race with another device.
      const lease = await tx.doseLease.create({ data: { facilityId: nurse.facilityId, administrationId: d.id, deviceId: device.id, packId: pack.id, nurseStaffId: nurse.staffId, grantedAt: now, expiresAt } });
      leases.push(lease);
      await emitFacilityEvent(tx, { type: "DoseLeaseGranted", aggregateId: lease.id, facilityId: nurse.facilityId, actorUserId: nurse.userId, payload: { leaseId: lease.id, administrationId: d.id, deviceId: device.id, packId: pack.id, expiresAt: expiresAt.toISOString() } });
    }
    await tx.wardDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } });
    await emitFacilityEvent(tx, { type: "WardPackIssued", aggregateId: pack.id, facilityId: nurse.facilityId, actorUserId: nurse.userId, payload: { packId: pack.id, deviceId: device.id, nurseStaffId: nurse.staffId, patients: patientIds.length, leases: leases.length, expiresAt: expiresAt.toISOString() } });
    return { pack, leases };
  }).catch((e) => {
    if ((e as { code?: string }).code === "P2002") throw new ConflictError("Another device took a lease at the same moment. Download the pack again.");
    throw e;
  });
  // A pack is a staff read of each patient's record (design §8).
  await recordAuditEvent("hospital.offline.pack.issued", nurse.userId, { packId: pack.id, deviceId: device.id, patients: patientIds.length }, { facilityId: nurse.facilityId });

  const leaseByDose = new Map(leases.map((l) => [l.administrationId, l.id]));
  const patients = await prisma.patient.findMany({ where: { id: { in: patientIds } }, select: { id: true, fullName: true, uhid: true, allergies: { select: { substance: true, severity: true, verification: true } } } });
  const wardIds = [...new Set([device.wardId, ...assignments.map((a) => a.bed?.wardId).filter((x): x is string => !!x)])];
  const wardRest = await prisma.nursingAssignment.findMany({
    where: { facilityId: nurse.facilityId, endAt: null, bed: { wardId: { in: wardIds } }, patientId: { notIn: patientIds } },
    select: { patientId: true, bed: { select: { label: true } }, patient: { select: { fullName: true, uhid: true, _count: { select: { allergies: true } } } } },
    take: 200,
  });
  const drugNames = [...new Set(doses.map((d) => d.medicationOrder.drugName))];
  const formulary = await prisma.item.findMany({
    where: { OR: [{ facilityId: nurse.facilityId }, { facilityId: null }], barcode: { not: null }, AND: [{ OR: [{ name: { in: drugNames, mode: "insensitive" } }, { genericName: { in: drugNames, mode: "insensitive" } }] }] },
    select: { barcode: true, name: true, genericName: true },
  });
  return {
    packId: pack.id, deviceId: device.id, issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), serverTime: now.toISOString(), clockOffsetMs,
    patients: patients.map((p) => {
      const a = assignments.find((x) => x.patientId === p.id);
      return {
        patientId: p.id, name: p.fullName, uhid: p.uhid, bed: a?.bed?.label ?? null, allergies: p.allergies,
        doses: doses.filter((d) => d.medicationOrder.patientId === p.id).map((d) => ({
          administrationId: d.id, orderId: d.medicationOrderId, drugName: d.medicationOrder.drugName, dose: d.medicationOrder.dose, route: d.medicationOrder.route,
          scheduledAt: d.scheduledAt.toISOString(), onlineOnly: onlineOnly.has(d.medicationOrderId), leaseId: leaseByDose.get(d.id) ?? null,
          /** Givable offline on this device only when it holds the lease. */
          givableOffline: leaseByDose.has(d.id),
        })),
      };
    }),
    /** The rest of the ward, read-only: never givable here (decided §12.3). */
    wardSummary: wardRest.map((w) => ({ patientId: w.patientId, bed: w.bed?.label ?? null, name: w.patient.fullName, uhid: w.patient.uhid, allergyCount: w.patient._count.allergies })),
    /** The formulary snapshot barcodes are checked against offline (decided §12.5). */
    formulary,
  };
}

/** Extends the device's ACTIVE leases on a pack, from now, by the facility's offline limit. */
export async function renewLeases(nurse: NurseActor, body: { deviceId?: unknown; packId?: unknown }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const device = await activeDevice(nurse.facilityId, body.deviceId);
  const pack = typeof body.packId === "string" ? await prisma.wardPack.findUnique({ where: { id: body.packId } }) : null;
  if (!pack || pack.deviceId !== device.id) throw new NotFoundError("Pack not found.");
  const expiresAt = new Date(now.getTime() + (await packHours(nurse.facilityId)) * 3_600_000);
  return prisma.$transaction(async (tx) => {
    const r = await tx.doseLease.updateMany({ where: { packId: pack.id, status: "ACTIVE", expiresAt: { gt: now } }, data: { expiresAt } });
    await tx.wardPack.update({ where: { id: pack.id }, data: { expiresAt } });
    await tx.wardDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } });
    await emitFacilityEvent(tx, { type: "DoseLeasesRenewed", aggregateId: pack.id, facilityId: nurse.facilityId, actorUserId: nurse.userId, payload: { packId: pack.id, deviceId: device.id, leases: r.count, expiresAt: expiresAt.toISOString() } });
    return { packId: pack.id, renewed: r.count, expiresAt: expiresAt.toISOString() };
  });
}

/**
 * The ward's charge nurse takes over a lease another device holds (decided
 * §12.2): online, with a reason, logged; the holder is told on its next sync.
 * The dose can then be given online. If the holder gave it offline first, its
 * sync records a possible double dose.
 */
export async function overrideLease(nurse: NurseActor, body: { administrationId?: unknown; reason?: unknown }) {
  const lease = typeof body.administrationId === "string"
    ? await prisma.doseLease.findFirst({ where: { administrationId: body.administrationId, status: "ACTIVE" }, include: { device: { select: { wardId: true } } } })
    : null;
  if (!lease || lease.facilityId !== nurse.facilityId) throw new NotFoundError("No device holds this dose.");
  const ward = await prisma.ward.findUniqueOrThrow({ where: { id: lease.device.wardId }, select: { chargeNurseStaffId: true } });
  if (!ward.chargeNurseStaffId || ward.chargeNurseStaffId !== nurse.staffId) throw new NotChargeNurseError();
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 280) : "";
  if (!reason) throw new BadRequestError("A reason is required to take over a dose from a device.");
  const done = await prisma.$transaction(async (tx) => {
    const r = await tx.doseLease.updateMany({ where: { id: lease.id, status: "ACTIVE" }, data: { status: "OVERRIDDEN", endedAt: new Date(), endedByUserId: nurse.userId, overrideReason: reason } });
    if (r.count !== 1) throw new ConflictError("The lease changed in the meantime.");
    await emitFacilityEvent(tx, { type: "DoseLeaseOverridden", aggregateId: lease.id, facilityId: lease.facilityId, actorUserId: nurse.userId, payload: { leaseId: lease.id, administrationId: lease.administrationId, deviceId: lease.deviceId, overriddenByStaffId: nurse.staffId } });
    return tx.doseLease.findUniqueOrThrow({ where: { id: lease.id } });
  });
  await recordAuditEvent("hospital.offline.lease.overridden", nurse.userId, { leaseId: lease.id, administrationId: lease.administrationId, deviceId: lease.deviceId, reason }, { facilityId: lease.facilityId });
  return { leaseId: done.id, status: done.status, overrideReason: done.overrideReason };
}

// ── Sync ─────────────────────────────────────────────────────────────────────

export interface SyncCommandInput { clientOperationId?: unknown; kind?: unknown; administrationId?: unknown; deviceTime?: unknown; reasonCode?: unknown }
export interface SyncResult { clientOperationId: string; outcome: OfflineCommand["outcome"]; refusalReason: OfflineRefusalReason | null; conflicts: { kind: OfflineConflictKind; severity: OfflineConflictSeverity }[]; replayed: boolean }

const KINDS = ["DOSE_GIVEN", "DOSE_HELD", "DOSE_REFUSED"] as const;

/**
 * Applies the device's commands in the order sent. Each is one transaction:
 * the command row, its effect through the medication services, any conflict
 * with its task, and their events. Returns each command's outcome, and the
 * device's leases that ended while it was away (override, expiry), once.
 */
export async function syncCommands(nurse: NurseActor, body: { deviceId?: unknown; commands?: unknown }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const device = await activeDevice(nurse.facilityId, body.deviceId);
  if (!Array.isArray(body.commands) || body.commands.length > 500) throw new BadRequestError("commands must be a list of at most 500.");
  const results: SyncResult[] = [];
  for (const raw of body.commands as SyncCommandInput[]) results.push(await applyCommand(nurse, device, raw, now));

  const notices = await prisma.doseLease.findMany({ where: { deviceId: device.id, status: { in: ["OVERRIDDEN", "EXPIRED", "RELEASED"] }, holderToldAt: null, endedByUserId: { not: null } }, select: { id: true, administrationId: true, status: true } });
  const expiredUntold = await prisma.doseLease.findMany({ where: { deviceId: device.id, status: "EXPIRED", holderToldAt: null }, select: { id: true, administrationId: true, status: true } });
  const told = [...new Map([...notices, ...expiredUntold].map((n) => [n.id, n])).values()];
  await prisma.$transaction(async (tx) => {
    await tx.wardDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } });
    if (told.length) await tx.doseLease.updateMany({ where: { id: { in: told.map((n) => n.id) } }, data: { holderToldAt: now } });
    const counted = results.filter((r) => !r.replayed);
    await emitFacilityEvent(tx, {
      type: "OfflineBatchApplied", aggregateId: device.id, facilityId: nurse.facilityId, actorUserId: nurse.userId,
      payload: { deviceId: device.id, applied: counted.filter((r) => r.outcome === "APPLIED").length, conflicted: counted.filter((r) => r.outcome === "APPLIED_WITH_CONFLICT").length, refused: counted.filter((r) => r.outcome === "REFUSED").length, replayed: results.length - counted.length },
    });
  });
  return { results, notices: told.map((n) => ({ leaseId: n.id, administrationId: n.administrationId, ended: n.status })) };
}

async function stored(facilityId: string, clientOperationId: string): Promise<SyncResult | null> {
  const c = await prisma.offlineCommand.findUnique({ where: { facilityId_clientOperationId: { facilityId, clientOperationId } }, include: { conflicts: { select: { kind: true, severity: true } } } });
  return c ? { clientOperationId, outcome: c.outcome, refusalReason: c.refusalReason, conflicts: c.conflicts, replayed: true } : null;
}

async function applyCommand(nurse: NurseActor, device: { id: string; wardId: string }, raw: SyncCommandInput, now: Date): Promise<SyncResult> {
  const clientOperationId = typeof raw.clientOperationId === "string" ? raw.clientOperationId.trim() : "";
  if (!/^[A-Za-z0-9-]{8,100}$/.test(clientOperationId)) throw new BadRequestError("Each command needs a clientOperationId (8–100 letters, digits or dashes).");
  const again = await stored(nurse.facilityId, clientOperationId);
  if (again) return again;
  const kind = KINDS.find((k) => k === raw.kind);
  const deviceMs = typeof raw.deviceTime === "string" ? Date.parse(raw.deviceTime) : NaN;
  if (!kind || typeof raw.administrationId !== "string" || !Number.isFinite(deviceMs)) throw new BadRequestError("Each command needs a kind, an administrationId and a deviceTime.");
  const reasonCode = typeof raw.reasonCode === "string" ? raw.reasonCode.trim().slice(0, 60) || undefined : undefined;

  const admin = await prisma.medicationAdministration.findUnique({ where: { id: raw.administrationId }, include: { medicationOrder: { select: { id: true, drugName: true, isControlled: true, status: true, patientId: true, encounterId: true, orderedByStaffId: true, encounter: { select: { facilityId: true } } } } } });
  const lease = admin ? await prisma.doseLease.findFirst({ where: { administrationId: admin.id, deviceId: device.id }, orderBy: { grantedAt: "desc" }, include: { pack: { select: { clockOffsetMs: true } } } }) : null;
  const corrected = deviceMs + (lease?.pack.clockOffsetMs ?? 0);
  const clockSuspect = corrected > now.getTime() + CLOCK_FUTURE_SLACK_MS || corrected < now.getTime() - CLOCK_PAST_LIMIT_MS;
  const appliedTime = new Date(clockSuspect ? now.getTime() : corrected);
  const base = { facilityId: nurse.facilityId, clientOperationId, deviceId: device.id, nurseStaffId: nurse.staffId, kind, administrationId: raw.administrationId, deviceTime: new Date(deviceMs), appliedTime, receivedAt: now, reasonCode };

  try {
    return await prisma.$transaction(async (tx) => {
      const conflicts: { kind: OfflineConflictKind; severity: OfflineConflictSeverity }[] = [];
      const record = async (outcome: OfflineCommand["outcome"], refusalReason: OfflineRefusalReason | null, resultAdministrationId: string | null) => {
        const c = await tx.offlineCommand.create({ data: { ...base, outcome, refusalReason, resultAdministrationId } });
        await emitFacilityEvent(tx, {
          type: "OfflineCommandRecorded", aggregateId: c.id, facilityId: nurse.facilityId, actorUserId: nurse.userId, encounterId: admin?.medicationOrder.encounterId,
          payload: { commandId: c.id, deviceId: device.id, administrationId: c.administrationId, kind, outcome, ...(refusalReason ? { refusalReason } : {}), ...(resultAdministrationId ? { resultAdministrationId } : {}) },
        });
        return c;
      };
      const conflict = async (c: OfflineCommand, k: OfflineConflictKind, severity: OfflineConflictSeverity) => {
        conflicts.push({ kind: k, severity });
        await raiseConflictTx(tx, nurse, device, c, admin, k, severity, now);
      };
      const finish = (c: OfflineCommand): SyncResult => ({ clientOperationId, outcome: c.outcome, refusalReason: c.refusalReason, conflicts, replayed: false });

      // Unknown, or another facility's dose: refused (and nothing about it is revealed).
      if (!admin || admin.medicationOrder.encounter.facilityId !== nurse.facilityId) return finish(await record("REFUSED", "UNKNOWN_DOSE", null));
      const given = kind === "DOSE_GIVEN";
      const status = kind === "DOSE_GIVEN" ? "GIVEN" : kind === "DOSE_HELD" ? "HELD" : "REFUSED";

      // Controlled and high-alert medicines are never given offline.
      if ((await onlineOnlyOrders(nurse.facilityId, [admin.medicationOrder])).has(admin.medicationOrderId)) {
        const c = await record("REFUSED", "ONLINE_ONLY", null);
        if (given) await conflict(c, "ONLINE_ONLY", "WARNING");
        return finish(c);
      }
      // A lease the device held when it recorded the dose, or none at all.
      if (!lease) {
        const c = await record("REFUSED", "NOT_LEASED", null);
        if (given) await conflict(c, "NOT_LEASED", "WARNING");
        return finish(c);
      }
      const leaseEndMs = Math.min(lease.expiresAt.getTime(), lease.status === "EXPIRED" && lease.endedAt ? lease.endedAt.getTime() : Infinity);
      const overridden = lease.status === "OVERRIDDEN";
      if (!overridden && (lease.status === "EXPIRED" || appliedTime.getTime() > leaseEndMs)) {
        const c = await record("REFUSED", "LEASE_EXPIRED", null);
        if (given) await conflict(c, "LEASE_EXPIRED", "WARNING");
        return finish(c);
      }

      const swept = admin.status === "MISSED" && admin.reasonCode === "not-recorded";
      if (admin.status === "DUE" || swept) {
        const orderActive = ["ACTIVE", "DISPENSED"].includes(admin.medicationOrder.status);
        const result = await administerMedicationTx(tx, {
          administrationId: admin.id, status, administeredByStaffId: nurse.staffId, safetyChecksConfirmed: true, reasonCode, byUserId: nurse.userId,
          administeredAt: appliedTime, offline: { leaseId: lease.id, allowInactiveOrder: given },
        });
        if (lease.status === "ACTIVE") await tx.doseLease.updateMany({ where: { id: lease.id, status: "ACTIVE" }, data: { status: "RELEASED", endedAt: now } });
        const hasConflict = overridden || (given && !orderActive) || clockSuspect;
        const c = await record(hasConflict ? "APPLIED_WITH_CONFLICT" : "APPLIED", null, result.id);
        if (overridden) await conflict(c, "LEASE_OVERRIDDEN", "WARNING");
        if (given && !orderActive) await conflict(c, "ORDER_CHANGED", "WARNING");
        if (clockSuspect) await conflict(c, "CLOCK_SUSPECT", "WARNING");
        return finish(c);
      }
      // The dose is no longer due. Held or refused: nothing to apply.
      if (!given) return finish(await record("REFUSED", "NOT_DUE", null));
      // Given offline, but given, held or cancelled meanwhile: the dose was given, so it is recorded, and flagged.
      const second = await recordOfflineGivenTx(tx, { forAdministrationId: admin.id, administeredByStaffId: nurse.staffId, administeredAt: appliedTime, byUserId: nurse.userId });
      const c = await record("APPLIED_WITH_CONFLICT", null, second.id);
      if (admin.status === "GIVEN") await conflict(c, "POSSIBLE_DOUBLE_DOSE", "CRITICAL");
      else await conflict(c, "ORDER_CHANGED", "WARNING");
      if (clockSuspect) await conflict(c, "CLOCK_SUSPECT", "WARNING");
      return finish(c);
    });
  } catch (e) {
    // The same operation id sent twice at once: the other one won; answer what it recorded.
    if ((e as { code?: string }).code === "P2002") {
      const s = await stored(nurse.facilityId, clientOperationId);
      if (s) return s;
    }
    throw e;
  }
}

/**
 * A conflict row, its task and their events. The ward's charge nurse is told
 * (a task owned by them, or for the CHARGE_NURSE role when none is named); a
 * possible double dose is CRITICAL, due within 15 minutes, and the facility's
 * pharmacists are told too (decided §12.7); an order changed under an offline
 * dose also goes to the prescriber.
 */
async function raiseConflictTx(
  tx: Tx, nurse: NurseActor, device: { id: string; wardId: string }, c: OfflineCommand,
  admin: (MedicationAdministration & { medicationOrder: { patientId: string; encounterId: string; orderedByStaffId: string } }) | null,
  kind: OfflineConflictKind, severity: OfflineConflictSeverity, now: Date,
) {
  const ward = await tx.ward.findUnique({ where: { id: device.wardId }, select: { chargeNurseStaffId: true } });
  const critical = severity === "CRITICAL";
  const task = await createTask(tx, {
    facilityId: nurse.facilityId, title: critical ? "Possible double dose: check the patient now" : "Offline dose to review", type: "OFFLINE_DOSE_CONFLICT",
    priority: critical ? "STAT" : "URGENT", source: "EVENT", dueAt: new Date(now.getTime() + (critical ? DOUBLE_DOSE_RESPONSE_MS : 4 * 3_600_000)),
    assignedRole: "CHARGE_NURSE", ownerStaffId: ward?.chargeNurseStaffId ?? undefined, patientId: admin?.medicationOrder.patientId, encounterId: admin?.medicationOrder.encounterId,
    idempotencyKey: `offline-conflict:${c.id}:${kind}`,
  }, nurse.userId);
  if (critical && admin) {
    await createTask(tx, {
      facilityId: nurse.facilityId, title: "Possible double dose recorded on a ward", type: "OFFLINE_DOSE_CONFLICT", priority: "STAT", source: "EVENT",
      dueAt: new Date(now.getTime() + DOUBLE_DOSE_RESPONSE_MS), assignedRole: "PHARMACIST", patientId: admin.medicationOrder.patientId, encounterId: admin.medicationOrder.encounterId,
      idempotencyKey: `offline-conflict:${c.id}:${kind}:pharmacist`,
    }, nurse.userId);
  }
  if (kind === "ORDER_CHANGED" && admin) {
    await createTask(tx, {
      facilityId: nurse.facilityId, title: "A dose was given offline after the order changed", type: "OFFLINE_DOSE_CONFLICT", priority: "URGENT", source: "EVENT",
      ownerStaffId: admin.medicationOrder.orderedByStaffId, patientId: admin.medicationOrder.patientId, encounterId: admin.medicationOrder.encounterId,
      idempotencyKey: `offline-conflict:${c.id}:${kind}:prescriber`,
    }, nurse.userId);
  }
  const row = await tx.offlineConflict.create({ data: { facilityId: nurse.facilityId, commandId: c.id, administrationId: c.administrationId, kind, severity, taskId: task.id } });
  await emitFacilityEvent(tx, {
    type: "OfflineConflictRecorded", aggregateId: row.id, facilityId: nurse.facilityId, actorUserId: nurse.userId, encounterId: admin?.medicationOrder.encounterId,
    payload: { conflictId: row.id, commandId: c.id, administrationId: c.administrationId, kind, severity, taskId: task.id },
  });
  return row;
}
