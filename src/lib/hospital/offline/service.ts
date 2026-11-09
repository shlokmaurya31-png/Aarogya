import type { DoseLease, MedicationOrder, OfflineCommand, OfflineConflictKind, OfflineConflictSeverity, OfflineRefusalReason, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { createTask } from "@/lib/hospital/task";
import { administerMedicationTx, givePrnDoseTx, prnStanding, recordOfflineGivenTx } from "@/lib/hospital/medicationLifecycle";
import { abnormalOf, recordIntakeOutputTx, recordVitalsTx, type VitalsInput } from "@/lib/hospital/clinicalRecords";
import { closeTask } from "@/lib/hospital/task";
import { assertFacilityNurse, currentChargeNurse } from "./chargeShift";
import { assertWardOffline } from "./switch";

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
 *              by the ward's charge nurse with a reason (the holder is told):
 *              the current shift's (Flagship 3a, chargeShift.ts), or else the
 *              ward's named one.
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

/** The ward's named charge nurse (a NURSE at the facility), or none: the fallback when no shift is rostered. */
export async function designateChargeNurse(admin: AdminActor, wardId: string, body: { staffId?: unknown }) {
  const ward = await prisma.ward.findUnique({ where: { id: wardId }, select: { id: true, facilityId: true } });
  if (!ward || ward.facilityId !== admin.facilityId) throw new NotFoundError("Ward not found.");
  const staffId = body.staffId === null ? null : typeof body.staffId === "string" ? body.staffId : undefined;
  if (staffId === undefined) throw new BadRequestError("staffId (or null to clear) is required.");
  if (staffId) await assertFacilityNurse(admin.facilityId, staffId);
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
  // Flagship 4e: no pack while the ward's offline mode is off (the sign-off of §6 first).
  await assertWardOffline(device.wardId);
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
  // Held by another device: read-only here. This device's own leases are re-granted on the new pack (a fresh list after a sync keeps its doses).
  const held = new Set((await prisma.doseLease.findMany({ where: { administrationId: { in: doses.map((d) => d.id) }, status: "ACTIVE", expiresAt: { gt: now }, deviceId: { not: device.id } }, select: { administrationId: true } })).map((l) => l.administrationId));
  const leasable = doses.filter((d) => !onlineOnly.has(d.medicationOrderId) && !held.has(d.id));

  const { pack, leases } = await prisma.$transaction(async (tx) => {
    // The device's earlier leases end here and are granted again on this pack, in one transaction: the dose is never free in between.
    await endLeasesTx(tx, { deviceId: device.id, status: "ACTIVE" }, "RELEASED", null, now);
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
  // Flagship 4a: PRN orders (with their limits and the doses given in the last 24 hours, so the device can hold them), open tasks, and the last 24 hours of vitals and I/O.
  const prnOrders = await prisma.medicationOrder.findMany({
    where: { patientId: { in: patientIds }, prn: true, status: { in: ["ACTIVE", "DISPENSED"] }, encounter: { facilityId: nurse.facilityId } },
    select: { id: true, patientId: true, drugName: true, dose: true, route: true, isControlled: true, prnReason: true, prnOfflineAllowed: true, prnMinIntervalMinutes: true, prnMaxDosesPer24h: true,
      administrations: { where: { status: "GIVEN", administeredAt: { gt: new Date(now.getTime() - 86_400_000) } }, select: { administeredAt: true }, orderBy: { administeredAt: "asc" } } },
  });
  const prnOnlineOnly = await onlineOnlyOrders(nurse.facilityId, prnOrders);
  const encounterIds = assignments.map((a) => a.encounterId).filter((x): x is string => !!x);
  const since = new Date(now.getTime() - 86_400_000);
  const [tasks, vitals, io] = await Promise.all([
    prisma.task.findMany({ where: { facilityId: nurse.facilityId, patientId: { in: patientIds }, status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS"] } }, select: { id: true, patientId: true, title: true, priority: true, dueAt: true }, orderBy: [{ dueAt: "asc" }, { id: "asc" }], take: 400 }),
    prisma.vital.findMany({ where: { encounterId: { in: encounterIds }, recordedAt: { gt: since } }, select: { encounterId: true, recordedAt: true, hr: true, sbp: true, dbp: true, rr: true, spo2: true, tempC: true }, orderBy: { recordedAt: "desc" }, take: 12 * Math.max(1, encounterIds.length) }),
    prisma.intakeOutputRecord.findMany({ where: { encounterId: { in: encounterIds }, recordedAt: { gt: since } }, select: { encounterId: true, recordedAt: true, ioType: true, category: true, quantityMl: true }, orderBy: { recordedAt: "desc" }, take: 24 * Math.max(1, encounterIds.length) }),
  ]);
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
        patientId: p.id, name: p.fullName, uhid: p.uhid, bed: a?.bed?.label ?? null, allergies: p.allergies, encounterId: a?.encounterId ?? null,
        doses: doses.filter((d) => d.medicationOrder.patientId === p.id).map((d) => ({
          administrationId: d.id, orderId: d.medicationOrderId, drugName: d.medicationOrder.drugName, dose: d.medicationOrder.dose, route: d.medicationOrder.route,
          scheduledAt: d.scheduledAt.toISOString(), onlineOnly: onlineOnly.has(d.medicationOrderId), leaseId: leaseByDose.get(d.id) ?? null,
          /** Givable offline on this device only when it holds the lease. */
          givableOffline: leaseByDose.has(d.id),
        })),
        /** PRN offline only when the prescriber allowed it, with both limits, and not online-only (design §6.2). */
        prn: prnOrders.filter((o) => o.patientId === p.id).map((o) => ({
          orderId: o.id, drugName: o.drugName, dose: o.dose, route: o.route, reason: o.prnReason, minIntervalMinutes: o.prnMinIntervalMinutes, maxPer24h: o.prnMaxDosesPer24h,
          onlineOnly: prnOnlineOnly.has(o.id),
          givableOffline: o.prnOfflineAllowed && o.prnMinIntervalMinutes !== null && o.prnMaxDosesPer24h !== null && !prnOnlineOnly.has(o.id),
          givenAt: o.administrations.map((x) => x.administeredAt!.toISOString()),
        })),
        tasks: tasks.filter((t) => t.patientId === p.id).map((t) => ({ taskId: t.id, title: t.title, priority: t.priority, dueAt: t.dueAt?.toISOString() ?? null })),
        vitals: vitals.filter((v) => v.encounterId === a?.encounterId).slice(0, 12).map(({ encounterId: _e, recordedAt, ...v }) => ({ recordedAt: recordedAt.toISOString(), ...v })),
        io: io.filter((x) => x.encounterId === a?.encounterId).slice(0, 24).map((x) => ({ recordedAt: x.recordedAt.toISOString(), ioType: x.ioType, category: x.category, quantityMl: x.quantityMl })),
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
  await assertWardOffline(device.wardId);
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
 * The charge nurse is the one on now (decided §12.9): the rostered shift's,
 * else the ward's named one.
 * The dose can then be given online. If the holder gave it offline first, its
 * sync records a possible double dose.
 */
export async function overrideLease(nurse: NurseActor, body: { administrationId?: unknown; reason?: unknown }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const lease = typeof body.administrationId === "string"
    ? await prisma.doseLease.findFirst({ where: { administrationId: body.administrationId, status: "ACTIVE" }, include: { device: { select: { wardId: true } } } })
    : null;
  if (!lease || lease.facilityId !== nurse.facilityId) throw new NotFoundError("No device holds this dose.");
  const charge = await currentChargeNurse(prisma, lease.device.wardId, now);
  if (!charge.staffId || charge.staffId !== nurse.staffId) throw new NotChargeNurseError();
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 280) : "";
  if (!reason) throw new BadRequestError("A reason is required to take over a dose from a device.");
  const done = await prisma.$transaction(async (tx) => {
    const r = await tx.doseLease.updateMany({ where: { id: lease.id, status: "ACTIVE" }, data: { status: "OVERRIDDEN", endedAt: now, endedByUserId: nurse.userId, overrideReason: reason } });
    if (r.count !== 1) throw new ConflictError("The lease changed in the meantime.");
    await emitFacilityEvent(tx, { type: "DoseLeaseOverridden", aggregateId: lease.id, facilityId: lease.facilityId, actorUserId: nurse.userId, payload: { leaseId: lease.id, administrationId: lease.administrationId, deviceId: lease.deviceId, overriddenByStaffId: nurse.staffId } });
    return tx.doseLease.findUniqueOrThrow({ where: { id: lease.id } });
  });
  await recordAuditEvent("hospital.offline.lease.overridden", nurse.userId, { leaseId: lease.id, administrationId: lease.administrationId, deviceId: lease.deviceId, reason, chargeNurseSource: charge.source, ...(charge.shiftId ? { shiftId: charge.shiftId } : {}) }, { facilityId: lease.facilityId });
  return { leaseId: done.id, status: done.status, overrideReason: done.overrideReason };
}

// ── Sync ─────────────────────────────────────────────────────────────────────

export interface SyncCommandInput {
  clientOperationId?: unknown; kind?: unknown; deviceTime?: unknown; reasonCode?: unknown;
  /** DOSE_*: the scheduled dose. */
  administrationId?: unknown;
  /** VITALS, INTAKE_OUTPUT: the encounter, and the values. */
  encounterId?: unknown; vitals?: unknown; ioType?: unknown; category?: unknown; quantityMl?: unknown; notes?: unknown;
  /** TASK_COMPLETED. */
  taskId?: unknown;
  /** PRN_GIVEN, PRN_BREACH_REFUSED (with the breach the device refused). */
  medicationOrderId?: unknown; breach?: unknown;
}
export interface SyncResult { clientOperationId: string; outcome: OfflineCommand["outcome"]; refusalReason: OfflineRefusalReason | null; conflicts: { kind: OfflineConflictKind; severity: OfflineConflictSeverity }[]; replayed: boolean; note?: string | null }

const DOSE_KINDS = ["DOSE_GIVEN", "DOSE_HELD", "DOSE_REFUSED"] as const;
const RECORD_KINDS = ["VITALS", "INTAKE_OUTPUT", "TASK_COMPLETED", "PRN_GIVEN", "PRN_BREACH_REFUSED"] as const;

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
  return c ? { clientOperationId, outcome: c.outcome, refusalReason: c.refusalReason, conflicts: c.conflicts, replayed: true, note: c.note } : null;
}

/** Who must look at a conflict, and about whom. */
interface ConflictSubject { patientId: string | null; encounterId: string | null; prescriberStaffId: string | null; administrationId: string | null }

async function applyCommand(nurse: NurseActor, device: { id: string; wardId: string }, raw: SyncCommandInput, now: Date): Promise<SyncResult> {
  const clientOperationId = typeof raw.clientOperationId === "string" ? raw.clientOperationId.trim() : "";
  if (!/^[A-Za-z0-9-]{8,100}$/.test(clientOperationId)) throw new BadRequestError("Each command needs a clientOperationId (8–100 letters, digits or dashes).");
  const again = await stored(nurse.facilityId, clientOperationId);
  if (again) return again;
  const deviceMs = typeof raw.deviceTime === "string" ? Date.parse(raw.deviceTime) : NaN;
  if (!Number.isFinite(deviceMs)) throw new BadRequestError("Each command needs a deviceTime.");
  try {
    const dose = DOSE_KINDS.find((k) => k === raw.kind);
    if (dose) return await applyDoseCommand(nurse, device, raw, clientOperationId, dose, deviceMs, now);
    const record = RECORD_KINDS.find((k) => k === raw.kind);
    if (record) return await applyRecordCommand(nurse, device, raw, clientOperationId, record, deviceMs, now);
    throw new BadRequestError(`Unknown command kind. One of: ${[...DOSE_KINDS, ...RECORD_KINDS].join(", ")}.`);
  } catch (e) {
    // The same operation id sent twice at once: the other one won; answer what it recorded.
    if ((e as { code?: string }).code === "P2002") {
      const s = await stored(nurse.facilityId, clientOperationId);
      if (s) return s;
    }
    throw e;
  }
}

function clockOf(deviceMs: number, offsetMs: number, now: Date) {
  const corrected = deviceMs + offsetMs;
  const clockSuspect = corrected > now.getTime() + CLOCK_FUTURE_SLACK_MS || corrected < now.getTime() - CLOCK_PAST_LIMIT_MS;
  return { clockSuspect, appliedTime: new Date(clockSuspect ? now.getTime() : corrected) };
}

type CommandBase = Omit<Prisma.OfflineCommandUncheckedCreateInput, "outcome" | "refusalReason" | "resultAdministrationId" | "note">;

/** The command row with its event, and each conflict with its task: the shared tail of every command's transaction. */
function recorder(tx: Tx, nurse: NurseActor, device: { id: string; wardId: string }, base: CommandBase, subject: ConflictSubject, now: Date) {
  const conflicts: { kind: OfflineConflictKind; severity: OfflineConflictSeverity }[] = [];
  return {
    conflicts,
    record: async (outcome: OfflineCommand["outcome"], refusalReason: OfflineRefusalReason | null, resultAdministrationId: string | null, extra: { note?: string } = {}) => {
      const c = await tx.offlineCommand.create({ data: { ...base, outcome, refusalReason, resultAdministrationId, note: extra.note } });
      await emitFacilityEvent(tx, {
        type: "OfflineCommandRecorded", aggregateId: c.id, facilityId: nurse.facilityId, actorUserId: nurse.userId, encounterId: subject.encounterId,
        payload: {
          commandId: c.id, deviceId: device.id, kind: c.kind, outcome,
          ...(c.administrationId ? { administrationId: c.administrationId } : {}), ...(c.encounterId ? { encounterId: c.encounterId } : {}),
          ...(c.taskId ? { taskId: c.taskId } : {}), ...(c.medicationOrderId ? { medicationOrderId: c.medicationOrderId } : {}),
          ...(refusalReason ? { refusalReason } : {}), ...(resultAdministrationId ? { resultAdministrationId } : {}),
        },
      });
      return c;
    },
    conflict: async (c: OfflineCommand, kind: OfflineConflictKind, severity: OfflineConflictSeverity) => {
      conflicts.push({ kind, severity });
      await raiseConflictTx(tx, nurse, device, c, subject, kind, severity, now);
    },
    finish: (c: OfflineCommand): SyncResult => ({ clientOperationId: c.clientOperationId, outcome: c.outcome, refusalReason: c.refusalReason, conflicts, replayed: false, note: c.note }),
  };
}

async function applyDoseCommand(nurse: NurseActor, device: { id: string; wardId: string }, raw: SyncCommandInput, clientOperationId: string, kind: (typeof DOSE_KINDS)[number], deviceMs: number, now: Date): Promise<SyncResult> {
  if (typeof raw.administrationId !== "string") throw new BadRequestError("A dose command needs an administrationId.");
  const reasonCode = typeof raw.reasonCode === "string" ? raw.reasonCode.trim().slice(0, 60) || undefined : undefined;
  const admin = await prisma.medicationAdministration.findUnique({ where: { id: raw.administrationId }, include: { medicationOrder: { select: { id: true, drugName: true, isControlled: true, status: true, patientId: true, encounterId: true, orderedByStaffId: true, encounter: { select: { facilityId: true } } } } } });
  // The device's live lease on the dose (one re-granted on a fresh pack ends the earlier one), else its latest.
  const lease = admin
    ? (await prisma.doseLease.findFirst({ where: { administrationId: admin.id, deviceId: device.id, status: { not: "RELEASED" } }, orderBy: [{ grantedAt: "desc" }, { id: "desc" }], include: { pack: { select: { clockOffsetMs: true } } } }))
      ?? (await prisma.doseLease.findFirst({ where: { administrationId: admin.id, deviceId: device.id }, orderBy: [{ grantedAt: "desc" }, { id: "desc" }], include: { pack: { select: { clockOffsetMs: true } } } }))
    : null;
  const { clockSuspect, appliedTime } = clockOf(deviceMs, lease?.pack.clockOffsetMs ?? 0, now);
  const ours = admin && admin.medicationOrder.encounter.facilityId === nurse.facilityId;
  const base = { facilityId: nurse.facilityId, clientOperationId, deviceId: device.id, nurseStaffId: nurse.staffId, kind, administrationId: raw.administrationId, deviceTime: new Date(deviceMs), appliedTime, receivedAt: now, reasonCode, ...(ours ? { encounterId: admin.medicationOrder.encounterId, medicationOrderId: admin.medicationOrderId } : {}) };
  const subject: ConflictSubject = ours ? { patientId: admin.medicationOrder.patientId, encounterId: admin.medicationOrder.encounterId, prescriberStaffId: admin.medicationOrder.orderedByStaffId, administrationId: admin.id } : { patientId: null, encounterId: null, prescriberStaffId: null, administrationId: raw.administrationId };

  return prisma.$transaction(async (tx) => {
    const { record, conflict, finish } = recorder(tx, nurse, device, base, subject, now);
    // Unknown, or another facility's dose: refused (and nothing about it is revealed).
    if (!admin || !ours) return finish(await record("REFUSED", "UNKNOWN_DOSE", null));
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
}

// ── Flagship 4a — vitals, intake/output, tasks and PRN doses offline ─────────

/** Plausible ranges: a value outside one is kept for review, never applied (design §5). */
const VITAL_RANGES: Record<keyof Pick<VitalsInput, "hr" | "sbp" | "dbp" | "rr" | "spo2" | "tempC" | "painScore">, [number, number]> = {
  hr: [20, 300], sbp: [40, 300], dbp: [20, 200], rr: [4, 80], spo2: [50, 100], tempC: [30, 45], painScore: [0, 10],
};
const IO_CATEGORIES = { INPUT: ["ORAL", "IV", "ENTERAL", "OTHER"], OUTPUT: ["URINE", "DRAIN", "EMESIS", "STOOL", "OTHER"] } as const;
export const IO_MAX_ML = 10_000;

function parseVitals(raw: unknown): VitalsInput | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const out: VitalsInput = {};
  let any = false;
  for (const [k, [lo, hi]] of Object.entries(VITAL_RANGES) as [keyof typeof VITAL_RANGES, [number, number]][]) {
    if (v[k] === undefined || v[k] === null) continue;
    if (typeof v[k] !== "number" || !Number.isFinite(v[k]) || (v[k] as number) < lo || (v[k] as number) > hi) return null;
    out[k] = v[k] as number;
    any = true;
  }
  if (typeof v.consciousness === "string" && /^[A-Z_]{1,20}$/.test(v.consciousness)) out.consciousness = v.consciousness;
  // Flagship 4d: the tablet asks room air or oxygen for its NEWS2 placeholder; the answer is kept with the set.
  if (v.o2DeliveryMethod === "room air" || v.o2DeliveryMethod === "supplemental oxygen") out.o2DeliveryMethod = v.o2DeliveryMethod;
  return any ? out : null;
}

/** The nurse's open assignment of the patient: the patients whose records a device may write (design §8, least data). */
async function assigned(db: Tx | typeof prisma, nurse: NurseActor, patientId: string, at: Date) {
  return Boolean(await db.nursingAssignment.findFirst({ where: { facilityId: nurse.facilityId, nurseStaffId: nurse.staffId, patientId, startAt: { lte: new Date(Math.max(at.getTime(), Date.now())) }, OR: [{ endAt: null }, { endAt: { gte: at } }] }, select: { id: true } }));
}

async function applyRecordCommand(nurse: NurseActor, device: { id: string; wardId: string }, raw: SyncCommandInput, clientOperationId: string, kind: (typeof RECORD_KINDS)[number], deviceMs: number, now: Date): Promise<SyncResult> {
  // The device's latest pack before the command: its clock offset, and how long it was valid.
  const pack = await prisma.wardPack.findFirst({ where: { deviceId: device.id, issuedAt: { lte: now } }, orderBy: { issuedAt: "desc" }, select: { clockOffsetMs: true, expiresAt: true } });
  const { clockSuspect, appliedTime } = clockOf(deviceMs, pack?.clockOffsetMs ?? 0, now);
  const str = (x: unknown, n = 100) => (typeof x === "string" && x.trim() ? x.trim().slice(0, n) : null);

  // What the command is about, inside this facility (another facility's id reads as unknown).
  let encounter: { id: string; patientId: string } | null = null;
  let task: { id: string; status: string; patientId: string | null; encounterId: string | null; ownerStaffId: string | null; completedAt: Date | null } | null = null;
  let order: { id: string; patientId: string; encounterId: string; drugName: string; isControlled: boolean; status: string; prn: boolean; prnOfflineAllowed: boolean; prnMinIntervalMinutes: number | null; prnMaxDosesPer24h: number | null; orderedByStaffId: string } | null = null;
  if (kind === "VITALS" || kind === "INTAKE_OUTPUT") {
    const e = str(raw.encounterId) ? await prisma.encounter.findUnique({ where: { id: str(raw.encounterId)! }, select: { id: true, patientId: true, facilityId: true } }) : null;
    encounter = e && e.facilityId === nurse.facilityId ? e : null;
  } else if (kind === "TASK_COMPLETED") {
    const t = str(raw.taskId) ? await prisma.task.findUnique({ where: { id: str(raw.taskId)! }, select: { id: true, status: true, patientId: true, encounterId: true, ownerStaffId: true, completedAt: true, facilityId: true } }) : null;
    task = t && t.facilityId === nurse.facilityId ? t : null;
  } else {
    const o = str(raw.medicationOrderId) ? await prisma.medicationOrder.findUnique({ where: { id: str(raw.medicationOrderId)! }, select: { id: true, patientId: true, encounterId: true, drugName: true, isControlled: true, status: true, prn: true, prnOfflineAllowed: true, prnMinIntervalMinutes: true, prnMaxDosesPer24h: true, orderedByStaffId: true, encounter: { select: { facilityId: true } } } }) : null;
    order = o && o.encounter.facilityId === nurse.facilityId ? o : null;
  }
  const patientId = encounter?.patientId ?? task?.patientId ?? order?.patientId ?? null;
  const encounterId = encounter?.id ?? task?.encounterId ?? order?.encounterId ?? null;
  const payload: Record<string, unknown> =
    kind === "VITALS" ? { vitals: raw.vitals ?? null }
    : kind === "INTAKE_OUTPUT" ? { ioType: raw.ioType ?? null, category: raw.category ?? null, quantityMl: raw.quantityMl ?? null, notes: str(raw.notes, 280) }
    : kind === "PRN_BREACH_REFUSED" ? { breach: raw.breach ?? null }
    : {};
  const base: CommandBase = {
    facilityId: nurse.facilityId, clientOperationId, deviceId: device.id, nurseStaffId: nurse.staffId, kind, deviceTime: new Date(deviceMs), appliedTime, receivedAt: now,
    encounterId: encounter?.id ?? (kind === "VITALS" || kind === "INTAKE_OUTPUT" ? null : encounterId), taskId: task?.id ?? null, medicationOrderId: order?.id ?? null,
    payload: payload as Prisma.InputJsonValue,
  };
  const subject: ConflictSubject = { patientId, encounterId, prescriberStaffId: order?.orderedByStaffId ?? null, administrationId: null };

  return prisma.$transaction(async (tx) => {
    const { record, conflict, finish } = recorder(tx, nurse, device, base, subject, now);
    const refuse = async (reason: OfflineRefusalReason, keepAs: OfflineConflictKind = "REFUSED_RECORD") => {
      const c = await record("REFUSED", reason, null);
      await conflict(c, keepAs, "WARNING");
      return finish(c);
    };
    if (kind === "VITALS" || kind === "INTAKE_OUTPUT") {
      if (!encounter) return refuse("UNKNOWN_ENCOUNTER");
      if (!(await assigned(tx, nurse, encounter.patientId, appliedTime))) return refuse("NOT_ASSIGNED");
      if (kind === "VITALS") {
        const vitals = parseVitals(raw.vitals);
        if (!vitals) return refuse("INVALID_VALUES");
        await recordVitalsTx(tx, { encounterId: encounter.id, facilityId: nurse.facilityId, staffId: nurse.staffId, vitals, byUserId: nurse.userId, recordedAt: appliedTime }, await abnormalOf(nurse.facilityId, vitals));
      } else {
        const ioType = raw.ioType === "INPUT" || raw.ioType === "OUTPUT" ? raw.ioType : null;
        const category = ioType && (IO_CATEGORIES[ioType] as readonly string[]).includes(String(raw.category)) ? String(raw.category) : null;
        const ml = typeof raw.quantityMl === "number" && Number.isFinite(raw.quantityMl) && raw.quantityMl > 0 && raw.quantityMl <= IO_MAX_ML ? raw.quantityMl : null;
        if (!ioType || !category || ml === null) return refuse("INVALID_VALUES");
        await recordIntakeOutputTx(tx, { encounterId: encounter.id, facilityId: nurse.facilityId, staffId: nurse.staffId, ioType, category, quantityMl: ml, notes: str(raw.notes, 280) ?? undefined, byUserId: nurse.userId, recordedAt: appliedTime });
      }
      const c = await record(clockSuspect ? "APPLIED_WITH_CONFLICT" : "APPLIED", null, null);
      if (clockSuspect) await conflict(c, "CLOCK_SUSPECT", "WARNING");
      return finish(c);
    }

    if (kind === "TASK_COMPLETED") {
      if (!task) return refuse("UNKNOWN_TASK");
      const mine = task.ownerStaffId === nurse.staffId || (task.patientId ? await assigned(tx, nurse, task.patientId, appliedTime) : false);
      if (!mine) return refuse("NOT_ASSIGNED");
      const closed = await closeTask(tx, task.id, "COMPLETED", { completedByStaffId: nurse.staffId, completedByUserId: nurse.userId, completedAt: appliedTime }, nurse.userId);
      const at = appliedTime.toISOString();
      // Done elsewhere first, or cancelled: the work was done, so the record says so; not an error (design §5).
      const note = closed ? undefined
        : task.status === "COMPLETED" ? `Also done offline by this nurse at ${at}; it was completed first elsewhere.`
        : `Done offline at ${at}, after the task was ${task.status.toLowerCase()}; it stays ${task.status.toLowerCase()}.`;
      await tx.auditEvent.create({ data: { type: "hospital.task.completed", userId: nurse.userId, detail: { taskId: task.id, offline: true, ...(note ? { note } : {}) }, facilityId: nurse.facilityId, patientId: task.patientId ?? undefined, encounterId: task.encounterId ?? undefined } });
      const c = await record(clockSuspect ? "APPLIED_WITH_CONFLICT" : "APPLIED", null, null, { note });
      if (clockSuspect) await conflict(c, "CLOCK_SUSPECT", "WARNING");
      return finish(c);
    }

    // PRN_GIVEN, PRN_BREACH_REFUSED.
    if (!order) return refuse("PRN_NOT_OFFLINE");
    if (!(await assigned(tx, nurse, order.patientId, appliedTime))) return refuse("NOT_ASSIGNED");
    if (kind === "PRN_BREACH_REFUSED") {
      // The device refused a dose for its limits: no dose; the charge nurse is told someone needed one.
      const c = await record("APPLIED_WITH_CONFLICT", null, null);
      await conflict(c, "PRN_BREACH_ATTEMPT", "WARNING");
      return finish(c);
    }
    const offlineOk = order.prn && order.prnOfflineAllowed && order.prnMinIntervalMinutes !== null && order.prnMaxDosesPer24h !== null && ["ACTIVE", "DISPENSED"].includes(order.status);
    if (!offlineOk) return refuse("PRN_NOT_OFFLINE");
    if ((await onlineOnlyOrders(nurse.facilityId, [order])).has(order.id)) return refuse("ONLINE_ONLY", "ONLINE_ONLY");
    if (!pack || appliedTime > pack.expiresAt) return refuse("LEASE_EXPIRED", "LEASE_EXPIRED");
    // One PRN dose of an order at a time (online and offline both lock the order).
    await tx.$queryRaw`SELECT id FROM "MedicationOrder" WHERE id = ${order.id} FOR UPDATE`;
    const standing = await prnStanding(tx, order.id, appliedTime);
    // The dose was given, so it is recorded; a breach by the server's record is flagged CRITICAL.
    const row = await givePrnDoseTx(tx, { orderId: order.id, administeredByStaffId: nurse.staffId, administeredAt: appliedTime, byUserId: nurse.userId, offline: true });
    const hasConflict = Boolean(standing.breach) || clockSuspect;
    const c = await record(hasConflict ? "APPLIED_WITH_CONFLICT" : "APPLIED", null, row.id);
    if (standing.breach) await conflict(c, "PRN_LIMIT_BREACHED", "CRITICAL");
    if (clockSuspect) await conflict(c, "CLOCK_SUSPECT", "WARNING");
    return finish(c);
  });
}

/**
 * A conflict row, its task and their events. The ward's charge nurse on now
 * is told (the shift's, else the ward's named one: a task owned by them, or
 * for the CHARGE_NURSE role when there is none); a possible double dose or a
 * PRN limit breached is CRITICAL, due within 15 minutes, and the facility's
 * pharmacists are told too (decided §12.7); an order changed under an offline
 * dose, or a PRN limit breached, also goes to the prescriber.
 */
async function raiseConflictTx(
  tx: Tx, nurse: NurseActor, device: { id: string; wardId: string }, c: OfflineCommand, subject: ConflictSubject,
  kind: OfflineConflictKind, severity: OfflineConflictSeverity, now: Date,
) {
  const charge = await currentChargeNurse(tx, device.wardId, now);
  const critical = severity === "CRITICAL";
  const patient = subject.patientId ? { patientId: subject.patientId, encounterId: subject.encounterId ?? undefined } : {};
  const title = kind === "POSSIBLE_DOUBLE_DOSE" ? "Possible double dose: check the patient now"
    : kind === "PRN_LIMIT_BREACHED" ? "As-needed dose over its limit: check the patient now"
    : kind === "PRN_BREACH_ATTEMPT" ? "An as-needed dose was refused offline for its limits"
    : kind === "REFUSED_RECORD" ? "An offline record to review" : "Offline dose to review";
  const task = await createTask(tx, {
    facilityId: nurse.facilityId, title, type: "OFFLINE_DOSE_CONFLICT",
    priority: critical ? "STAT" : "URGENT", source: "EVENT", dueAt: new Date(now.getTime() + (critical ? DOUBLE_DOSE_RESPONSE_MS : 4 * 3_600_000)),
    assignedRole: "CHARGE_NURSE", ownerStaffId: charge.staffId ?? undefined, ...patient,
    idempotencyKey: `offline-conflict:${c.id}:${kind}`,
  }, nurse.userId);
  if (critical && subject.patientId) {
    await createTask(tx, {
      facilityId: nurse.facilityId, title: kind === "PRN_LIMIT_BREACHED" ? "As-needed dose over its limit recorded on a ward" : "Possible double dose recorded on a ward", type: "OFFLINE_DOSE_CONFLICT", priority: "STAT", source: "EVENT",
      dueAt: new Date(now.getTime() + DOUBLE_DOSE_RESPONSE_MS), assignedRole: "PHARMACIST", ...patient,
      idempotencyKey: `offline-conflict:${c.id}:${kind}:pharmacist`,
    }, nurse.userId);
  }
  if ((kind === "ORDER_CHANGED" || kind === "PRN_LIMIT_BREACHED") && subject.prescriberStaffId && subject.patientId) {
    await createTask(tx, {
      facilityId: nurse.facilityId, title: kind === "PRN_LIMIT_BREACHED" ? "An as-needed dose over its limit was given offline" : "A dose was given offline after the order changed", type: "OFFLINE_DOSE_CONFLICT", priority: "URGENT", source: "EVENT",
      ownerStaffId: subject.prescriberStaffId, ...patient,
      idempotencyKey: `offline-conflict:${c.id}:${kind}:prescriber`,
    }, nurse.userId);
  }
  // Raised at the sync that found it: the 15-minute response (and its escalation) counts from then.
  const row = await tx.offlineConflict.create({ data: { facilityId: nurse.facilityId, commandId: c.id, administrationId: subject.administrationId, patientId: subject.patientId, kind, severity, taskId: task.id, createdAt: now } });
  await emitFacilityEvent(tx, {
    type: "OfflineConflictRecorded", aggregateId: row.id, facilityId: nurse.facilityId, actorUserId: nurse.userId, encounterId: subject.encounterId,
    payload: { conflictId: row.id, commandId: c.id, kind, severity, taskId: task.id, ...(subject.administrationId ? { administrationId: subject.administrationId } : {}), ...(subject.patientId ? { patientId: subject.patientId } : {}) },
  });
  return row;
}
