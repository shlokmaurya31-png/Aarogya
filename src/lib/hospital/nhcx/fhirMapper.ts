import { buildCollectionBundle } from "@/lib/hospital/interoperability/fhir/bundle";
import { mapPatientToFhir, mapDiagnosisToFhir, mapDocumentToFhir } from "@/lib/hospital/interoperability/fhir/mappers";
import type { FhirBundle, FhirResource, FhirCodeableConcept, FhirReference } from "@/lib/hospital/interoperability/fhir/types";
import { NHCX_CLAIM_BUNDLE_TYPE, FHIR_R4_BASE } from "./contract";
import type { ClaimPackage } from "./claimPackage";

/**
 * Phase C5 — canonical claim package to FHIR R4 representation.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * VERIFIED CONTRACT (NRCeS, Sept 2024)
 *
 * A claim request is Patient, Coverage, Practitioner, Procedure and Condition
 * resources grouped in a Bundle of type "collection".
 *
 * That bundle type is the single most consequential verified fact in this
 * phase. C1 built buildDocumentBundle for CLINICAL exchange — Composition-first,
 * type "document". Using it for a claim would produce a structurally wrong
 * payload, so this file deliberately calls buildCollectionBundle instead, and
 * asserts the type.
 *
 * REUSE, NOT REIMPLEMENTATION: Patient, Condition and DocumentReference come
 * from the C1 mappers. Only the genuinely claim-specific resources — Coverage,
 * Claim — are added here, because C1 had no reason to model them.
 * ════════════════════════════════════════════════════════════════════════════
 */

function money(amountMinor: number) {
  // Minor units are the canonical internal representation; FHIR Money expects a
  // decimal. Converted only at the boundary, never stored back as a float.
  return { value: amountMinor / 100, currency: "INR" };
}

function ref(type: string, id: string): FhirReference {
  return { reference: `${type}/${id}`, type };
}

function coding(system: string, code: string, display?: string): FhirCodeableConcept {
  return { coding: [{ system, code, ...(display ? { display } : {}) }], ...(display ? { text: display } : {}) };
}

/** FHIR Coverage from canonical PatientCoverage. */
export function mapCoverageToFhir(pkg: ClaimPackage): FhirResource {
  return {
    resourceType: "Coverage",
    id: pkg.coverage.id,
    identifier: [{ system: "https://aarogya.local/coverage", value: pkg.coverage.memberId }],
    status: pkg.coverage.status === "ACTIVE" ? "active" : "cancelled",
    beneficiary: ref("Patient", pkg.patient.id),
    // subscriberId is the member id: the identifier the PAYER knows the patient
    // by, which is deliberately distinct from the Aarogya patient id.
    subscriberId: pkg.coverage.memberId,
    payor: [ref("Organization", pkg.coverage.payerId)],
    period: {
      start: pkg.coverage.validFrom.toISOString(),
      ...(pkg.coverage.validTo ? { end: pkg.coverage.validTo.toISOString() } : {}),
    },
  } as unknown as FhirResource;
}

/** FHIR Organization for the payer. */
export function mapPayerToFhir(pkg: ClaimPackage, participantCode?: string | null): FhirResource {
  return {
    resourceType: "Organization",
    id: pkg.coverage.payerId,
    // The participant code is emitted ONLY when a mapping genuinely exists.
    ...(participantCode
      ? { identifier: [{ system: "https://aarogya.local/nhcx/participant", value: participantCode }] }
      : {}),
    active: true,
    name: pkg.coverage.payerName,
    type: [coding(`${FHIR_R4_BASE}/CodeSystem/organization-type`, "ins", "Insurance Company")],
  } as unknown as FhirResource;
}

/** FHIR Organization for the submitting provider facility. */
export function mapProviderToFhir(facilityId: string, facilityName: string, hfrCode?: string | null): FhirResource {
  return {
    resourceType: "Organization",
    id: facilityId,
    ...(hfrCode ? { identifier: [{ system: "https://facility.abdm.gov.in", value: hfrCode }] } : {}),
    active: true,
    name: facilityName,
    type: [coding(`${FHIR_R4_BASE}/CodeSystem/organization-type`, "prov", "Healthcare Provider")],
  } as unknown as FhirResource;
}

/**
 * FHIR Claim from the canonical package.
 *
 * Every monetary value comes from the recomputed package totals, never from
 * anything a caller supplied.
 */
export function mapClaimToFhir(pkg: ClaimPackage, opts: { useKind?: "claim" | "preauthorization" } = {}): FhirResource {
  const use = opts.useKind ?? "claim";
  return {
    resourceType: "Claim",
    id: pkg.claim.id,
    ...(pkg.claim.claimNumber
      ? { identifier: [{ system: "https://aarogya.local/claim", value: pkg.claim.claimNumber }] }
      : {}),
    status: "active",
    type: coding(`${FHIR_R4_BASE}/CodeSystem/claim-type`, "institutional", "Institutional"),
    use,
    patient: ref("Patient", pkg.patient.id),
    created: new Date(0).toISOString(), // replaced by the caller's timestamp
    provider: ref("Organization", pkg.claim.facilityId),
    priority: coding(`${FHIR_R4_BASE}/CodeSystem/processpriority`, "normal", "Normal"),
    insurance: [{
      sequence: 1,
      focal: true,
      coverage: ref("Coverage", pkg.coverage.id),
      ...(pkg.preAuthorization?.payerReferenceNo
        ? { preAuthRef: [pkg.preAuthorization.payerReferenceNo] }
        : {}),
    }],
    ...(pkg.diagnoses.length
      ? {
          diagnosis: pkg.diagnoses.map((d, i) => ({
            sequence: i + 1,
            // Coded only when a real code exists — never invented.
            diagnosisCodeableConcept: d.code
              ? coding(d.codeSystem ?? "https://aarogya.local/diagnosis", d.code, d.diagnosis)
              : { text: d.diagnosis },
          })),
        }
      : {}),
    item: pkg.lines.map((l, i) => ({
      sequence: i + 1,
      productOrService: { text: l.description },
      quantity: { value: l.quantity },
      net: money(l.claimedAmountMinor),
    })),
    total: money(pkg.totals.claimedMinor),
  } as unknown as FhirResource;
}

export interface ClaimBundleOptions {
  /** Injected so the bundle is reproducible and hashable. */
  timestamp: Date;
  bundleId: string;
  facilityName: string;
  payerParticipantCode?: string | null;
  facilityHfrCode?: string | null;
  useKind?: "claim" | "preauthorization";
  /** External identifiers already mapped for this patient (ABHA etc.). */
  patientExternalIdentifiers?: { system: string; value: string; use?: string | null; status?: string | null }[];
}

/**
 * Compose the NHCX claim bundle.
 *
 * Deterministic: the caller supplies the timestamp and bundle id, so identical
 * inputs produce a byte-identical bundle. That is what makes the submission
 * hash meaningful as proof of what was sent.
 */
export function buildClaimBundle(pkg: ClaimPackage, opts: ClaimBundleOptions): FhirBundle {
  const patient = mapPatientToFhir(
    {
      id: pkg.patient.id, uhid: pkg.patient.uhid, fullName: pkg.patient.fullName,
      sex: pkg.patient.sex, dob: pkg.patient.dob, registrationStatus: "ACTIVE",
      facilityId: pkg.claim.facilityId,
    },
    { externalIdentifiers: opts.patientExternalIdentifiers, organizationId: pkg.claim.facilityId }
  );

  const claimResource = mapClaimToFhir(pkg, { useKind: opts.useKind }) as unknown as Record<string, unknown>;
  // The package builder leaves `created` as an epoch placeholder precisely so
  // the timestamp is injected here and the bundle stays reproducible.
  claimResource.created = opts.timestamp.toISOString();

  const resources: FhirResource[] = [
    claimResource as unknown as FhirResource,
    patient,
    mapCoverageToFhir(pkg),
    mapPayerToFhir(pkg, opts.payerParticipantCode),
    mapProviderToFhir(pkg.claim.facilityId, opts.facilityName, opts.facilityHfrCode),
    ...pkg.diagnoses.map((d) =>
      mapDiagnosisToFhir({
        id: d.id, patientId: pkg.patient.id, encounterId: pkg.encounter?.id ?? "",
        diagnosis: d.diagnosis, type: d.type, status: "ACTIVE", onsetDate: null,
        codeSystem: d.codeSystem, code: d.code,
        diagnosedByStaffId: "", createdAt: opts.timestamp,
      })
    ),
    ...pkg.documents.map((d) =>
      mapDocumentToFhir({
        id: d.id, patientId: pkg.patient.id, encounterId: pkg.encounter?.id ?? null,
        type: d.type, title: d.title, storageRef: null, status: "CURRENT",
        authorStaffId: null, createdAt: opts.timestamp,
      })
    ),
  ];

  const bundle = buildCollectionBundle(opts.bundleId, opts.timestamp, resources);

  // Defence in depth against the exact mistake this file exists to prevent.
  if (bundle.type !== NHCX_CLAIM_BUNDLE_TYPE) {
    throw new Error(`NHCX claim bundle must be type "${NHCX_CLAIM_BUNDLE_TYPE}", got "${bundle.type}".`);
  }
  bundle.identifier = { system: "https://aarogya.local/nhcx/bundle", value: opts.bundleId };
  return bundle;
}
