import { FhirValidationError, validateResource, type ValidatedResource } from "./validate";

/**
 * Phase C2 — ABDM FHIR profile registry and validation boundary.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS AND IS NOT
 *
 * IS:  a versioned registry of the ABDM StructureDefinition canonical URLs that
 *      apply to the resources Aarogya actually produces, plus a seam through
 *      which profile validation can be switched on WITHOUT touching a mapper.
 *
 * IS NOT: a profile validator. Real profile validation requires the published
 *      StructureDefinition package and a FHIR validation engine. Asserting
 *      conformance from a hand-written field check would be a claim we cannot
 *      back, so `profileValidation` reports NOT_IMPLEMENTED and the contract
 *      matrix records it as a blocker.
 *
 * Canonical URLs follow the ABDM IG namespace documented at
 * https://nrces.in/ndhm/fhir/r4/ (IG v6.5.0, FHIR R4 4.0.1), verified
 * 2026-09-11.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const ABDM_IG = {
  name: "FHIR Implementation Guide for ABDM",
  version: "6.5.0",
  fhirVersion: "4.0.1",
  canonicalBase: "https://nrces.in/ndhm/fhir/r4",
  url: "https://nrces.in/ndhm/fhir/r4/",
  verifiedOn: "2026-09-11",
} as const;

export type ProfileStatus =
  /** Canonical URL recorded; structure produced; NOT validated against the SD. */
  | "REGISTERED"
  /** Aarogya does not yet produce this resource. */
  | "NOT_PRODUCED";

export interface FhirProfile {
  resourceType: string;
  /** Canonical StructureDefinition URL from the ABDM IG. */
  canonical: string;
  version: string;
  status: ProfileStatus;
  /** Which Aarogya capability emits this resource. */
  source: string;
}

const p = (resourceType: string, slug: string, source: string, status: ProfileStatus = "REGISTERED"): FhirProfile => ({
  resourceType,
  canonical: `${ABDM_IG.canonicalBase}/StructureDefinition/${slug}`,
  version: ABDM_IG.version,
  status,
  source,
});

/**
 * Only profiles relevant to resources Aarogya genuinely produces. Registering
 * the whole IG would imply coverage that does not exist.
 */
export const ABDM_PROFILES: FhirProfile[] = [
  p("Patient", "Patient", "Patient registry / EMPI"),
  p("Practitioner", "Practitioner", "HospitalStaffProfile"),
  p("Organization", "Organization", "Facility"),
  p("Encounter", "Encounter", "ADT encounter"),
  p("Condition", "Condition", "Diagnosis"),
  p("AllergyIntolerance", "AllergyIntolerance", "Allergy"),
  p("Observation", "Observation", "Vitals and lab results"),
  p("DiagnosticReport", "DiagnosticReport", "Lab and radiology reports"),
  p("MedicationRequest", "MedicationRequest", "MedicationOrder"),
  p("DocumentReference", "DocumentReference", "ClinicalDocument"),
  p("Composition", "Composition", "DocumentBundle index"),
  p("Bundle", "DocumentBundle", "Health record artefact"),
  // Registered as NOT_PRODUCED: the mappers exist but no C1/C2 export path
  // composes them yet, and claiming otherwise would overstate coverage.
  p("Location", "Location", "Ward / bed", "NOT_PRODUCED"),
  p("ServiceRequest", "ServiceRequest", "Lab / imaging order", "NOT_PRODUCED"),
  p("MedicationAdministration", "MedicationAdministration", "MAR", "NOT_PRODUCED"),
  p("CarePlan", "CarePlan", "CarePlan", "NOT_PRODUCED"),
  p("Procedure", "Procedure", "Surgery / procedure", "NOT_PRODUCED"),
];

const BY_RESOURCE = new Map(ABDM_PROFILES.map((profile) => [profile.resourceType, profile]));

export function getProfileFor(resourceType: string): FhirProfile | null {
  return BY_RESOURCE.get(resourceType) ?? null;
}

export function listProfiles(): FhirProfile[] {
  return [...ABDM_PROFILES];
}

/**
 * ABDM health-record artefact types (Composition-based), from the IG. The
 * DocumentBundle profile wraps one of these.
 */
export const ABDM_ARTEFACT_PROFILES = [
  "OPConsultRecord",
  "DischargeSummaryRecord",
  "DiagnosticReportRecord",
  "PrescriptionRecord",
  "HealthDocumentRecord",
  "WellnessRecord",
  "ImmunizationRecord",
] as const;

export type AbdmArtefactProfile = (typeof ABDM_ARTEFACT_PROFILES)[number];

export type ProfileValidationOutcome = "PASSED" | "FAILED" | "NOT_IMPLEMENTED" | "NO_PROFILE";

export interface ProfileValidationResult {
  resourceType: string;
  profile: string | null;
  outcome: ProfileValidationOutcome;
  issues: string[];
  /** True only when a real StructureDefinition was evaluated. */
  conformanceAsserted: boolean;
}

/**
 * The validation seam.
 *
 * Structural validation (shape, supported type, safe references) always runs
 * and is a genuine security control. Profile validation is a separate, honest
 * NOT_IMPLEMENTED until the StructureDefinition package is available — and
 * `conformanceAsserted` is the flag that stops any caller from reporting
 * conformance we have not established.
 *
 * Switching profile validation on later means implementing `validateAgainstProfile`
 * here. No mapper changes.
 */
export function validateFhirResource(
  value: unknown,
  options: { profile?: string | null; requireProfile?: boolean } = {}
): { resource: ValidatedResource; profile: ProfileValidationResult } {
  // Structural validation first: it is what actually protects the system, and
  // it must run regardless of whether a profile is known.
  const resource = validateResource(value);

  const known = getProfileFor(resource.resourceType);
  const requested = options.profile ?? known?.canonical ?? null;

  if (!requested) {
    if (options.requireProfile) {
      throw new FhirValidationError([`no ABDM profile is registered for ${resource.resourceType}`]);
    }
    return {
      resource,
      profile: {
        resourceType: resource.resourceType,
        profile: null,
        outcome: "NO_PROFILE",
        issues: [],
        conformanceAsserted: false,
      },
    };
  }

  return {
    resource,
    profile: {
      resourceType: resource.resourceType,
      profile: requested,
      outcome: "NOT_IMPLEMENTED",
      issues: [
        "Structural FHIR R4 validation passed. ABDM profile conformance was NOT evaluated: " +
          "the StructureDefinition package is not bundled with this deployment.",
      ],
      conformanceAsserted: false,
    },
  };
}

/** Summarise registry coverage for the interoperability dashboard. */
export function describeProfileCoverage() {
  const produced = ABDM_PROFILES.filter((x) => x.status === "REGISTERED");
  return {
    ig: ABDM_IG,
    total: ABDM_PROFILES.length,
    produced: produced.length,
    notProduced: ABDM_PROFILES.length - produced.length,
    // The headline number an operator needs: zero profiles are validated.
    validated: 0,
    profileValidationImplemented: false,
    profiles: ABDM_PROFILES,
  };
}
