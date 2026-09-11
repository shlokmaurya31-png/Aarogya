import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { deriveExpiryState } from "@/lib/hospital/workforce/authorization";
import type { Prisma } from "@prisma/client";

/**
 * Phase B10 Workforce foundation — operational assignments, availability, shift/
 * roster, staffing requirements, credentials, privileges. Extends the canonical
 * HospitalStaffProfile identity (never a second employee identity). Every FK to
 * a staff member is validated same-facility server-side; supervisor links reject
 * self-supervision and cross-facility supervisors. Verify/suspend/revoke and
 * availability changes use a version guard for single-winner concurrency; shift
 * assignment relies on a (staffId, startAt) unique + an in-transaction overlap
 * check. NOT an HRIS/payroll — no compensation, attendance, or GPS.
 */

export class WorkforceConcurrencyError extends BadRequestError {
  constructor(message = "This record changed state concurrently. Refresh and try again.") { super(message); }
}

type Db = Prisma.TransactionClient | typeof prisma;

async function assertStaffInFacility(db: Db, staffId: string, facilityId: string) {
  const staff = await db.hospitalStaffProfile.findUnique({ where: { id: staffId } });
  if (!staff || staff.facilityId !== facilityId) throw new NotFoundError("Staff member not found in this facility.");
  return staff;
}

// ══ FACILITY / DEPARTMENT ASSIGNMENTS ══════════════════════════════════════════
export async function createAssignment(input: {
  facilityId: string; staffId: string; departmentId?: string; operationalRole?: string;
  assignmentType?: string; supervisorStaffId?: string; startAt?: Date; createdByStaffId: string; byUserId: string;
}) {
  await assertStaffInFacility(prisma, input.staffId, input.facilityId);
  if (input.supervisorStaffId) {
    if (input.supervisorStaffId === input.staffId) throw new BadRequestError("A staff member cannot supervise themselves.");
    await assertStaffInFacility(prisma, input.supervisorStaffId, input.facilityId); // cross-facility supervisor rejected
  }
  const assignment = await prisma.workforceAssignment.create({
    data: {
      facilityId: input.facilityId, staffId: input.staffId, departmentId: input.departmentId,
      operationalRole: input.operationalRole, assignmentType: input.assignmentType ?? "PRIMARY",
      supervisorStaffId: input.supervisorStaffId, startAt: input.startAt ?? new Date(), createdByStaffId: input.createdByStaffId,
    },
  });
  await recordAuditEvent("hospital.workforce.assignmentCreated", input.byUserId, { assignmentId: assignment.id, staffId: input.staffId, departmentId: input.departmentId }, { facilityId: input.facilityId });
  return assignment;
}

export async function endAssignment(input: { facilityId: string; assignmentId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.workforceAssignment.findUnique({ where: { id: input.assignmentId } });
    if (!a || a.facilityId !== input.facilityId) throw new NotFoundError("Assignment not found.");
    const r = await tx.workforceAssignment.updateMany({ where: { id: a.id, status: "ACTIVE" }, data: { status: "ENDED", endAt: new Date() } });
    if (r.count !== 1) throw new BadRequestError("Assignment is already ended.");
    await tx.auditEvent.create({ data: { type: "hospital.workforce.assignmentEnded", userId: input.byUserId, detail: { assignmentId: a.id }, facilityId: a.facilityId } });
    return tx.workforceAssignment.findUniqueOrThrow({ where: { id: a.id } });
  });
}

// ══ AVAILABILITY (version-guarded single-winner) ═══════════════════════════════
export async function setAvailability(input: { facilityId: string; staffId: string; availability: string; reason?: string; effectiveTo?: Date; setByStaffId: string; byUserId: string }) {
  const valid = ["AVAILABLE", "UNAVAILABLE", "ON_LEAVE", "SUSPENDED", "OFF_DUTY"];
  if (!valid.includes(input.availability)) throw new BadRequestError("Unknown availability state.");
  await assertStaffInFacility(prisma, input.staffId, input.facilityId);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.staffAvailability.findUnique({ where: { staffId: input.staffId } });
    if (!existing) {
      const created = await tx.staffAvailability.create({ data: { facilityId: input.facilityId, staffId: input.staffId, availability: input.availability, reason: input.reason, effectiveTo: input.effectiveTo, setByStaffId: input.setByStaffId } });
      await tx.auditEvent.create({ data: { type: "hospital.workforce.availabilityChanged", userId: input.byUserId, detail: { staffId: input.staffId, availability: input.availability }, facilityId: input.facilityId } });
      return created;
    }
    if (existing.facilityId !== input.facilityId) throw new NotFoundError("Staff availability not found in this facility.");
    const r = await tx.staffAvailability.updateMany({ where: { id: existing.id, version: existing.version }, data: { availability: input.availability, reason: input.reason, effectiveFrom: new Date(), effectiveTo: input.effectiveTo, setByStaffId: input.setByStaffId, version: { increment: 1 } } });
    if (r.count !== 1) throw new WorkforceConcurrencyError();
    await tx.auditEvent.create({ data: { type: "hospital.workforce.availabilityChanged", userId: input.byUserId, detail: { staffId: input.staffId, from: existing.availability, to: input.availability }, facilityId: input.facilityId } });
    return tx.staffAvailability.findUniqueOrThrow({ where: { id: existing.id } });
  });
}

// ══ SHIFTS / ROSTER ════════════════════════════════════════════════════════════
export async function createShift(input: {
  facilityId: string; staffId: string; startAt: Date; endAt: Date; shiftType?: string;
  departmentId?: string; supervisorStaffId?: string; assignedByStaffId: string; byUserId: string;
}) {
  if (input.endAt <= input.startAt) throw new BadRequestError("Shift end must be after its start.");
  await assertStaffInFacility(prisma, input.staffId, input.facilityId);
  if (input.supervisorStaffId) {
    if (input.supervisorStaffId === input.staffId) throw new BadRequestError("A staff member cannot supervise their own shift.");
    await assertStaffInFacility(prisma, input.supervisorStaffId, input.facilityId);
  }
  try {
    return await prisma.$transaction(async (tx) => {
      // Overlap guard: no other SCHEDULED shift for the same staff overlapping this window.
      const overlap = await tx.staffShift.findFirst({
        where: { staffId: input.staffId, status: "SCHEDULED", startAt: { lt: input.endAt }, endAt: { gt: input.startAt } },
      });
      if (overlap) throw new BadRequestError("This staff member already has an overlapping scheduled shift.");
      const shift = await tx.staffShift.create({
        data: { facilityId: input.facilityId, staffId: input.staffId, startAt: input.startAt, endAt: input.endAt, shiftType: input.shiftType, departmentId: input.departmentId, supervisorStaffId: input.supervisorStaffId, assignedByStaffId: input.assignedByStaffId },
      });
      await tx.auditEvent.create({ data: { type: "hospital.workforce.shiftCreated", userId: input.byUserId, detail: { shiftId: shift.id, staffId: input.staffId }, facilityId: input.facilityId } });
      return shift;
    });
  } catch (e) {
    // (staffId, startAt) unique collision — two users assigned the identical shift concurrently (brief §32 race #6).
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") throw new WorkforceConcurrencyError("An identical shift for this staff member already exists.");
    // The findFirst overlap check above is not atomic under PostgreSQL's READ
    // COMMITTED, so two genuinely overlapping shifts can both pass it. The
    // staff_shift_no_overlap EXCLUDE constraint is what actually stops them, and
    // it surfaces as exclusion_violation (23P01) or, when the two inserts wait on
    // each other's range lock, deadlock_detected (40P01). Both mean the same
    // thing to the caller — someone else just booked an overlapping shift — so
    // both are reported as the domain conflict rather than escaping as a 500.
    const code = (e as { code?: string; meta?: { code?: string } })?.code;
    const pgCode = (e as { meta?: { code?: string } })?.meta?.code;
    const msg = e instanceof Error ? e.message : "";
    if (code === "23P01" || pgCode === "23P01" || pgCode === "40P01" || /exclusion constraint|staff_shift_no_overlap|deadlock detected/i.test(msg)) {
      throw new WorkforceConcurrencyError("This staff member already has an overlapping scheduled shift.");
    }
    throw e;
  }
}

export async function cancelShift(input: { facilityId: string; shiftId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const s = await tx.staffShift.findUnique({ where: { id: input.shiftId } });
    if (!s || s.facilityId !== input.facilityId) throw new NotFoundError("Shift not found.");
    const r = await tx.staffShift.updateMany({ where: { id: s.id, status: "SCHEDULED" }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    if (r.count !== 1) throw new BadRequestError("Only a scheduled shift can be cancelled.");
    await tx.auditEvent.create({ data: { type: "hospital.workforce.shiftCancelled", userId: input.byUserId, detail: { shiftId: s.id }, facilityId: s.facilityId } });
    return tx.staffShift.findUniqueOrThrow({ where: { id: s.id } });
  });
}

// ══ STAFFING REQUIREMENTS (informational; no autonomous staffing decisions) ═════
export async function createStaffingRequirement(input: {
  facilityId: string; role: string; minCount: number; departmentId?: string; wardId?: string;
  shiftType?: string; requiredCredentialType?: string; effectiveTo?: Date; createdByStaffId: string; byUserId: string;
}) {
  if (input.minCount < 0) throw new BadRequestError("minCount cannot be negative.");
  const req = await prisma.staffingRequirement.create({
    data: { facilityId: input.facilityId, role: input.role, minCount: input.minCount, departmentId: input.departmentId, wardId: input.wardId, shiftType: input.shiftType, requiredCredentialType: input.requiredCredentialType, effectiveTo: input.effectiveTo, createdByStaffId: input.createdByStaffId },
  });
  await recordAuditEvent("hospital.workforce.requirementCreated", input.byUserId, { requirementId: req.id, role: req.role, minCount: req.minCount }, { facilityId: input.facilityId });
  return req;
}

/** Informational comparison of required vs currently-assigned staffing (brief §17). Never a staffing decision. */
export async function getStaffingCoverage(facilityId: string) {
  const requirements = await prisma.staffingRequirement.findMany({ where: { facilityId, status: "ACTIVE" } });
  const activeAssignments = await prisma.workforceAssignment.findMany({ where: { facilityId, status: "ACTIVE" } });
  return requirements.map((r) => {
    const assigned = activeAssignments.filter((a) => (r.departmentId ? a.departmentId === r.departmentId : true) && (r.role ? a.operationalRole === r.role : true)).length;
    return { requirementId: r.id, role: r.role, departmentId: r.departmentId, minCount: r.minCount, assigned, shortfall: Math.max(0, r.minCount - assigned) };
  });
}

// ══ CREDENTIALS ════════════════════════════════════════════════════════════════
export async function createCredential(input: {
  facilityId: string; staffId: string; credentialType: string; name: string; category?: string;
  issuingAuthority?: string; credentialNumber?: string; issuedAt?: Date; expiresAt?: Date; documentId?: string;
  notes?: string; createdByStaffId: string; byUserId: string;
}) {
  const valid = ["REGISTRATION", "QUALIFICATION", "CERTIFICATION", "LICENSE", "SPECIALTY", "TRAINING"];
  if (!valid.includes(input.credentialType)) throw new BadRequestError("Unknown credential type.");
  await assertStaffInFacility(prisma, input.staffId, input.facilityId);
  if (input.documentId) {
    const doc = await prisma.clinicalDocument.findUnique({ where: { id: input.documentId } });
    if (!doc || doc.facilityId !== input.facilityId) throw new NotFoundError("Document not found in this facility.");
  }
  const cred = await prisma.credential.create({
    data: { facilityId: input.facilityId, staffId: input.staffId, credentialType: input.credentialType, name: input.name, category: input.category, issuingAuthority: input.issuingAuthority, credentialNumber: input.credentialNumber, issuedAt: input.issuedAt, expiresAt: input.expiresAt, documentId: input.documentId, notes: input.notes, createdByStaffId: input.createdByStaffId },
  });
  await recordAuditEvent("hospital.workforce.credentialCreated", input.byUserId, { credentialId: cred.id, staffId: input.staffId, credentialType: cred.credentialType }, { facilityId: input.facilityId });
  return cred;
}

async function guardedCredentialStatus(input: { facilityId: string; credentialId: string; from: string[]; to: string; audit: Parameters<typeof recordAuditEvent>[0]; extra?: Record<string, unknown>; byUserId: string; verifiedByStaffId?: string }) {
  return prisma.$transaction(async (tx) => {
    const cred = await tx.credential.findUnique({ where: { id: input.credentialId } });
    if (!cred || cred.facilityId !== input.facilityId) throw new NotFoundError("Credential not found.");
    if (!input.from.includes(cred.status)) throw new BadRequestError(`Credential is ${cred.status}; cannot move to ${input.to}.`);
    const r = await tx.credential.updateMany({ where: { id: cred.id, version: cred.version }, data: { status: input.to, version: { increment: 1 }, ...(input.extra ?? {}) } });
    if (r.count !== 1) throw new WorkforceConcurrencyError();
    await tx.auditEvent.create({ data: { type: input.audit, userId: input.byUserId, detail: { credentialId: cred.id, from: cred.status, to: input.to }, facilityId: cred.facilityId } });
    return tx.credential.findUniqueOrThrow({ where: { id: cred.id } });
  });
}

/**
 * Verification is the maker/checker half of credentialing, so it enforces two
 * things the generic status guard cannot: the verifier must be an active member
 * of this facility, and must not be the person who recorded the credential or
 * the person it belongs to. Without that, a staff member could file their own
 * registration and mark it VERIFIED — self-credentialing straight past every
 * requireCredential() gate (gate §39 maker/checker, §10 escalation).
 */
export async function verifyCredential(input: { facilityId: string; credentialId: string; verifiedByStaffId: string; byUserId: string }) {
  const cred = await prisma.credential.findUnique({ where: { id: input.credentialId } });
  if (!cred || cred.facilityId !== input.facilityId) throw new NotFoundError("Credential not found.");
  await assertStaffInFacility(prisma, input.verifiedByStaffId, input.facilityId);
  if (cred.staffId === input.verifiedByStaffId) throw new BadRequestError("A credential cannot be verified by the staff member it belongs to.");
  if (cred.createdByStaffId === input.verifiedByStaffId) throw new BadRequestError("A credential must be verified by someone other than the person who recorded it.");
  return guardedCredentialStatus({ facilityId: input.facilityId, credentialId: input.credentialId, from: ["PENDING", "SUSPENDED"], to: "VERIFIED", audit: "hospital.workforce.credentialVerified", extra: { verifiedByStaffId: input.verifiedByStaffId, verifiedAt: new Date() }, byUserId: input.byUserId });
}
export function suspendCredential(input: { facilityId: string; credentialId: string; byUserId: string }) {
  return guardedCredentialStatus({ facilityId: input.facilityId, credentialId: input.credentialId, from: ["PENDING", "VERIFIED"], to: "SUSPENDED", audit: "hospital.workforce.credentialSuspended", byUserId: input.byUserId });
}
export function revokeCredential(input: { facilityId: string; credentialId: string; byUserId: string }) {
  return guardedCredentialStatus({ facilityId: input.facilityId, credentialId: input.credentialId, from: ["PENDING", "VERIFIED", "SUSPENDED"], to: "REVOKED", audit: "hospital.workforce.credentialRevoked", byUserId: input.byUserId });
}

/** Read-time expiry classification for a staff member's credentials/privileges (brief §39). */
export function classifyExpiry(rows: { expiresAt: Date | null }[], now = new Date()) {
  return rows.map((r) => deriveExpiryState(r.expiresAt, now));
}

// ══ PRIVILEGES ═════════════════════════════════════════════════════════════════
export async function grantPrivilege(input: {
  facilityId: string; staffId: string; privilegeType: string; scope?: string; expiresAt?: Date;
  documentId?: string; notes?: string; grantedByStaffId: string; byUserId: string;
}) {
  await assertStaffInFacility(prisma, input.staffId, input.facilityId);
  await assertStaffInFacility(prisma, input.grantedByStaffId, input.facilityId);
  // Granting yourself a clinical privilege is the most direct escalation path
  // there is, so it is refused outright (gate §39). createCredential already
  // validates its document reference; do the same here.
  if (input.staffId === input.grantedByStaffId) throw new BadRequestError("A clinical privilege cannot be granted to yourself.");
  if (input.documentId) {
    const doc = await prisma.clinicalDocument.findUnique({ where: { id: input.documentId } });
    if (!doc || doc.facilityId !== input.facilityId) throw new NotFoundError("Document not found in this facility.");
  }
  const priv = await prisma.staffPrivilege.create({
    data: { facilityId: input.facilityId, staffId: input.staffId, privilegeType: input.privilegeType, scope: input.scope, expiresAt: input.expiresAt, documentId: input.documentId, notes: input.notes, grantedByStaffId: input.grantedByStaffId },
  });
  await recordAuditEvent("hospital.workforce.privilegeGranted", input.byUserId, { privilegeId: priv.id, staffId: input.staffId, privilegeType: priv.privilegeType }, { facilityId: input.facilityId });
  return priv;
}

async function guardedPrivilegeStatus(input: { facilityId: string; privilegeId: string; from: string[]; to: string; audit: Parameters<typeof recordAuditEvent>[0]; extra?: Record<string, unknown>; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const priv = await tx.staffPrivilege.findUnique({ where: { id: input.privilegeId } });
    if (!priv || priv.facilityId !== input.facilityId) throw new NotFoundError("Privilege not found.");
    if (!input.from.includes(priv.status)) throw new BadRequestError(`Privilege is ${priv.status}; cannot move to ${input.to}.`);
    const r = await tx.staffPrivilege.updateMany({ where: { id: priv.id, version: priv.version }, data: { status: input.to, version: { increment: 1 }, ...(input.extra ?? {}) } });
    if (r.count !== 1) throw new WorkforceConcurrencyError();
    await tx.auditEvent.create({ data: { type: input.audit, userId: input.byUserId, detail: { privilegeId: priv.id, from: priv.status, to: input.to }, facilityId: priv.facilityId } });
    return tx.staffPrivilege.findUniqueOrThrow({ where: { id: priv.id } });
  });
}

export function suspendPrivilege(input: { facilityId: string; privilegeId: string; byUserId: string }) {
  return guardedPrivilegeStatus({ facilityId: input.facilityId, privilegeId: input.privilegeId, from: ["ACTIVE"], to: "SUSPENDED", audit: "hospital.workforce.privilegeSuspended", extra: { suspendedAt: new Date() }, byUserId: input.byUserId });
}
export function reinstatePrivilege(input: { facilityId: string; privilegeId: string; byUserId: string }) {
  return guardedPrivilegeStatus({ facilityId: input.facilityId, privilegeId: input.privilegeId, from: ["SUSPENDED"], to: "ACTIVE", audit: "hospital.workforce.privilegeGranted", extra: { suspendedAt: null }, byUserId: input.byUserId });
}
export function revokePrivilege(input: { facilityId: string; privilegeId: string; revokedByStaffId: string; byUserId: string }) {
  return guardedPrivilegeStatus({ facilityId: input.facilityId, privilegeId: input.privilegeId, from: ["ACTIVE", "SUSPENDED"], to: "REVOKED", audit: "hospital.workforce.privilegeRevoked", extra: { revokedByStaffId: input.revokedByStaffId, revokedAt: new Date() }, byUserId: input.byUserId });
}
