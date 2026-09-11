/**
 * Phase C1 — minimal FHIR R4 (4.0.1) structural types.
 *
 * VERSION DECISION: FHIR R4, specifically 4.0.1. The ABDM FHIR Implementation
 * Guide published by NRCeS (https://nrces.in/ndhm/fhir/r4/, IG v6.5.0) is built
 * on R4 and defines India-specific profiles plus a DocumentBundle for exchanging
 * health-record artefacts. R4 is therefore not a preference, it is what ABDM
 * requires. See docs/PHASE_C1_INTEROPERABILITY.md for the full rationale.
 *
 * These are hand-written structural types covering only the fields Aarogya
 * actually populates. A full FHIR type package would import thousands of
 * optional fields that this codebase has no data for, and would invite mappers
 * to fabricate them. Everything here is version-isolated under fhir/ so an R5
 * (or updated IG) mapping can live alongside it.
 *
 * SCOPE HONESTY: these types produce structurally valid R4 resources. They are
 * NOT validated against the ABDM StructureDefinitions, so nothing in this
 * codebase claims ABDM profile conformance.
 */

export const FHIR_VERSION = "4.0.1" as const;
export const ABDM_IG_BASE = "https://nrces.in/ndhm/fhir/r4" as const;

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirIdentifier {
  use?: "usual" | "official" | "temp" | "secondary" | "old";
  system?: string;
  value?: string;
  type?: FhirCodeableConcept;
  period?: FhirPeriod;
}

export interface FhirPeriod {
  start?: string;
  end?: string;
}

export interface FhirReference {
  reference?: string;
  type?: string;
  display?: string;
  identifier?: FhirIdentifier;
}

export interface FhirQuantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
}

export interface FhirMeta {
  versionId?: string;
  lastUpdated?: string;
  profile?: string[];
  source?: string;
}

export interface FhirResourceBase {
  resourceType: string;
  id?: string;
  meta?: FhirMeta;
  identifier?: FhirIdentifier[];
}

export interface FhirHumanName {
  use?: string;
  text?: string;
  family?: string;
  given?: string[];
}

export interface FhirContactPoint {
  system?: "phone" | "email" | "url" | "sms" | "other";
  value?: string;
  use?: string;
}

export interface FhirAddress {
  use?: string;
  text?: string;
  city?: string;
  country?: string;
}

export interface FhirPatient extends FhirResourceBase {
  resourceType: "Patient";
  active?: boolean;
  name?: FhirHumanName[];
  telecom?: FhirContactPoint[];
  gender?: "male" | "female" | "other" | "unknown";
  birthDate?: string;
  deceasedDateTime?: string;
  address?: FhirAddress[];
  communication?: { language: FhirCodeableConcept }[];
  managingOrganization?: FhirReference;
}

export interface FhirPractitioner extends FhirResourceBase {
  resourceType: "Practitioner";
  active?: boolean;
  name?: FhirHumanName[];
  qualification?: { code: FhirCodeableConcept; period?: FhirPeriod }[];
}

export interface FhirOrganization extends FhirResourceBase {
  resourceType: "Organization";
  active?: boolean;
  name?: string;
  address?: FhirAddress[];
}

export interface FhirLocation extends FhirResourceBase {
  resourceType: "Location";
  status?: "active" | "suspended" | "inactive";
  name?: string;
  managingOrganization?: FhirReference;
}

export interface FhirEncounter extends FhirResourceBase {
  resourceType: "Encounter";
  status: "planned" | "arrived" | "triaged" | "in-progress" | "onleave" | "finished" | "cancelled" | "entered-in-error" | "unknown";
  class?: FhirCoding;
  type?: FhirCodeableConcept[];
  subject?: FhirReference;
  participant?: { individual?: FhirReference }[];
  period?: FhirPeriod;
  reasonCode?: FhirCodeableConcept[];
  serviceProvider?: FhirReference;
  location?: { location: FhirReference; period?: FhirPeriod }[];
}

export interface FhirCondition extends FhirResourceBase {
  resourceType: "Condition";
  clinicalStatus?: FhirCodeableConcept;
  verificationStatus?: FhirCodeableConcept;
  category?: FhirCodeableConcept[];
  code?: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  onsetDateTime?: string;
  recordedDate?: string;
  recorder?: FhirReference;
}

export interface FhirAllergyIntolerance extends FhirResourceBase {
  resourceType: "AllergyIntolerance";
  clinicalStatus?: FhirCodeableConcept;
  verificationStatus?: FhirCodeableConcept;
  code?: FhirCodeableConcept;
  patient: FhirReference;
  recordedDate?: string;
  reaction?: { manifestation: FhirCodeableConcept[]; severity?: "mild" | "moderate" | "severe" }[];
}

export interface FhirObservation extends FhirResourceBase {
  resourceType: "Observation";
  status: "registered" | "preliminary" | "final" | "amended" | "corrected" | "cancelled" | "entered-in-error" | "unknown";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject?: FhirReference;
  encounter?: FhirReference;
  effectiveDateTime?: string;
  issued?: string;
  performer?: FhirReference[];
  valueQuantity?: FhirQuantity;
  valueString?: string;
  interpretation?: FhirCodeableConcept[];
  referenceRange?: { text?: string }[];
}

export interface FhirDiagnosticReport extends FhirResourceBase {
  resourceType: "DiagnosticReport";
  status: "registered" | "partial" | "preliminary" | "final" | "amended" | "corrected" | "appended" | "cancelled" | "entered-in-error" | "unknown";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject?: FhirReference;
  encounter?: FhirReference;
  effectiveDateTime?: string;
  issued?: string;
  performer?: FhirReference[];
  result?: FhirReference[];
  conclusion?: string;
}

export interface FhirServiceRequest extends FhirResourceBase {
  resourceType: "ServiceRequest";
  status: "draft" | "active" | "on-hold" | "revoked" | "completed" | "entered-in-error" | "unknown";
  intent: "proposal" | "plan" | "directive" | "order" | "original-order" | "reflex-order" | "filler-order" | "instance-order" | "option";
  code?: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  authoredOn?: string;
  requester?: FhirReference;
}

export interface FhirDosage {
  text?: string;
  route?: FhirCodeableConcept;
  timing?: { code?: FhirCodeableConcept };
  doseAndRate?: { doseQuantity?: FhirQuantity }[];
}

export interface FhirMedicationRequest extends FhirResourceBase {
  resourceType: "MedicationRequest";
  status: "active" | "on-hold" | "cancelled" | "completed" | "entered-in-error" | "stopped" | "draft" | "unknown";
  intent: "proposal" | "plan" | "order" | "original-order" | "reflex-order" | "filler-order" | "instance-order" | "option";
  medicationCodeableConcept?: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  authoredOn?: string;
  requester?: FhirReference;
  dosageInstruction?: FhirDosage[];
}

export interface FhirMedicationAdministration extends FhirResourceBase {
  resourceType: "MedicationAdministration";
  status: "in-progress" | "not-done" | "on-hold" | "completed" | "entered-in-error" | "stopped" | "unknown";
  medicationCodeableConcept?: FhirCodeableConcept;
  subject: FhirReference;
  context?: FhirReference;
  effectiveDateTime?: string;
  performer?: { actor: FhirReference }[];
  request?: FhirReference;
  dosage?: { text?: string; route?: FhirCodeableConcept; dose?: FhirQuantity };
}

export interface FhirCarePlan extends FhirResourceBase {
  resourceType: "CarePlan";
  status: "draft" | "active" | "on-hold" | "revoked" | "completed" | "entered-in-error" | "unknown";
  intent: "proposal" | "plan" | "order" | "option";
  title?: string;
  description?: string;
  subject: FhirReference;
  encounter?: FhirReference;
  created?: string;
  activity?: { detail?: { status?: string; description?: string } }[];
}

export interface FhirDocumentReference extends FhirResourceBase {
  resourceType: "DocumentReference";
  status: "current" | "superseded" | "entered-in-error";
  type?: FhirCodeableConcept;
  subject?: FhirReference;
  date?: string;
  author?: FhirReference[];
  description?: string;
  content: { attachment: { contentType?: string; url?: string; title?: string; creation?: string } }[];
  context?: { encounter?: FhirReference[] };
}

export interface FhirProcedure extends FhirResourceBase {
  resourceType: "Procedure";
  status: "preparation" | "in-progress" | "not-done" | "on-hold" | "stopped" | "completed" | "entered-in-error" | "unknown";
  code?: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  performedDateTime?: string;
  performer?: { actor: FhirReference }[];
}

export interface FhirCompositionSection {
  title?: string;
  code?: FhirCodeableConcept;
  entry?: FhirReference[];
}

export interface FhirComposition extends FhirResourceBase {
  resourceType: "Composition";
  status: "preliminary" | "final" | "amended" | "entered-in-error";
  type: FhirCodeableConcept;
  subject?: FhirReference;
  encounter?: FhirReference;
  date: string;
  author: FhirReference[];
  title: string;
  custodian?: FhirReference;
  section?: FhirCompositionSection[];
}

export type FhirResource =
  | FhirPatient | FhirPractitioner | FhirOrganization | FhirLocation | FhirEncounter
  | FhirCondition | FhirAllergyIntolerance | FhirObservation | FhirDiagnosticReport
  | FhirServiceRequest | FhirMedicationRequest | FhirMedicationAdministration
  | FhirCarePlan | FhirDocumentReference | FhirProcedure | FhirComposition;

export interface FhirBundleEntry {
  fullUrl?: string;
  resource?: FhirResource;
  request?: { method: string; url: string };
}

export interface FhirBundle {
  resourceType: "Bundle";
  id?: string;
  meta?: FhirMeta;
  identifier?: FhirIdentifier;
  type: "document" | "collection" | "transaction" | "batch" | "searchset";
  timestamp?: string;
  total?: number;
  entry?: FhirBundleEntry[];
}

/** Resource types this build is prepared to accept on import. */
export const SUPPORTED_RESOURCE_TYPES = [
  "Patient", "Practitioner", "Organization", "Location", "Encounter", "Condition",
  "AllergyIntolerance", "Observation", "DiagnosticReport", "ServiceRequest",
  "MedicationRequest", "MedicationAdministration", "CarePlan", "DocumentReference",
  "Procedure", "Composition", "Bundle",
] as const;

export type SupportedResourceType = (typeof SUPPORTED_RESOURCE_TYPES)[number];
