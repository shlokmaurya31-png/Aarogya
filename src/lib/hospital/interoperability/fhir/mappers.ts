import { IDENTIFIER_SYSTEMS } from "../shared";
import type {
  FhirPatient, FhirPractitioner, FhirOrganization, FhirEncounter, FhirCondition,
  FhirAllergyIntolerance, FhirObservation, FhirDiagnosticReport, FhirMedicationRequest,
  FhirMedicationAdministration, FhirCarePlan, FhirDocumentReference, FhirProcedure,
  FhirIdentifier, FhirReference, FhirCodeableConcept,
} from "./types";

/**
 * Phase C1 — canonical domain to FHIR R4 mappers.
 *
 * Contract every mapper in this file obeys:
 *
 *  1. DETERMINISTIC — same input always yields the same output. No Date.now(),
 *     no random ids. Bundles must be reproducible and hashable.
 *  2. NEVER INVENT — a field Aarogya does not hold is OMITTED, not guessed and
 *     not defaulted. An absent birth date must not become an approximate one,
 *     and an uncoded diagnosis must not acquire a code.
 *  3. PRESERVE CANONICAL IDENTITY — the Aarogya id is carried through, so a
 *     representation can always be traced back to the record it came from.
 *  4. REPRESENTATION ONLY — nothing here reads or writes clinical state.
 */

// ── helpers ─────────────────────────────────────────────────────────────────

/** ISO-8601 instant, or undefined. Never substitutes "now" for a missing date. */
function iso(d: Date | null | undefined): string | undefined {
  return d ? d.toISOString() : undefined;
}

/** FHIR `date` (YYYY-MM-DD) for birth dates. */
function isoDate(d: Date | null | undefined): string | undefined {
  return d ? d.toISOString().slice(0, 10) : undefined;
}

function ref(type: string, id: string | null | undefined, display?: string | null): FhirReference | undefined {
  if (!id) return undefined;
  return { reference: `${type}/${id}`, type, ...(display ? { display } : {}) };
}

/**
 * Text-only CodeableConcept for the very common case where Aarogya holds a human
 * label but no terminology code. Emitting `text` alone is valid FHIR and is
 * honest; inventing a coding would not be.
 */
function text(value: string | null | undefined): FhirCodeableConcept | undefined {
  return value ? { text: value } : undefined;
}

function coded(system: string | null | undefined, code: string | null | undefined, display: string | null | undefined): FhirCodeableConcept | undefined {
  if (!code) return text(display);
  return {
    coding: [{ ...(system ? { system } : {}), code, ...(display ? { display } : {}) }],
    ...(display ? { text: display } : {}),
  };
}

/** Aarogya identifiers plus any linked external registry identifiers. */
export function buildIdentifiers(
  local: { system: string; value: string | null | undefined },
  external: { system: string; value: string; use?: string | null; status?: string | null }[] = []
): FhirIdentifier[] {
  const out: FhirIdentifier[] = [];
  if (local.value) out.push({ use: "usual", system: local.system, value: local.value });
  for (const e of external) {
    // A superseded or revoked mapping is not presented as a current identifier.
    if (e.status && e.status !== "ACTIVE") continue;
    out.push({ use: e.use === "SECONDARY" ? "secondary" : "official", system: e.system, value: e.value });
  }
  return out;
}

// ── Patient ─────────────────────────────────────────────────────────────────

const SEX_TO_FHIR: Record<string, FhirPatient["gender"]> = {
  MALE: "male", M: "male", male: "male",
  FEMALE: "female", F: "female", female: "female",
  OTHER: "other", O: "other", other: "other",
  UNKNOWN: "unknown", U: "unknown", unknown: "unknown",
};

export interface PatientSource {
  id: string;
  uhid: string;
  fullName: string;
  preferredName?: string | null;
  sex: string;
  dob?: Date | null;
  dobPrecision?: string | null;
  phone?: string | null;
  address?: string | null;
  language?: string | null;
  registrationStatus: string;
  deceasedAt?: Date | null;
  facilityId: string;
}

export function mapPatientToFhir(
  patient: PatientSource,
  opts: { externalIdentifiers?: { system: string; value: string; use?: string | null; status?: string | null }[]; organizationId?: string | null } = {}
): FhirPatient {
  const resource: FhirPatient = {
    resourceType: "Patient",
    id: patient.id,
    identifier: buildIdentifiers({ system: IDENTIFIER_SYSTEMS.LOCAL_UHID, value: patient.uhid }, opts.externalIdentifiers),
    active: patient.registrationStatus === "ACTIVE",
    name: [
      { use: "official", text: patient.fullName },
      ...(patient.preferredName ? [{ use: "nickname", text: patient.preferredName }] : []),
    ],
    gender: SEX_TO_FHIR[patient.sex] ?? "unknown",
  };

  // An APPROXIMATE or UNKNOWN date of birth is deliberately NOT emitted as a
  // precise birthDate — that would present a guess as a fact.
  if (patient.dob && (!patient.dobPrecision || patient.dobPrecision === "EXACT")) {
    resource.birthDate = isoDate(patient.dob);
  }
  if (patient.deceasedAt) resource.deceasedDateTime = iso(patient.deceasedAt);
  if (patient.phone) resource.telecom = [{ system: "phone", value: patient.phone, use: "mobile" }];
  if (patient.address) resource.address = [{ text: patient.address }];
  if (patient.language) resource.communication = [{ language: { text: patient.language } }];
  if (opts.organizationId) resource.managingOrganization = ref("Organization", opts.organizationId);
  return resource;
}

// ── Practitioner / Organization ─────────────────────────────────────────────

export interface PractitionerSource {
  id: string;
  displayRole: string;
  employeeId?: string | null;
  specialty?: string | null;
  licenseNumber?: string | null;
  licenseExpiry?: Date | null;
  status: string;
  displayName?: string | null;
}

export function mapPractitionerToFhir(
  staff: PractitionerSource,
  opts: { externalIdentifiers?: { system: string; value: string; use?: string | null; status?: string | null }[] } = {}
): FhirPractitioner {
  const resource: FhirPractitioner = {
    resourceType: "Practitioner",
    id: staff.id,
    identifier: buildIdentifiers({ system: IDENTIFIER_SYSTEMS.LOCAL_MRN, value: staff.employeeId }, opts.externalIdentifiers),
    active: staff.status === "ACTIVE",
  };
  // Only emit a name when one is genuinely available from the linked user.
  if (staff.displayName) resource.name = [{ use: "official", text: staff.displayName }];
  const qualificationLabel = staff.specialty ?? staff.displayRole;
  if (qualificationLabel) {
    resource.qualification = [{
      code: { text: qualificationLabel },
      ...(staff.licenseExpiry ? { period: { end: iso(staff.licenseExpiry) } } : {}),
    }];
  }
  return resource;
}

export function mapOrganizationToFhir(
  facility: { id: string; name: string; city?: string | null },
  opts: { externalIdentifiers?: { system: string; value: string; use?: string | null; status?: string | null }[] } = {}
): FhirOrganization {
  const identifiers = buildIdentifiers({ system: IDENTIFIER_SYSTEMS.LOCAL_MRN, value: null }, opts.externalIdentifiers);
  return {
    resourceType: "Organization",
    id: facility.id,
    ...(identifiers.length ? { identifier: identifiers } : {}),
    active: true,
    name: facility.name,
    ...(facility.city ? { address: [{ city: facility.city, country: "IN" }] } : {}),
  };
}

// ── Encounter ───────────────────────────────────────────────────────────────

const ENCOUNTER_STATUS_TO_FHIR: Record<string, FhirEncounter["status"]> = {
  REGISTERED: "arrived",
  TRIAGED: "triaged",
  IN_PROGRESS: "in-progress",
  ADMITTED: "in-progress",
  DISCHARGED: "finished",
  CLOSED: "finished",
  COMPLETED: "finished",
  CANCELLED: "cancelled",
};

/** FHIR v3-ActEncounterCode, the class vocabulary R4 expects. */
const ENCOUNTER_CLASS: Record<string, { code: string; display: string }> = {
  OPD: { code: "AMB", display: "ambulatory" },
  OUTPATIENT: { code: "AMB", display: "ambulatory" },
  IPD: { code: "IMP", display: "inpatient encounter" },
  INPATIENT: { code: "IMP", display: "inpatient encounter" },
  ED: { code: "EMER", display: "emergency" },
  EMERGENCY: { code: "EMER", display: "emergency" },
  DAYCARE: { code: "SS", display: "short stay" },
  TELEMEDICINE: { code: "VR", display: "virtual" },
};

export interface EncounterSource {
  id: string;
  patientId: string;
  facilityId: string;
  type: string;
  status: string;
  chiefComplaint?: string | null;
  attendingStaffId?: string | null;
  registeredAt: Date;
  closedAt?: Date | null;
}

export function mapEncounterToFhir(
  encounter: EncounterSource,
  opts: { externalIdentifiers?: { system: string; value: string; use?: string | null; status?: string | null }[] } = {}
): FhirEncounter {
  const cls = ENCOUNTER_CLASS[encounter.type];
  const resource: FhirEncounter = {
    resourceType: "Encounter",
    id: encounter.id,
    status: ENCOUNTER_STATUS_TO_FHIR[encounter.status] ?? "unknown",
    ...(cls ? { class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: cls.code, display: cls.display } } : {}),
    subject: ref("Patient", encounter.patientId),
    period: { start: iso(encounter.registeredAt), ...(encounter.closedAt ? { end: iso(encounter.closedAt) } : {}) },
    serviceProvider: ref("Organization", encounter.facilityId),
  };
  const externals = (opts.externalIdentifiers ?? []).filter((e) => !e.status || e.status === "ACTIVE");
  if (externals.length) resource.identifier = externals.map((e) => ({ use: "official" as const, system: e.system, value: e.value }));
  if (encounter.attendingStaffId) resource.participant = [{ individual: ref("Practitioner", encounter.attendingStaffId) }];
  if (encounter.chiefComplaint) resource.reasonCode = [{ text: encounter.chiefComplaint }];
  return resource;
}

// ── Condition (Diagnosis) ───────────────────────────────────────────────────

const DIAGNOSIS_CLINICAL_STATUS: Record<string, string> = { ACTIVE: "active", RESOLVED: "resolved" };

export interface DiagnosisSource {
  id: string;
  patientId: string;
  encounterId: string;
  diagnosis: string;
  type: string;
  status: string;
  onsetDate?: Date | null;
  codeSystem?: string | null;
  code?: string | null;
  diagnosedByStaffId: string;
  createdAt: Date;
}

export function mapDiagnosisToFhir(d: DiagnosisSource): FhirCondition {
  const resource: FhirCondition = {
    resourceType: "Condition",
    id: d.id,
    subject: ref("Patient", d.patientId)!,
    encounter: ref("Encounter", d.encounterId),
    // Aarogya stores a free-text diagnosis and an OPTIONAL code. When no code
    // exists the concept is text-only rather than coded against a guess.
    code: coded(d.codeSystem, d.code, d.diagnosis),
    recordedDate: iso(d.createdAt),
    recorder: ref("Practitioner", d.diagnosedByStaffId),
  };
  if (d.status === "ENTERED_IN_ERROR") {
    resource.verificationStatus = {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "entered-in-error" }],
    };
  } else {
    const clinical = DIAGNOSIS_CLINICAL_STATUS[d.status];
    if (clinical) {
      resource.clinicalStatus = {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: clinical }],
      };
    }
    // PROVISIONAL / RULE_OUT carry real diagnostic meaning and map to R4
    // verification statuses; FINAL/PRIMARY/SECONDARY do not, so they are omitted.
    const verification = d.type === "PROVISIONAL" ? "provisional" : d.type === "RULE_OUT" ? "differential" : null;
    if (verification) {
      resource.verificationStatus = {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: verification }],
      };
    }
  }
  if (d.onsetDate) resource.onsetDateTime = iso(d.onsetDate);
  return resource;
}

// ── AllergyIntolerance ──────────────────────────────────────────────────────

export interface AllergySource {
  id: string;
  patientId: string;
  substance: string;
  reaction?: string | null;
  severity: string;
  status: string;
  verification: string;
  recordedAt: Date;
}

export function mapAllergyToFhir(a: AllergySource): FhirAllergyIntolerance {
  const severity = a.severity?.toLowerCase();
  const resource: FhirAllergyIntolerance = {
    resourceType: "AllergyIntolerance",
    id: a.id,
    patient: ref("Patient", a.patientId)!,
    code: text(a.substance),
    recordedDate: iso(a.recordedAt),
    clinicalStatus: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
        code: a.status === "ACTIVE" ? "active" : "inactive",
      }],
    },
    verificationStatus: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
        code: a.verification === "CONFIRMED" ? "confirmed" : "unconfirmed",
      }],
    },
  };
  if (a.reaction) {
    resource.reaction = [{
      manifestation: [{ text: a.reaction }],
      ...(severity === "mild" || severity === "moderate" || severity === "severe" ? { severity } : {}),
    }];
  }
  return resource;
}

// ── Observation (Vitals + Lab results) ──────────────────────────────────────

/** LOINC codes for the vitals Aarogya records. Only well-established ones. */
const VITAL_DEFS = [
  { key: "hr", loinc: "8867-4", display: "Heart rate", unit: "/min", ucum: "/min" },
  { key: "sbp", loinc: "8480-6", display: "Systolic blood pressure", unit: "mmHg", ucum: "mm[Hg]" },
  { key: "dbp", loinc: "8462-4", display: "Diastolic blood pressure", unit: "mmHg", ucum: "mm[Hg]" },
  { key: "rr", loinc: "9279-1", display: "Respiratory rate", unit: "/min", ucum: "/min" },
  { key: "spo2", loinc: "2708-6", display: "Oxygen saturation in Arterial blood", unit: "%", ucum: "%" },
  { key: "tempC", loinc: "8310-5", display: "Body temperature", unit: "Cel", ucum: "Cel" },
] as const;

export interface VitalSource {
  id: string;
  encounterId: string;
  recordedByStaffId: string;
  hr?: number | null;
  sbp?: number | null;
  dbp?: number | null;
  rr?: number | null;
  spo2?: number | null;
  tempC?: number | null;
  recordedAt: Date;
}

/**
 * One Vital row holds several measurements, and FHIR models each as its own
 * Observation. Only the measurements actually present are emitted, and each id
 * is derived from the source row so the output stays deterministic.
 */
export function mapVitalToFhirObservations(v: VitalSource, patientId: string): FhirObservation[] {
  const out: FhirObservation[] = [];
  for (const def of VITAL_DEFS) {
    const value = v[def.key] as number | null | undefined;
    if (value === null || value === undefined) continue;
    out.push({
      resourceType: "Observation",
      id: `${v.id}-${def.key}`,
      status: "final",
      category: [{
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }],
      }],
      code: { coding: [{ system: "http://loinc.org", code: def.loinc, display: def.display }], text: def.display },
      subject: ref("Patient", patientId),
      encounter: ref("Encounter", v.encounterId),
      effectiveDateTime: iso(v.recordedAt),
      performer: [ref("Practitioner", v.recordedByStaffId)!].filter(Boolean),
      valueQuantity: { value, unit: def.unit, system: "http://unitsofmeasure.org", code: def.ucum },
    });
  }
  return out;
}

const ABNORMAL_FLAG_TO_FHIR: Record<string, { code: string; display: string }> = {
  HIGH: { code: "H", display: "High" },
  LOW: { code: "L", display: "Low" },
  CRITICAL_HIGH: { code: "HH", display: "Critical high" },
  CRITICAL_LOW: { code: "LL", display: "Critical low" },
  NORMAL: { code: "N", display: "Normal" },
};

const LAB_RESULT_STATUS_TO_FHIR: Record<string, FhirObservation["status"]> = {
  ENTERED: "preliminary",
  VERIFIED: "final",
  AMENDED: "amended",
  CANCELLED: "cancelled",
};

export interface LabResultSource {
  id: string;
  value: string;
  unit?: string | null;
  referenceRange?: string | null;
  numericValue?: number | null;
  abnormalFlag?: string | null;
  status: string;
  resultedAt: Date;
  releasedByStaffId?: string | null;
  testName?: string | null;
  loincCode?: string | null;
}

export function mapLabResultToFhir(
  r: LabResultSource,
  ctx: { patientId: string; encounterId?: string | null }
): FhirObservation {
  const resource: FhirObservation = {
    resourceType: "Observation",
    id: r.id,
    status: LAB_RESULT_STATUS_TO_FHIR[r.status] ?? "unknown",
    category: [{
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory", display: "Laboratory" }],
    }],
    code: coded(r.loincCode ? "http://loinc.org" : null, r.loincCode, r.testName ?? "Laboratory test")!,
    subject: ref("Patient", ctx.patientId),
    ...(ctx.encounterId ? { encounter: ref("Encounter", ctx.encounterId) } : {}),
    effectiveDateTime: iso(r.resultedAt),
  };
  // A numeric result becomes a Quantity; anything else stays a string rather
  // than being coerced into a number.
  if (r.numericValue !== null && r.numericValue !== undefined) {
    resource.valueQuantity = { value: r.numericValue, ...(r.unit ? { unit: r.unit } : {}) };
  } else {
    resource.valueString = r.value;
  }
  if (r.abnormalFlag && ABNORMAL_FLAG_TO_FHIR[r.abnormalFlag]) {
    const f = ABNORMAL_FLAG_TO_FHIR[r.abnormalFlag];
    resource.interpretation = [{
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: f.code, display: f.display }],
    }];
  }
  if (r.referenceRange) resource.referenceRange = [{ text: r.referenceRange }];
  if (r.releasedByStaffId) resource.performer = [ref("Practitioner", r.releasedByStaffId)!];
  return resource;
}

// ── DiagnosticReport ────────────────────────────────────────────────────────

export interface DiagnosticReportSource {
  id: string;
  title: string;
  status: string;
  category: "LAB" | "RAD";
  issuedAt?: Date | null;
  effectiveAt?: Date | null;
  conclusion?: string | null;
  performerStaffId?: string | null;
  resultIds?: string[];
}

const REPORT_STATUS_TO_FHIR: Record<string, FhirDiagnosticReport["status"]> = {
  ENTERED: "preliminary",
  PRELIMINARY: "preliminary",
  VERIFIED: "final",
  FINAL: "final",
  AMENDED: "amended",
  CANCELLED: "cancelled",
};

export function mapDiagnosticReportToFhir(
  r: DiagnosticReportSource,
  ctx: { patientId: string; encounterId?: string | null }
): FhirDiagnosticReport {
  const categoryCode = r.category === "RAD" ? "RAD" : "LAB";
  const resource: FhirDiagnosticReport = {
    resourceType: "DiagnosticReport",
    id: r.id,
    status: REPORT_STATUS_TO_FHIR[r.status] ?? "unknown",
    category: [{
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: categoryCode, display: r.category === "RAD" ? "Radiology" : "Laboratory" }],
    }],
    code: { text: r.title },
    subject: ref("Patient", ctx.patientId),
    ...(ctx.encounterId ? { encounter: ref("Encounter", ctx.encounterId) } : {}),
  };
  if (r.effectiveAt) resource.effectiveDateTime = iso(r.effectiveAt);
  if (r.issuedAt) resource.issued = iso(r.issuedAt);
  if (r.conclusion) resource.conclusion = r.conclusion;
  if (r.performerStaffId) resource.performer = [ref("Practitioner", r.performerStaffId)!];
  if (r.resultIds?.length) resource.result = r.resultIds.map((id) => ref("Observation", id)!);
  return resource;
}

// ── MedicationRequest / MedicationAdministration ────────────────────────────

const MED_ORDER_STATUS_TO_FHIR: Record<string, FhirMedicationRequest["status"]> = {
  ORDERED: "active",
  VERIFIED: "active",
  ACTIVE: "active",
  DISPENSED: "active",
  ADMINISTERED: "completed",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  DISCONTINUED: "stopped",
  ON_HOLD: "on-hold",
  REJECTED: "cancelled",
};

export interface MedicationOrderSource {
  id: string;
  patientId: string;
  encounterId: string;
  drugName: string;
  genericName?: string | null;
  dose: string;
  route: string;
  frequency: string;
  doseValue?: number | null;
  doseUnit?: string | null;
  status: string;
  orderedByStaffId: string;
  orderedAt: Date;
  externalCode?: { system: string; code: string; display?: string } | null;
}

export function mapMedicationOrderToFhir(m: MedicationOrderSource): FhirMedicationRequest {
  // Local drug master and external terminology are kept strictly apart: an
  // external coding is emitted ONLY when a terminology mapping supplied one.
  const medication: FhirCodeableConcept = m.externalCode
    ? { coding: [{ system: m.externalCode.system, code: m.externalCode.code, display: m.externalCode.display ?? m.drugName }], text: m.drugName }
    : { text: m.genericName ? `${m.drugName} (${m.genericName})` : m.drugName };

  return {
    resourceType: "MedicationRequest",
    id: m.id,
    status: MED_ORDER_STATUS_TO_FHIR[m.status] ?? "unknown",
    intent: "order",
    medicationCodeableConcept: medication,
    subject: ref("Patient", m.patientId)!,
    encounter: ref("Encounter", m.encounterId),
    authoredOn: iso(m.orderedAt),
    requester: ref("Practitioner", m.orderedByStaffId),
    dosageInstruction: [{
      text: [m.dose, m.route, m.frequency].filter(Boolean).join(" "),
      route: text(m.route),
      timing: { code: text(m.frequency) },
      ...(m.doseValue !== null && m.doseValue !== undefined
        ? { doseAndRate: [{ doseQuantity: { value: m.doseValue, ...(m.doseUnit ? { unit: m.doseUnit } : {}) } }] }
        : {}),
    }],
  };
}

export interface MedicationAdministrationSource {
  id: string;
  medicationOrderId: string;
  patientId: string;
  encounterId?: string | null;
  drugName: string;
  dose?: string | null;
  route?: string | null;
  status: string;
  administeredByStaffId?: string | null;
  administeredAt: Date;
}

export function mapMedicationAdministrationToFhir(a: MedicationAdministrationSource): FhirMedicationAdministration {
  const resource: FhirMedicationAdministration = {
    resourceType: "MedicationAdministration",
    id: a.id,
    status: a.status === "NOT_GIVEN" ? "not-done" : a.status === "CANCELLED" ? "entered-in-error" : "completed",
    medicationCodeableConcept: { text: a.drugName },
    subject: ref("Patient", a.patientId)!,
    ...(a.encounterId ? { context: ref("Encounter", a.encounterId) } : {}),
    effectiveDateTime: iso(a.administeredAt),
    request: ref("MedicationRequest", a.medicationOrderId),
  };
  if (a.administeredByStaffId) resource.performer = [{ actor: ref("Practitioner", a.administeredByStaffId)! }];
  if (a.dose || a.route) resource.dosage = { ...(a.dose ? { text: a.dose } : {}), ...(a.route ? { route: text(a.route) } : {}) };
  return resource;
}

// ── CarePlan ────────────────────────────────────────────────────────────────

export interface CarePlanSource {
  id: string;
  patientId: string;
  encounterId?: string | null;
  title: string;
  description?: string | null;
  status: string;
  createdAt: Date;
  interventions?: { description: string; status?: string | null }[];
}

export function mapCarePlanToFhir(c: CarePlanSource): FhirCarePlan {
  const status: FhirCarePlan["status"] =
    c.status === "ACTIVE" ? "active" : c.status === "COMPLETED" ? "completed" : c.status === "CANCELLED" ? "revoked" : "draft";
  return {
    resourceType: "CarePlan",
    id: c.id,
    status,
    intent: "plan",
    title: c.title,
    ...(c.description ? { description: c.description } : {}),
    subject: ref("Patient", c.patientId)!,
    ...(c.encounterId ? { encounter: ref("Encounter", c.encounterId) } : {}),
    created: iso(c.createdAt),
    ...(c.interventions?.length
      ? { activity: c.interventions.map((i) => ({ detail: { description: i.description, ...(i.status ? { status: i.status.toLowerCase() } : {}) } })) }
      : {}),
  };
}

// ── DocumentReference ───────────────────────────────────────────────────────

export interface ClinicalDocumentSource {
  id: string;
  patientId: string;
  encounterId?: string | null;
  type: string;
  title: string;
  storageRef?: string | null;
  status: string;
  authorStaffId?: string | null;
  createdAt: Date;
}

/**
 * Documents are REFERENCED, never copied. The binary stays wherever Aarogya
 * already stores it; this emits an attachment pointing at it. Duplicating
 * document bytes into an interoperability table would create a second
 * uncontrolled copy of clinical data.
 */
export function mapDocumentToFhir(d: ClinicalDocumentSource): FhirDocumentReference {
  return {
    resourceType: "DocumentReference",
    id: d.id,
    status: d.status === "SUPERSEDED" ? "superseded" : "current",
    type: text(d.type),
    subject: ref("Patient", d.patientId),
    date: iso(d.createdAt),
    ...(d.authorStaffId ? { author: [ref("Practitioner", d.authorStaffId)!] } : {}),
    description: d.title,
    content: [{
      attachment: {
        title: d.title,
        creation: iso(d.createdAt),
        // url is omitted entirely when no file has been attached yet, rather
        // than emitting a broken or invented link.
        ...(d.storageRef ? { url: d.storageRef } : {}),
      },
    }],
    ...(d.encounterId ? { context: { encounter: [ref("Encounter", d.encounterId)!] } } : {}),
  };
}

// ── Procedure ───────────────────────────────────────────────────────────────

export interface ProcedureSource {
  id: string;
  patientId: string;
  encounterId?: string | null;
  name: string;
  status: string;
  performedAt?: Date | null;
  performerStaffId?: string | null;
}

export function mapProcedureToFhir(p: ProcedureSource): FhirProcedure {
  const status: FhirProcedure["status"] =
    p.status === "COMPLETED" ? "completed"
      : p.status === "IN_PROGRESS" ? "in-progress"
        : p.status === "CANCELLED" ? "not-done"
          : "unknown";
  return {
    resourceType: "Procedure",
    id: p.id,
    status,
    code: text(p.name),
    subject: ref("Patient", p.patientId)!,
    ...(p.encounterId ? { encounter: ref("Encounter", p.encounterId) } : {}),
    ...(p.performedAt ? { performedDateTime: iso(p.performedAt) } : {}),
    ...(p.performerStaffId ? { performer: [{ actor: ref("Practitioner", p.performerStaffId)! }] } : {}),
  };
}
