import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { TERMINOLOGY_DOMAINS, assertOneOf } from "./shared";

/**
 * Phase C1 — terminology mapping.
 *
 * This is the LAYER, not the data. No national terminology set (SNOMED CT, LOINC,
 * ICD-10, NDC) is bundled: those are licensed, versioned artefacts that belong in
 * a deliberate data-loading phase, not baked into application code.
 *
 * What this enforces is the separation the rest of the system depends on: an
 * Aarogya local code is NOT an external code. A mapper only ever emits an
 * external coding when a mapping row genuinely supplies one; otherwise the FHIR
 * resource carries text only. That is why an unmapped drug or diagnosis exports
 * honestly instead of acquiring a fabricated code.
 */

export interface TerminologyLookup {
  facilityId: string;
  domain: string;
  localSystem: string;
  localCode: string;
  externalSystem: string;
}

export async function createTerminologyMapping(input: {
  facilityId?: string | null;
  domain: string;
  localSystem: string;
  localCode: string;
  localDisplay?: string;
  externalSystem: string;
  externalCode: string;
  externalDisplay?: string;
  mapVersion?: string;
  createdByStaffId?: string;
  byUserId: string;
}) {
  assertOneOf(input.domain, TERMINOLOGY_DOMAINS, "terminology domain");
  for (const [label, value] of Object.entries({
    localSystem: input.localSystem, localCode: input.localCode,
    externalSystem: input.externalSystem, externalCode: input.externalCode,
  })) {
    if (!value?.trim()) throw new BadRequestError(`${label} is required.`);
    if (value.length > 256) throw new BadRequestError(`${label} is too long.`);
  }

  const mapping = await prisma.terminologyMapping
    .create({
      data: {
        facilityId: input.facilityId ?? null,
        domain: input.domain,
        localSystem: input.localSystem.trim(),
        localCode: input.localCode.trim(),
        localDisplay: input.localDisplay,
        externalSystem: input.externalSystem.trim(),
        externalCode: input.externalCode.trim(),
        externalDisplay: input.externalDisplay,
        mapVersion: input.mapVersion,
        createdByStaffId: input.createdByStaffId,
      },
    })
    .catch((e: unknown) => {
      if ((e as { code?: string })?.code === "P2002") {
        throw new ConflictError("A mapping for that local code and external system already exists.");
      }
      throw e;
    });

  await recordAuditEvent(
    "hospital.interop.terminologyMapped",
    input.byUserId,
    { mappingId: mapping.id, domain: mapping.domain, localCode: mapping.localCode, externalSystem: mapping.externalSystem },
    { facilityId: input.facilityId ?? undefined }
  );
  return mapping;
}

/**
 * Resolve a local code to an external coding.
 *
 * Facility-specific mappings win over global ones, so a facility can override a
 * shared default without editing it. Returns null when nothing is mapped —
 * callers MUST treat null as "emit text only", never as a reason to guess.
 */
export async function resolveExternalCode(lookup: TerminologyLookup) {
  const rows = await prisma.terminologyMapping.findMany({
    where: {
      domain: lookup.domain,
      localSystem: lookup.localSystem,
      localCode: lookup.localCode,
      externalSystem: lookup.externalSystem,
      status: "ACTIVE",
      OR: [{ facilityId: lookup.facilityId }, { facilityId: null }],
    },
  });
  if (rows.length === 0) return null;
  const preferred = rows.find((r) => r.facilityId === lookup.facilityId) ?? rows[0];
  return { system: preferred.externalSystem, code: preferred.externalCode, display: preferred.externalDisplay ?? undefined };
}

/** Bulk variant so an export does not issue one query per row. */
export async function resolveExternalCodes(
  facilityId: string, domain: string, externalSystem: string,
  codes: { localSystem: string; localCode: string }[]
) {
  if (codes.length === 0) return new Map<string, { system: string; code: string; display?: string }>();
  const rows = await prisma.terminologyMapping.findMany({
    where: {
      domain, externalSystem, status: "ACTIVE",
      localCode: { in: [...new Set(codes.map((c) => c.localCode))] },
      OR: [{ facilityId }, { facilityId: null }],
    },
  });
  const out = new Map<string, { system: string; code: string; display?: string }>();
  for (const row of rows) {
    const key = `${row.localSystem}|${row.localCode}`;
    // Facility-specific overrides a global mapping for the same key.
    if (out.has(key) && row.facilityId === null) continue;
    out.set(key, { system: row.externalSystem, code: row.externalCode, display: row.externalDisplay ?? undefined });
  }
  return out;
}

export async function retireTerminologyMapping(input: { facilityId: string; mappingId: string; byUserId: string }) {
  const row = await prisma.terminologyMapping.findUnique({ where: { id: input.mappingId } });
  // A global mapping (facilityId null) is not retirable by a single facility.
  if (!row || (row.facilityId !== null && row.facilityId !== input.facilityId)) {
    throw new NotFoundError("Terminology mapping not found.");
  }
  if (row.facilityId === null) throw new BadRequestError("A shared mapping cannot be retired by one facility.");

  const updated = await prisma.terminologyMapping.update({
    where: { id: row.id }, data: { status: "RETIRED" },
  });
  await recordAuditEvent(
    "hospital.interop.terminologyMapped",
    input.byUserId,
    { mappingId: row.id, retired: true },
    { facilityId: input.facilityId }
  );
  return updated;
}

export async function listTerminologyMappings(args: { facilityId: string; domain?: string }) {
  return prisma.terminologyMapping.findMany({
    where: {
      ...(args.domain ? { domain: args.domain } : {}),
      OR: [{ facilityId: args.facilityId }, { facilityId: null }],
    },
    orderBy: [{ domain: "asc" }, { localCode: "asc" }],
    take: 500,
  });
}
