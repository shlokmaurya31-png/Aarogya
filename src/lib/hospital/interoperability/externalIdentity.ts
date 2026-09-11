import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { recordProvenance } from "./provenance";
import { getRegistryAdapter } from "./adapters/abdm";
import {
  EXTERNAL_ENTITY_TYPES, IDENTIFIER_STATUSES, assertOneOf, assertSystemMatchesEntity,
  assertEntityInFacility, assertStaffInFacility, maskIdentifier,
} from "./shared";

/**
 * Phase C1 — external identity mapping (ABHA / HFR / HPR and partner registries).
 *
 * The governing rule: these are MAPPINGS. Patient.id remains the patient key,
 * Facility.id the facility key, HospitalStaffProfile.id the staff key. An ABHA
 * number never becomes a primary key, and a patient without one is in no way
 * second-class.
 */

export class ExternalIdentityConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Link an external identifier to a canonical record.
 *
 * Facility ownership of the target entity is proven BEFORE anything is written,
 * which is what stops facility A from attaching an ABHA to facility B patient.
 * Uniqueness is enforced by the database, so two patients in the same facility
 * cannot end up sharing one national identifier even under a concurrent race.
 */
export async function linkExternalIdentifier(input: {
  facilityId: string;
  entityType: string;
  entityId: string;
  system: string;
  value: string;
  use?: string;
  source?: string;
  periodStart?: Date;
  periodEnd?: Date;
  createdByStaffId?: string;
  byUserId: string;
}) {
  assertOneOf(input.entityType, EXTERNAL_ENTITY_TYPES, "entity type");
  const system = input.system?.trim();
  const value = input.value?.trim();
  if (!system) throw new BadRequestError("An identifier system is required.");
  if (!value) throw new BadRequestError("An identifier value is required.");
  if (value.length > 128) throw new BadRequestError("Identifier value is too long.");

  assertSystemMatchesEntity(system, input.entityType);
  await assertEntityInFacility(prisma, input.entityType, input.entityId, input.facilityId);
  if (input.createdByStaffId) await assertStaffInFacility(prisma, input.createdByStaffId, input.facilityId);

  // Surface the two distinguishable conflicts explicitly rather than letting a
  // raw unique violation escape: the same identifier already pointing at a
  // DIFFERENT record is a genuine identity collision an operator must resolve.
  const existingByValue = await prisma.externalIdentifier.findUnique({
    where: { facilityId_system_value: { facilityId: input.facilityId, system, value } },
  });
  if (existingByValue) {
    if (existingByValue.entityId === input.entityId && existingByValue.entityType === input.entityType) {
      throw new BadRequestError("That identifier is already linked to this record.");
    }
    throw new ExternalIdentityConflictError(
      "That identifier is already linked to a different record in this facility. Resolve the identity conflict before relinking."
    );
  }

  const existingForEntity = await prisma.externalIdentifier.findUnique({
    where: {
      facilityId_entityType_entityId_system: {
        facilityId: input.facilityId, entityType: input.entityType, entityId: input.entityId, system,
      },
    },
  });
  if (existingForEntity) {
    throw new ExternalIdentityConflictError(
      "This record already has an identifier from that system. Supersede the existing mapping before adding another."
    );
  }

  const identifier = await prisma.externalIdentifier
    .create({
      data: {
        facilityId: input.facilityId,
        entityType: input.entityType,
        entityId: input.entityId,
        system,
        value,
        use: input.use ?? "OFFICIAL",
        // A newly linked identifier is ALWAYS unverified. Only a genuine
        // registry response may change this.
        verificationStatus: "UNVERIFIED",
        source: input.source ?? "LOCAL_ENTRY",
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        createdByStaffId: input.createdByStaffId,
      },
    })
    .catch((e: unknown) => {
      // Lost the race against a concurrent link of the same identifier.
      if ((e as { code?: string })?.code === "P2002") {
        throw new ExternalIdentityConflictError("That identifier was linked concurrently. Refresh and try again.");
      }
      throw e;
    });

  await recordProvenance(prisma, {
    facilityId: input.facilityId,
    patientId: input.entityType === "PATIENT" ? input.entityId : null,
    entityType: input.entityType,
    entityId: input.entityId,
    direction: "INBOUND",
    dataOrigin: "MAPPED",
    sourceSystem: system,
    externalResourceId: value,
    externalIdentifierId: identifier.id,
    actorUserId: input.byUserId,
    actorStaffId: input.createdByStaffId ?? null,
  });

  // The identifier VALUE is deliberately masked in the audit detail — the audit
  // trail proves a link happened without duplicating a national identifier into
  // a second searchable store.
  await recordAuditEvent(
    "hospital.interop.externalIdentityLinked",
    input.byUserId,
    { identifierId: identifier.id, entityType: input.entityType, entityId: input.entityId, system, value: maskIdentifier(value) },
    { facilityId: input.facilityId, patientId: input.entityType === "PATIENT" ? input.entityId : undefined }
  );
  return identifier;
}

/** Unlinking is a status transition, never a delete — the mapping history stays. */
export async function unlinkExternalIdentifier(input: {
  facilityId: string; identifierId: string; status?: string; reason?: string; byUserId: string;
}) {
  const status = input.status ?? "REVOKED";
  assertOneOf(status, IDENTIFIER_STATUSES, "identifier status");
  if (status === "ACTIVE") throw new BadRequestError("Use the link operation to activate an identifier.");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.externalIdentifier.findUnique({ where: { id: input.identifierId } });
    if (!existing || existing.facilityId !== input.facilityId) throw new NotFoundError("External identifier not found.");

    const r = await tx.externalIdentifier.updateMany({
      where: { id: existing.id, version: existing.version, status: "ACTIVE" },
      data: { status, periodEnd: new Date(), version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ConflictError("That identifier changed concurrently or is no longer active.");

    await tx.auditEvent.create({
      data: {
        type: "hospital.interop.externalIdentityUnlinked",
        userId: input.byUserId,
        detail: { identifierId: existing.id, system: existing.system, status, reason: input.reason ?? null },
        facilityId: existing.facilityId,
        patientId: existing.entityType === "PATIENT" ? existing.entityId : null,
      },
    });
    return tx.externalIdentifier.findUniqueOrThrow({ where: { id: existing.id } });
  });
}

/**
 * Ask the external registry to confirm an identifier.
 *
 * The adapter is the ONLY thing that can promote a mapping to VERIFIED, and it
 * only does so from a real registry response. When the registry is not
 * configured, the mapping stays UNVERIFIED and the caller is told plainly that
 * no external call happened — Aarogya never claims a verification it did not
 * perform.
 */
export async function verifyExternalIdentifier(input: {
  facilityId: string; identifierId: string; byUserId: string;
}) {
  const existing = await prisma.externalIdentifier.findUnique({ where: { id: input.identifierId } });
  if (!existing || existing.facilityId !== input.facilityId) throw new NotFoundError("External identifier not found.");

  const registrySystem = existing.entityType === "FACILITY" ? "HFR" : existing.entityType === "STAFF" ? "HPR" : "ABDM";
  const adapter = getRegistryAdapter(registrySystem);
  const result = await adapter.verify({ system: existing.system, value: existing.value });

  if (result.outcome !== "OK") {
    // Record the attempt and the reason; do NOT touch verificationStatus.
    const updated = await prisma.externalIdentifier.update({
      where: { id: existing.id },
      data: {
        lastSyncedAt: new Date(),
        syncStatus: result.retryable ? "PENDING" : "FAILED",
        syncError: result.message,
        retryCount: { increment: result.retryable ? 1 : 0 },
      },
    });
    await recordAuditEvent(
      "hospital.interop.externalIdentityVerificationAttempted",
      input.byUserId,
      { identifierId: existing.id, system: existing.system, outcome: result.outcome },
      { facilityId: input.facilityId }
    );
    return { identifier: updated, verified: false, outcome: result.outcome, message: result.message };
  }

  const verified = result.data?.verified === true;
  const updated = await prisma.externalIdentifier.update({
    where: { id: existing.id },
    data: {
      verificationStatus: verified ? "VERIFIED" : "FAILED",
      verifiedAt: verified ? new Date() : null,
      lastSyncedAt: new Date(),
      syncStatus: "SYNCED",
      syncError: null,
      retryCount: 0,
      externalUpdatedAt: result.data?.externalUpdatedAt ? new Date(result.data.externalUpdatedAt) : null,
    },
  });

  await recordProvenance(prisma, {
    facilityId: input.facilityId,
    patientId: existing.entityType === "PATIENT" ? existing.entityId : null,
    entityType: existing.entityType,
    entityId: existing.entityId,
    direction: "INBOUND",
    dataOrigin: "EXTERNAL",
    sourceSystem: registrySystem,
    externalResourceId: existing.value,
    externalIdentifierId: existing.id,
    actorUserId: input.byUserId,
  });
  await recordAuditEvent(
    "hospital.interop.externalIdentityVerified",
    input.byUserId,
    { identifierId: existing.id, system: existing.system, verified },
    { facilityId: input.facilityId }
  );
  return { identifier: updated, verified, outcome: result.outcome, message: result.message };
}

/** List mappings for one canonical record, always facility-scoped. */
export async function listExternalIdentifiers(args: {
  facilityId: string; entityType?: string; entityId?: string; system?: string;
}) {
  return prisma.externalIdentifier.findMany({
    where: {
      facilityId: args.facilityId,
      ...(args.entityType ? { entityType: args.entityType } : {}),
      ...(args.entityId ? { entityId: args.entityId } : {}),
      ...(args.system ? { system: args.system } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

/**
 * Resolve a canonical record FROM an external identifier, scoped to one
 * facility. Used by import to find the local patient an inbound resource refers
 * to — it will never reach across a facility boundary.
 */
export async function resolveEntityByIdentifier(args: {
  facilityId: string; system: string; value: string; entityType: string;
}) {
  const row = await prisma.externalIdentifier.findUnique({
    where: { facilityId_system_value: { facilityId: args.facilityId, system: args.system, value: args.value } },
  });
  if (!row || row.status !== "ACTIVE" || row.entityType !== args.entityType) return null;
  return row;
}
