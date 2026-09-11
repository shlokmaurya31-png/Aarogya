import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { recordProvenance, hashPayload } from "../provenance";
import { resolveEntityByIdentifier } from "../externalIdentity";
import { assertPatientInFacility } from "../shared";
import {
  parseFhirPayload, validateResource, validateBundle, readIdentifiers,
  stripUntrustedMeta, FhirValidationError, type ValidatedResource,
} from "./validate";

/**
 * Phase C1 — controlled FHIR import.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: an external FHIR payload never reaches a
 * clinical table. There is no path from here to prisma.patient.update() or any
 * other canonical mutation.
 *
 * What import does instead is STAGE. Each inbound resource is recorded in
 * ImportedResource with its source system, external id, hash and resolved local
 * entity, and is then either:
 *
 *   MAPPED    — understood, matched to a local record, ready for review
 *   CONFLICT  — understood, but disagrees with the local record
 *   REJECTED  — not understood or not permitted
 *
 * Promoting staged data into the canonical record is a deliberate clinical act
 * for a later phase, performed through the existing domain services. Auto-merge
 * is precisely the behaviour that produces wrong-patient records, so it is
 * absent by construction rather than by configuration.
 */

export interface ImportRequest {
  facilityId: string;
  /** Raw request body, so the size limit applies before parsing. */
  rawBody: string;
  sourceSystem: string;
  /** Optional: the local patient the caller asserts this is about. Still verified. */
  patientId?: string | null;
  exchangeId?: string | null;
  correlationId?: string | null;
  actorStaffId?: string | null;
  byUserId: string;
}

export interface ImportedResourceResult {
  resourceType: string;
  externalResourceId: string;
  status: "MAPPED" | "CONFLICT" | "REJECTED" | "IMPORTED";
  localEntityType: string | null;
  localEntityId: string | null;
  reason?: string;
}

export interface ImportResult {
  received: number;
  staged: number;
  conflicts: number;
  rejected: number;
  duplicates: number;
  resources: ImportedResourceResult[];
}

/** Resource types whose subject we can resolve to a local patient. */
const PATIENT_SCOPED = new Set([
  "Encounter", "Condition", "AllergyIntolerance", "Observation", "DiagnosticReport",
  "ServiceRequest", "MedicationRequest", "MedicationAdministration", "CarePlan",
  "DocumentReference", "Procedure",
]);

function externalIdOf(resource: ValidatedResource, index: number): string {
  // Prefer the resource id, fall back to the first identifier, and only then to
  // a positional key — a resource with no stable identity cannot be de-duplicated
  // across retries, and the caller is told so via the staging record.
  if (resource.id) return resource.id;
  const ids = readIdentifiers(resource.raw);
  if (ids.length) return `${ids[0].system}|${ids[0].value}`;
  return `positional-${index}`;
}

/**
 * Resolve which local patient an inbound resource belongs to.
 *
 * Resolution order is deliberate: an external identifier mapping we already hold
 * is authoritative; a caller-asserted patientId is verified against the facility
 * before use; anything else is unresolved. A `subject.reference` from the
 * payload is NEVER treated as a local id — that is the wrong-patient hole.
 */
async function resolvePatient(
  facilityId: string,
  resource: ValidatedResource,
  assertedPatientId?: string | null
): Promise<{ patientId: string | null; reason?: string }> {
  if (resource.resourceType === "Patient") {
    for (const ident of readIdentifiers(resource.raw)) {
      const mapping = await resolveEntityByIdentifier({
        facilityId, system: ident.system, value: ident.value, entityType: "PATIENT",
      });
      if (mapping) return { patientId: mapping.entityId };
    }
    return { patientId: null, reason: "no known external identifier maps to a patient in this facility" };
  }

  if (assertedPatientId) {
    // Verified, never trusted: this throws if the patient is in another facility.
    await assertPatientInFacility(prisma, assertedPatientId, facilityId);
    return { patientId: assertedPatientId };
  }
  return { patientId: null, reason: "no local patient could be resolved for this resource" };
}

/**
 * Detect disagreement between an inbound Patient resource and the local record.
 * A mismatch is surfaced for human review, never auto-merged.
 */
function detectPatientConflict(raw: Record<string, unknown>, local: { fullName: string; sex: string; dob: Date | null }): string | null {
  const problems: string[] = [];

  const names = raw.name;
  if (Array.isArray(names) && names.length) {
    const first = names[0] as Record<string, unknown>;
    const inbound = typeof first?.text === "string"
      ? first.text
      : [first?.family, ...(Array.isArray(first?.given) ? (first.given as string[]) : [])].filter(Boolean).join(" ");
    if (inbound && inbound.trim().toLowerCase() !== local.fullName.trim().toLowerCase()) {
      problems.push("name differs from the local record");
    }
  }

  const gender = raw.gender;
  if (typeof gender === "string" && gender !== "unknown") {
    const localSex = local.sex?.toLowerCase();
    const normalised = localSex?.startsWith("m") ? "male" : localSex?.startsWith("f") ? "female" : localSex;
    if (normalised && normalised !== gender && gender !== "other") problems.push("gender differs from the local record");
  }

  const birthDate = raw.birthDate;
  if (typeof birthDate === "string" && local.dob) {
    if (birthDate !== local.dob.toISOString().slice(0, 10)) problems.push("birth date differs from the local record");
  }

  return problems.length ? problems.join("; ") : null;
}

export async function importFhirPayload(req: ImportRequest): Promise<ImportResult> {
  if (!req.sourceSystem?.trim()) throw new BadRequestError("A source system is required for import.");

  // Validate a caller-asserted patient ONCE, up front, before any resource is
  // examined. Leaving this to the per-resource loop meant a cross-facility
  // patientId was caught by that loop's catch and degraded into a per-resource
  // "rejected" outcome, so probing another facility's patient id returned 200
  // with a staging record instead of being refused. An authorization failure
  // must fail the REQUEST, not be reported as a data-quality result.
  if (req.patientId) {
    await assertPatientInFacility(prisma, req.patientId, req.facilityId);
  }

  const parsed = parseFhirPayload(req.rawBody);
  const top = validateResource(parsed);

  const resources: ValidatedResource[] =
    top.resourceType === "Bundle" ? validateBundle(parsed).entries : [top];

  if (resources.length === 0) throw new FhirValidationError(["payload contained no resources"]);

  const results: ImportedResourceResult[] = [];
  let conflicts = 0, rejected = 0, duplicates = 0, staged = 0;

  for (let i = 0; i < resources.length; i++) {
    const resource = resources[i];
    // meta/security is dropped before anything else looks at the resource.
    const safe = stripUntrustedMeta(resource.raw);
    const externalResourceId = externalIdOf(resource, i);
    const { hash, bytes } = hashPayload(safe);

    // Idempotency: the same external resource from the same source in the same
    // facility resolves to the existing staging row instead of a duplicate.
    const existing = await prisma.importedResource.findUnique({
      where: {
        facilityId_sourceSystem_resourceType_externalResourceId: {
          facilityId: req.facilityId,
          sourceSystem: req.sourceSystem,
          resourceType: resource.resourceType,
          externalResourceId,
        },
      },
    });
    if (existing) {
      duplicates++;
      results.push({
        resourceType: resource.resourceType,
        externalResourceId,
        status: existing.status as ImportedResourceResult["status"],
        localEntityType: existing.localEntityType,
        localEntityId: existing.localEntityId,
        reason: "already received from this source; existing staging record reused",
      });
      continue;
    }

    let status: "MAPPED" | "CONFLICT" | "REJECTED" = "MAPPED";
    let reason: string | undefined;
    let localEntityType: string | null = null;
    let localEntityId: string | null = null;

    try {
      if (!PATIENT_SCOPED.has(resource.resourceType) && resource.resourceType !== "Patient") {
        status = "REJECTED";
        reason = `${resource.resourceType} is not accepted for clinical import in this phase`;
      } else {
        const resolved = await resolvePatient(req.facilityId, resource, req.patientId);
        if (!resolved.patientId) {
          status = "REJECTED";
          reason = resolved.reason;
        } else {
          localEntityType = "PATIENT";
          localEntityId = resolved.patientId;

          if (resource.resourceType === "Patient") {
            const local = await prisma.patient.findUnique({
              where: { id: resolved.patientId },
              select: { fullName: true, sex: true, dob: true },
            });
            const conflict = local ? detectPatientConflict(safe, local) : "local patient not found";
            if (conflict) {
              status = "CONFLICT";
              reason = conflict;
            }
          }
        }
      }
    } catch (e) {
      status = "REJECTED";
      reason = e instanceof Error ? e.message : "resource could not be resolved";
    }

    const row = await prisma.importedResource.create({
      data: {
        facilityId: req.facilityId,
        sourceSystem: req.sourceSystem,
        resourceType: resource.resourceType,
        externalResourceId,
        localEntityType,
        localEntityId,
        status,
        conflictReason: status === "CONFLICT" ? reason : null,
        rejectionReason: status === "REJECTED" ? reason : null,
        exchangeId: req.exchangeId ?? null,
        payloadHash: hash,
        payloadBytes: bytes,
      },
    });

    await recordProvenance(prisma, {
      facilityId: req.facilityId,
      patientId: localEntityId,
      entityType: localEntityType ?? resource.resourceType,
      entityId: localEntityId,
      direction: "INBOUND",
      // EXTERNAL, never LOCAL — this data did not originate here and must never
      // be presented as locally authored.
      dataOrigin: "EXTERNAL",
      sourceSystem: req.sourceSystem,
      externalResourceType: resource.resourceType,
      externalResourceId,
      exchangeId: req.exchangeId ?? null,
      actorUserId: req.byUserId,
      actorStaffId: req.actorStaffId ?? null,
      correlationId: req.correlationId ?? null,
      payload: safe,
      payloadContentType: "application/fhir+json",
    });

    if (status === "CONFLICT") conflicts++;
    else if (status === "REJECTED") rejected++;
    else staged++;

    results.push({ resourceType: resource.resourceType, externalResourceId, status, localEntityType, localEntityId, reason });
    void row;
  }

  await recordAuditEvent(
    "hospital.interop.externalResourceImported",
    req.byUserId,
    { sourceSystem: req.sourceSystem, received: resources.length, staged, conflicts, rejected, duplicates },
    { facilityId: req.facilityId, patientId: req.patientId ?? undefined }
  );
  if (conflicts > 0) {
    await recordAuditEvent(
      "hospital.interop.externalMappingConflict",
      req.byUserId,
      { sourceSystem: req.sourceSystem, conflicts },
      { facilityId: req.facilityId }
    );
  }

  return { received: resources.length, staged, conflicts, rejected, duplicates, resources: results };
}

/** Review queue for staged resources that need a human decision. */
export async function listImportedResources(args: { facilityId: string; status?: string }) {
  return prisma.importedResource.findMany({
    where: { facilityId: args.facilityId, ...(args.status ? { status: args.status } : {}) },
    orderBy: { receivedAt: "desc" },
    take: 200,
  });
}

/**
 * Record the outcome of a human review of a conflicting or staged resource.
 * This marks the staging row only; it does not itself write clinical data.
 */
export async function reviewImportedResource(input: {
  facilityId: string; importedResourceId: string; decision: "REJECTED" | "MAPPED";
  reviewedByStaffId?: string; note?: string; byUserId: string;
}) {
  if (!["REJECTED", "MAPPED"].includes(input.decision)) {
    throw new BadRequestError("decision must be REJECTED or MAPPED.");
  }
  const row = await prisma.importedResource.findUnique({ where: { id: input.importedResourceId } });
  if (!row || row.facilityId !== input.facilityId) throw new NotFoundError("Imported resource not found.");

  const updated = await prisma.importedResource.update({
    where: { id: row.id },
    data: {
      status: input.decision,
      reviewedAt: new Date(),
      reviewedByStaffId: input.reviewedByStaffId,
      rejectionReason: input.decision === "REJECTED" ? input.note ?? row.rejectionReason : null,
      version: { increment: 1 },
    },
  });
  await recordAuditEvent(
    "hospital.interop.externalResourceMapped",
    input.byUserId,
    { importedResourceId: row.id, decision: input.decision },
    { facilityId: input.facilityId }
  );
  return updated;
}
