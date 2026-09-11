import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { assertExchangeAuthorized } from "../consent";
import { recordProvenance } from "../provenance";
import { assertPatientInFacility, consentCoversScope } from "../shared";
import {
  mapPatientToFhir, mapEncounterToFhir, mapDiagnosisToFhir, mapAllergyToFhir,
  mapVitalToFhirObservations, mapLabResultToFhir, mapMedicationOrderToFhir,
  mapDocumentToFhir, mapOrganizationToFhir, mapPractitionerToFhir,
} from "./mappers";
import { buildDocumentBundle, hashBundle, countResources, type DocumentBundleType } from "./bundle";
import type { FhirBundle, FhirResource } from "./types";

/**
 * Phase C1 — controlled FHIR export.
 *
 * There is deliberately NO "export any patient by id" path. Every export must
 * pass, in order:
 *
 *   1. an authenticated caller with the right permission (enforced at the route)
 *   2. facility isolation — the patient must belong to the caller facility
 *   3. purpose + scope + recipient + consent validity (assertExchangeAuthorized)
 *   4. scope filtering — only the consented data classes are composed
 *   5. provenance + audit
 *
 * Skipping any one of these would turn this into a bulk patient-data endpoint.
 */

export interface ExportRequest {
  facilityId: string;
  patientId: string;
  purpose: string;
  scopes: string[];
  consentId?: string | null;
  recipientIdentifier?: string | null;
  encounterId?: string | null;
  bundleType?: DocumentBundleType;
  exchangeId?: string | null;
  correlationId?: string | null;
  actorStaffId?: string | null;
  byUserId: string;
  /** Injected so a bundle is reproducible and testable; defaults to now. */
  timestamp?: Date;
}

export interface ExportResult {
  bundle: FhirBundle;
  bundleHash: string;
  resourceCount: number;
  scopes: string[];
  basis: "CONSENT" | "PATIENT_ACCESS";
  consentId: string | null;
}

/**
 * Compose a patient record as a FHIR DocumentBundle, limited to consented scopes.
 */
export async function exportPatientToFhir(req: ExportRequest): Promise<ExportResult> {
  const authorization = await assertExchangeAuthorized({
    facilityId: req.facilityId,
    patientId: req.patientId,
    purpose: req.purpose,
    scopes: req.scopes,
    consentId: req.consentId,
    recipientIdentifier: req.recipientIdentifier,
  });

  const grantedScopes = authorization.consent
    ? authorization.consent.scopes.map((s) => s.scope)
    : authorization.scopes;
  // Effective scopes = what was asked for AND what is permitted. A consent for
  // LAB never yields medication data even if the caller asked for it.
  const allow = (scope: string) =>
    authorization.scopes.includes(scope) && (authorization.basis === "PATIENT_ACCESS" || consentCoversScope(grantedScopes, scope));

  const patient = await assertPatientInFacility(prisma, req.patientId, req.facilityId);
  void patient;

  const [patientRow, facility] = await Promise.all([
    prisma.patient.findUniqueOrThrow({ where: { id: req.patientId } }),
    prisma.facility.findUniqueOrThrow({ where: { id: req.facilityId } }),
  ]);

  // External identifiers are scoped to this facility, so an export can never
  // leak a mapping another facility holds for the same person.
  const externalIds = await prisma.externalIdentifier.findMany({
    where: { facilityId: req.facilityId, entityType: "PATIENT", entityId: req.patientId, status: "ACTIVE" },
    select: { system: true, value: true, use: true, status: true },
  });
  const facilityIds = await prisma.externalIdentifier.findMany({
    where: { facilityId: req.facilityId, entityType: "FACILITY", entityId: req.facilityId, status: "ACTIVE" },
    select: { system: true, value: true, use: true, status: true },
  });

  const subject = mapPatientToFhir(patientRow, {
    externalIdentifiers: externalIds,
    organizationId: facility.id,
  });
  const custodian = mapOrganizationToFhir(facility, { externalIdentifiers: facilityIds });

  // Encounters bound the export. When an encounterId is supplied it is checked
  // against the patient, closing the wrong-encounter path.
  let encounters = await prisma.encounter.findMany({
    where: { patientId: req.patientId, facilityId: req.facilityId },
    orderBy: { registeredAt: "desc" },
    take: 50,
  });
  if (req.encounterId) {
    const match = encounters.find((e) => e.id === req.encounterId);
    if (!match) throw new BadRequestError("That encounter does not belong to this patient in this facility.");
    encounters = [match];
  }
  const encounterIds = encounters.map((e) => e.id);

  const sections: { title: string; resources: FhirResource[] }[] = [];
  const practitionerIds = new Set<string>();

  if (allow("ENCOUNTER") && encounters.length) {
    sections.push({ title: "Encounters", resources: encounters.map((e) => mapEncounterToFhir(e)) });
    encounters.forEach((e) => e.attendingStaffId && practitionerIds.add(e.attendingStaffId));
  }

  if (allow("DIAGNOSIS") && encounterIds.length) {
    const diagnoses = await prisma.diagnosis.findMany({
      where: { patientId: req.patientId, encounterId: { in: encounterIds } },
      orderBy: { createdAt: "desc" }, take: 200,
    });
    if (diagnoses.length) {
      sections.push({ title: "Diagnoses", resources: diagnoses.map(mapDiagnosisToFhir) });
      diagnoses.forEach((d) => practitionerIds.add(d.diagnosedByStaffId));
    }
  }

  if (allow("ALLERGY")) {
    const allergies = await prisma.allergy.findMany({
      where: { patientId: req.patientId }, orderBy: { recordedAt: "desc" }, take: 100,
    });
    if (allergies.length) sections.push({ title: "Allergies", resources: allergies.map(mapAllergyToFhir) });
  }

  if (allow("VITALS") && encounterIds.length) {
    const vitals = await prisma.vital.findMany({
      where: { encounterId: { in: encounterIds } }, orderBy: { recordedAt: "desc" }, take: 100,
    });
    const observations = vitals.flatMap((v) => mapVitalToFhirObservations(v, req.patientId));
    if (observations.length) {
      sections.push({ title: "Vital signs", resources: observations });
      vitals.forEach((v) => practitionerIds.add(v.recordedByStaffId));
    }
  }

  if (allow("LAB") && encounterIds.length) {
    const labResults = await prisma.labResult.findMany({
      where: { isCurrent: true, labOrder: { patientId: req.patientId, encounterId: { in: encounterIds } } },
      include: { labOrder: { select: { encounterId: true, testName: true } } },
      orderBy: { resultedAt: "desc" }, take: 200,
    });
    if (labResults.length) {
      sections.push({
        title: "Laboratory results",
        resources: labResults.map((r) =>
          mapLabResultToFhir(
            { ...r, testName: r.labOrder?.testName ?? null, loincCode: null },
            { patientId: req.patientId, encounterId: r.labOrder?.encounterId ?? null }
          )
        ),
      });
      labResults.forEach((r) => r.releasedByStaffId && practitionerIds.add(r.releasedByStaffId));
    }
  }

  if (allow("MEDICATION") && encounterIds.length) {
    const orders = await prisma.medicationOrder.findMany({
      where: { patientId: req.patientId, encounterId: { in: encounterIds } },
      orderBy: { orderedAt: "desc" }, take: 200,
    });
    if (orders.length) {
      // externalCode stays null unless a terminology mapping supplies one.
      sections.push({ title: "Medications", resources: orders.map((o) => mapMedicationOrderToFhir({ ...o, externalCode: null })) });
      orders.forEach((o) => practitionerIds.add(o.orderedByStaffId));
    }
  }

  if (allow("DOCUMENTS")) {
    const documents = await prisma.clinicalDocument.findMany({
      where: {
        facilityId: req.facilityId,
        patientId: req.patientId,
        status: "CURRENT",
        // RESTRICTED documents are never swept into a bulk export; releasing
        // them is a separate, deliberate decision.
        accessPolicy: { not: "RESTRICTED" },
        ...(req.encounterId ? { encounterId: req.encounterId } : {}),
      },
      orderBy: { createdAt: "desc" }, take: 100,
    });
    if (documents.length) {
      sections.push({ title: "Documents", resources: documents.map(mapDocumentToFhir) });
      documents.forEach((d) => d.authorStaffId && practitionerIds.add(d.authorStaffId));
    }
  }

  // Author: the staff member performing the export when known, otherwise the
  // custodian organization. Never fabricated.
  let author: FhirResource = custodian;
  if (req.actorStaffId) {
    const staff = await prisma.hospitalStaffProfile.findUnique({ where: { id: req.actorStaffId } });
    if (staff && staff.facilityId === req.facilityId) {
      author = mapPractitionerToFhir({ ...staff, displayName: null });
      practitionerIds.delete(staff.id);
    }
  }

  if (practitionerIds.size) {
    const staff = await prisma.hospitalStaffProfile.findMany({
      where: { id: { in: [...practitionerIds] }, facilityId: req.facilityId },
    });
    if (staff.length) {
      sections.push({ title: "Practitioners", resources: staff.map((s) => mapPractitionerToFhir({ ...s, displayName: null })) });
    }
  }

  const timestamp = req.timestamp ?? new Date();
  const bundle = buildDocumentBundle({
    bundleType: req.bundleType ?? "HEALTH_DOCUMENT",
    bundleId: req.exchangeId ?? `${req.patientId}-${timestamp.getTime()}`,
    timestamp,
    subject,
    author,
    custodian,
    sections,
  });

  const bundleHash = hashBundle(bundle);
  const resourceCount = countResources(bundle);

  await recordProvenance(prisma, {
    facilityId: req.facilityId,
    patientId: req.patientId,
    entityType: "PATIENT",
    entityId: req.patientId,
    direction: "OUTBOUND",
    // The bundle is DERIVED from canonical records — it is a representation,
    // not a new clinical fact and not an imported one.
    dataOrigin: "DERIVED",
    sourceSystem: "AAROGYA",
    exchangeId: req.exchangeId ?? null,
    consentId: authorization.consent?.id ?? null,
    actorUserId: req.byUserId,
    actorStaffId: req.actorStaffId ?? null,
    correlationId: req.correlationId ?? null,
    payload: bundle,
    payloadContentType: "application/fhir+json",
  });

  await recordAuditEvent(
    "hospital.interop.fhirExported",
    req.byUserId,
    {
      patientId: req.patientId, purpose: req.purpose, scopes: authorization.scopes,
      basis: authorization.basis, consentId: authorization.consent?.id ?? null,
      resourceCount, bundleHash,
    },
    { facilityId: req.facilityId, patientId: req.patientId }
  );

  return {
    bundle,
    bundleHash,
    resourceCount,
    scopes: authorization.scopes,
    basis: authorization.basis,
    consentId: authorization.consent?.id ?? null,
  };
}
