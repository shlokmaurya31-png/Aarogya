import type { OfflineConflictResolution } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { createTask, closeTask } from "@/lib/hospital/task";
import { currentChargeNurse } from "./chargeShift";
import { DOUBLE_DOSE_RESPONSE_MS, NotChargeNurseError, type NurseActor } from "./service";

/**
 * Flagship 4b — the charge nurse's conflict queue (docs/OFFLINE_NURSING_DESIGN.md
 * §5, §12.7, §13.3). For the wards they are the charge nurse of now:
 *
 *   conflicts   possible double doses, PRN limits breached, refused claims and
 *               records, changed orders and the rest, open until resolved;
 *   overrides   doses they (or another charge nurse) took over from a device,
 *               until confirmed in person (design §4: the device may have
 *               given it before it learned).
 *
 * Every resolution and confirmation needs a reason, is audited, and has its
 * event. A CRITICAL conflict still open 15 minutes after it was raised is
 * escalated: the facility's pharmacists get a STAT task and a notification
 * (escalateOfflineConflicts, from the runner).
 */

export const RESOLUTIONS: readonly OfflineConflictResolution[] = ["NO_HARM_FOUND", "INCIDENT_RAISED", "DUPLICATE_RECORD", "RECORD_STANDS", "RECORDED_ONLINE"];

/** The wards the nurse is the charge nurse of at `now` (by shift, else by name where no shift is on). */
export async function chargeWardsOf(nurse: NurseActor, now = new Date()): Promise<string[]> {
  const candidates = await prisma.ward.findMany({
    where: { facilityId: nurse.facilityId, OR: [{ chargeNurseStaffId: nurse.staffId }, { chargeShifts: { some: { staffId: nurse.staffId, status: "ACTIVE", startAt: { lte: now }, endAt: { gt: now } } } }] },
    select: { id: true },
  });
  const out: string[] = [];
  for (const w of candidates) if ((await currentChargeNurse(prisma, w.id, now)).staffId === nurse.staffId) out.push(w.id);
  return out;
}

const SEVERITY_ORDER = { CRITICAL: 0, WARNING: 1 } as const;

export async function conflictQueue(nurse: NurseActor, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const wardIds = await chargeWardsOf(nurse, now);
  if (!wardIds.length) return { wardIds, conflicts: [], overrides: [] };
  const devices = await prisma.wardDevice.findMany({ where: { facilityId: nurse.facilityId, wardId: { in: wardIds } }, select: { id: true, label: true, wardId: true } });
  const deviceIds = devices.map((d) => d.id);
  const label = new Map(devices.map((d) => [d.id, d.label]));
  const rows = await prisma.offlineConflict.findMany({
    where: { facilityId: nurse.facilityId, status: "OPEN", command: { deviceId: { in: deviceIds } } },
    include: { command: { select: { id: true, kind: true, outcome: true, refusalReason: true, deviceId: true, nurseStaffId: true, appliedTime: true, deviceTime: true, receivedAt: true, note: true, administrationId: true, medicationOrderId: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 300,
  });
  const leases = await prisma.doseLease.findMany({
    where: { facilityId: nurse.facilityId, deviceId: { in: deviceIds }, status: "OVERRIDDEN", overrideConfirmedAt: null },
    select: { id: true, administrationId: true, deviceId: true, endedAt: true, endedByUserId: true, overrideReason: true, holderToldAt: true },
    orderBy: [{ endedAt: "asc" }, { id: "asc" }],
    take: 300,
  });

  // Names, for the screen: patients, drugs, nurses and the takeover's charge nurse.
  const adminIds = [...new Set([...rows.map((r) => r.administrationId ?? r.command.administrationId), ...leases.map((l) => l.administrationId)].filter((x): x is string => !!x))];
  const admins = await prisma.medicationAdministration.findMany({ where: { id: { in: adminIds } }, select: { id: true, scheduledAt: true, status: true, medicationOrder: { select: { id: true, drugName: true, dose: true, patientId: true } } } });
  const adminById = new Map(admins.map((a) => [a.id, a]));
  const orderIds = [...new Set(rows.map((r) => r.command.medicationOrderId).filter((x): x is string => !!x))];
  const orders = new Map((await prisma.medicationOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, drugName: true, dose: true } })).map((o) => [o.id, o]));
  const patientIds = [...new Set([...rows.map((r) => r.patientId), ...admins.map((a) => a.medicationOrder.patientId)].filter((x): x is string => !!x))];
  const patients = new Map((await prisma.patient.findMany({ where: { id: { in: patientIds }, facilityId: nurse.facilityId }, select: { id: true, fullName: true, uhid: true } })).map((p) => [p.id, p]));
  const staffIds = [...new Set(rows.map((r) => r.command.nurseStaffId))];
  const staff = new Map((await prisma.hospitalStaffProfile.findMany({ where: { id: { in: staffIds } }, select: { id: true, user: { select: { displayName: true } } } })).map((s) => [s.id, s.user.displayName]));
  const userIds = [...new Set(leases.map((l) => l.endedByUserId).filter((x): x is string => !!x))];
  const users = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
  const tasks = new Map((await prisma.task.findMany({ where: { id: { in: rows.map((r) => r.taskId).filter((x): x is string => !!x) } }, select: { id: true, dueAt: true } })).map((t) => [t.id, t.dueAt]));

  const conflicts = rows.map((r) => {
    const a = adminById.get(r.administrationId ?? r.command.administrationId ?? "");
    const o = r.command.medicationOrderId ? orders.get(r.command.medicationOrderId) : undefined;
    const p = patients.get(r.patientId ?? a?.medicationOrder.patientId ?? "");
    return {
      conflictId: r.id, kind: r.kind, severity: r.severity, raisedAt: r.createdAt.toISOString(), dueAt: r.taskId ? tasks.get(r.taskId)?.toISOString() ?? null : null,
      escalatedAt: r.escalatedAt?.toISOString() ?? null, overdue: r.severity === "CRITICAL" && now.getTime() - r.createdAt.getTime() >= DOUBLE_DOSE_RESPONSE_MS,
      patient: p ? { patientId: p.id, name: p.fullName, uhid: p.uhid } : null,
      drug: a ? `${a.medicationOrder.drugName} ${a.medicationOrder.dose}` : o ? `${o.drugName} ${o.dose}` : null,
      command: { kind: r.command.kind, outcome: r.command.outcome, refusalReason: r.command.refusalReason, recordedAt: r.command.appliedTime.toISOString(), receivedAt: r.command.receivedAt.toISOString(), note: r.command.note },
      device: label.get(r.command.deviceId) ?? null, nurse: staff.get(r.command.nurseStaffId) ?? null,
    };
  }).sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] || x.raisedAt.localeCompare(y.raisedAt));
  const overrides = leases.map((l) => {
    const a = adminById.get(l.administrationId);
    const p = a ? patients.get(a.medicationOrder.patientId) : undefined;
    return {
      leaseId: l.id, takenOverAt: l.endedAt?.toISOString() ?? null, takenOverBy: l.endedByUserId ? users.get(l.endedByUserId) ?? null : null, reason: l.overrideReason,
      deviceSynced: Boolean(l.holderToldAt), device: label.get(l.deviceId) ?? null,
      patient: p ? { patientId: p.id, name: p.fullName, uhid: p.uhid } : null,
      drug: a ? `${a.medicationOrder.drugName} ${a.medicationOrder.dose}` : null, scheduledAt: a?.scheduledAt.toISOString() ?? null, doseStatus: a?.status ?? null,
    };
  });
  return { wardIds, conflicts, overrides };
}

/** The ward a conflict's device belongs to; 404 for another facility's. */
async function conflictWard(facilityId: string, conflictId: string) {
  const c = await prisma.offlineConflict.findUnique({ where: { id: conflictId }, include: { command: { select: { deviceId: true } } } });
  if (!c || c.facilityId !== facilityId) throw new NotFoundError("Conflict not found.");
  const d = await prisma.wardDevice.findUniqueOrThrow({ where: { id: c.command.deviceId }, select: { wardId: true } });
  return { c, wardId: d.wardId };
}

async function assertChargeNurse(nurse: NurseActor, wardId: string, now: Date) {
  if ((await currentChargeNurse(prisma, wardId, now)).staffId !== nurse.staffId) throw new NotChargeNurseError();
}

const reasonOf = (x: unknown) => (typeof x === "string" ? x.trim().slice(0, 500) : "");

/** Resolves a conflict (the ward's charge nurse on now), with a resolution and a reason; its task is completed. */
export async function resolveConflict(nurse: NurseActor, conflictId: string, body: { resolution?: unknown; reason?: unknown }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const { c, wardId } = await conflictWard(nurse.facilityId, conflictId);
  await assertChargeNurse(nurse, wardId, now);
  const resolution = RESOLUTIONS.find((r) => r === body.resolution);
  if (!resolution) throw new BadRequestError(`resolution must be one of ${RESOLUTIONS.join(", ")}.`);
  const reason = reasonOf(body.reason);
  if (!reason) throw new BadRequestError("A reason is required.");
  if (c.status !== "OPEN") throw new ConflictError("This conflict has already been resolved.");
  const done = await prisma.$transaction(async (tx) => {
    const u = await tx.offlineConflict.updateMany({ where: { id: c.id, status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: nurse.userId, resolution, resolutionReason: reason } });
    if (u.count !== 1) throw new ConflictError("This conflict has already been resolved.");
    if (c.taskId) await closeTask(tx, c.taskId, "COMPLETED", { completedByStaffId: nurse.staffId, completedByUserId: nurse.userId, completedAt: now }, nurse.userId);
    await emitFacilityEvent(tx, {
      type: "OfflineConflictResolved", aggregateId: c.id, facilityId: c.facilityId, actorUserId: nurse.userId,
      payload: { conflictId: c.id, kind: c.kind, severity: c.severity, resolution, ...(c.patientId ? { patientId: c.patientId } : {}) },
    });
    return tx.offlineConflict.findUniqueOrThrow({ where: { id: c.id } });
  });
  await recordAuditEvent("hospital.offline.conflict.resolved", nurse.userId, { conflictId: c.id, kind: c.kind, severity: c.severity, resolution, reason }, { facilityId: c.facilityId });
  return done;
}

/** Confirms in person a dose taken over from a device (design §4), with a reason. */
export async function confirmOverride(nurse: NurseActor, leaseId: string, body: { reason?: unknown }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const l = await prisma.doseLease.findUnique({ where: { id: leaseId }, include: { device: { select: { wardId: true } } } });
  if (!l || l.facilityId !== nurse.facilityId || l.status !== "OVERRIDDEN") throw new NotFoundError("No taken-over dose here.");
  await assertChargeNurse(nurse, l.device.wardId, now);
  const reason = reasonOf(body.reason);
  if (!reason) throw new BadRequestError("A reason is required.");
  const done = await prisma.$transaction(async (tx) => {
    const u = await tx.doseLease.updateMany({ where: { id: l.id, overrideConfirmedAt: null }, data: { overrideConfirmedAt: now, overrideConfirmedByUserId: nurse.userId, overrideConfirmReason: reason } });
    if (u.count !== 1) throw new ConflictError("This takeover has already been confirmed.");
    await emitFacilityEvent(tx, { type: "DoseLeaseOverrideConfirmed", aggregateId: l.id, facilityId: l.facilityId, actorUserId: nurse.userId, payload: { leaseId: l.id, administrationId: l.administrationId, deviceId: l.deviceId } });
    return tx.doseLease.findUniqueOrThrow({ where: { id: l.id } });
  });
  await recordAuditEvent("hospital.offline.lease.override.confirmed", nurse.userId, { leaseId: l.id, administrationId: l.administrationId, reason }, { facilityId: l.facilityId });
  return { leaseId: done.id, confirmedAt: done.overrideConfirmedAt?.toISOString() };
}

/**
 * Runner sweep: a CRITICAL conflict still open 15 minutes after it was
 * raised is escalated once. The facility's pharmacists get a STAT task and a
 * notification each, with its event.
 */
export async function escalateOfflineConflicts(opts: { now?: Date; batchSize?: number } = {}) {
  const now = opts.now ?? new Date();
  const due = await prisma.offlineConflict.findMany({
    where: { status: "OPEN", severity: "CRITICAL", escalatedAt: null, createdAt: { lte: new Date(now.getTime() - DOUBLE_DOSE_RESPONSE_MS) } },
    select: { id: true, facilityId: true, kind: true, patientId: true },
    orderBy: { createdAt: "asc" },
    take: opts.batchSize ?? 200,
  });
  let escalated = 0;
  for (const c of due) {
    const pharmacists = await prisma.hospitalStaffProfile.findMany({
      where: { status: "ACTIVE", user: { role: "PHARMACIST" }, OR: [{ user: { facilityMemberships: { some: { facilityId: c.facilityId, status: "ACTIVE" } } } }] },
      select: { id: true }, take: 50,
    });
    const ok = await prisma.$transaction(async (tx) => {
      const u = await tx.offlineConflict.updateMany({ where: { id: c.id, status: "OPEN", escalatedAt: null }, data: { escalatedAt: now } });
      if (u.count !== 1) return false;
      const title = c.kind === "PRN_LIMIT_BREACHED" ? "Unresolved for 15 minutes: an as-needed dose over its limit" : "Unresolved for 15 minutes: a possible double dose";
      await createTask(tx, {
        facilityId: c.facilityId, title, type: "OFFLINE_DOSE_CONFLICT", priority: "STAT", source: "EVENT", dueAt: now, assignedRole: "PHARMACIST",
        ...(c.patientId ? { patientId: c.patientId } : {}), idempotencyKey: `offline-conflict-escalated:${c.id}`,
      }, null);
      for (const p of pharmacists) {
        await tx.notification.create({ data: { facilityId: c.facilityId, recipientStaffId: p.id, type: "OFFLINE_CONFLICT_ESCALATED", category: "CLINICAL", priority: "CRITICAL", title, body: "The ward's charge nurse hasn't resolved it. Check the patient and the MAR.", linkHref: "/hospital-os/pharmacy", patientId: c.patientId, sourceType: "OfflineConflict", sourceId: c.id } });
      }
      await emitFacilityEvent(tx, { type: "OfflineConflictEscalated", aggregateId: c.id, facilityId: c.facilityId, actorUserId: null, payload: { conflictId: c.id, kind: c.kind, pharmacistsTold: pharmacists.length } });
      return true;
    });
    if (ok) escalated += 1;
  }
  return { escalated };
}
