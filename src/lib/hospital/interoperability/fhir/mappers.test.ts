import { describe, it, expect } from "vitest";
import {
  mapPatientToFhir, mapEncounterToFhir, mapDiagnosisToFhir, mapAllergyToFhir,
  mapVitalToFhirObservations, mapLabResultToFhir, mapMedicationOrderToFhir,
  mapDocumentToFhir, mapOrganizationToFhir,
} from "./mappers";
import { buildDocumentBundle, hashBundle } from "./bundle";
import { IDENTIFIER_SYSTEMS } from "../shared";

/**
 * Phase C1 — FHIR R4 mapper contract.
 *
 * The two properties that matter most are pinned here:
 *   DETERMINISM — a bundle must hash identically across runs, or provenance is
 *                 meaningless.
 *   NO FABRICATION — a field Aarogya does not hold must be ABSENT, never
 *                 defaulted. This is the difference between a representation
 *                 and a clinical lie.
 */

const AT = new Date("2026-03-01T10:00:00.000Z");

const patient = {
  id: "pat-1", uhid: "UH-0001", fullName: "Asha Devi", sex: "FEMALE",
  dob: new Date("1990-05-14T00:00:00.000Z"), dobPrecision: "EXACT",
  phone: "+919000000000", address: "12 MG Road", language: "hi",
  registrationStatus: "ACTIVE", deceasedAt: null, facilityId: "fac-1",
};

describe("mapPatientToFhir", () => {
  it("preserves the canonical id and the local UHID", () => {
    const r = mapPatientToFhir(patient);
    expect(r.resourceType).toBe("Patient");
    expect(r.id).toBe("pat-1");
    expect(r.identifier?.[0]).toMatchObject({ system: IDENTIFIER_SYSTEMS.LOCAL_UHID, value: "UH-0001" });
  });

  it("adds a linked ABHA as an official identifier WITHOUT displacing the UHID", () => {
    const r = mapPatientToFhir(patient, {
      externalIdentifiers: [{ system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: "11-1111-1111-1111", status: "ACTIVE" }],
    });
    // ABHA is an additional identifier, never the resource id.
    expect(r.id).toBe("pat-1");
    expect(r.identifier).toHaveLength(2);
    expect(r.identifier?.[1]).toMatchObject({ use: "official", value: "11-1111-1111-1111" });
  });

  it("omits a superseded or revoked external identifier", () => {
    const r = mapPatientToFhir(patient, {
      externalIdentifiers: [{ system: IDENTIFIER_SYSTEMS.ABHA_NUMBER, value: "old", status: "SUPERSEDED" }],
    });
    expect(r.identifier).toHaveLength(1);
  });

  it("does NOT emit a birthDate when the date of birth is only approximate", () => {
    const approx = mapPatientToFhir({ ...patient, dobPrecision: "APPROXIMATE" });
    expect(approx.birthDate).toBeUndefined();
    const unknown = mapPatientToFhir({ ...patient, dob: null, dobPrecision: null });
    expect(unknown.birthDate).toBeUndefined();
  });

  it("emits birthDate as a FHIR date, not an instant", () => {
    expect(mapPatientToFhir(patient).birthDate).toBe("1990-05-14");
  });

  it("maps an unrecognised sex to unknown rather than guessing", () => {
    expect(mapPatientToFhir({ ...patient, sex: "???" }).gender).toBe("unknown");
  });

  it("omits telecom and address entirely when Aarogya has none", () => {
    const r = mapPatientToFhir({ ...patient, phone: null, address: null, language: null });
    expect(r.telecom).toBeUndefined();
    expect(r.address).toBeUndefined();
    expect(r.communication).toBeUndefined();
  });

  it("marks a deceased patient with the recorded instant", () => {
    const r = mapPatientToFhir({ ...patient, deceasedAt: AT });
    expect(r.deceasedDateTime).toBe(AT.toISOString());
  });

  it("is deterministic", () => {
    expect(JSON.stringify(mapPatientToFhir(patient))).toBe(JSON.stringify(mapPatientToFhir(patient)));
  });
});

describe("mapEncounterToFhir", () => {
  const encounter = {
    id: "enc-1", patientId: "pat-1", facilityId: "fac-1", type: "IPD", status: "ADMITTED",
    chiefComplaint: "Chest pain", attendingStaffId: "staff-1", registeredAt: AT, closedAt: null,
  };

  it("maps status and class to R4 vocabularies", () => {
    const r = mapEncounterToFhir(encounter);
    expect(r.status).toBe("in-progress");
    expect(r.class).toMatchObject({ code: "IMP", system: "http://terminology.hl7.org/CodeSystem/v3-ActCode" });
    expect(r.subject?.reference).toBe("Patient/pat-1");
    expect(r.serviceProvider?.reference).toBe("Organization/fac-1");
  });

  it("maps an ED encounter to the emergency class", () => {
    expect(mapEncounterToFhir({ ...encounter, type: "ED" }).class?.code).toBe("EMER");
  });

  it("omits class for an unmapped encounter type rather than inventing one", () => {
    expect(mapEncounterToFhir({ ...encounter, type: "SOMETHING_NEW" }).class).toBeUndefined();
  });

  it("reports an unknown status as unknown, never as finished", () => {
    expect(mapEncounterToFhir({ ...encounter, status: "WEIRD" }).status).toBe("unknown");
  });

  it("leaves the period open while the encounter is open", () => {
    expect(mapEncounterToFhir(encounter).period?.end).toBeUndefined();
    expect(mapEncounterToFhir({ ...encounter, closedAt: AT }).period?.end).toBe(AT.toISOString());
  });
});

describe("mapDiagnosisToFhir", () => {
  const base = {
    id: "dx-1", patientId: "pat-1", encounterId: "enc-1", diagnosis: "Acute appendicitis",
    type: "FINAL", status: "ACTIVE", onsetDate: null, codeSystem: null, code: null,
    diagnosedByStaffId: "staff-1", createdAt: AT,
  };

  it("emits text-only when Aarogya holds no terminology code", () => {
    const r = mapDiagnosisToFhir(base);
    expect(r.code).toEqual({ text: "Acute appendicitis" });
    expect(r.code?.coding).toBeUndefined();
  });

  it("emits a coding only when a real code exists", () => {
    const r = mapDiagnosisToFhir({ ...base, codeSystem: "ICD-10", code: "K35.80" });
    expect(r.code?.coding?.[0]).toMatchObject({ system: "ICD-10", code: "K35.80" });
  });

  it("maps PROVISIONAL and RULE_OUT to R4 verification statuses", () => {
    expect(mapDiagnosisToFhir({ ...base, type: "PROVISIONAL" }).verificationStatus?.coding?.[0].code).toBe("provisional");
    expect(mapDiagnosisToFhir({ ...base, type: "RULE_OUT" }).verificationStatus?.coding?.[0].code).toBe("differential");
  });

  it("marks an erroneous diagnosis entered-in-error", () => {
    const r = mapDiagnosisToFhir({ ...base, status: "ENTERED_IN_ERROR" });
    expect(r.verificationStatus?.coding?.[0].code).toBe("entered-in-error");
    expect(r.clinicalStatus).toBeUndefined();
  });
});

describe("mapAllergyToFhir", () => {
  const base = {
    id: "alg-1", patientId: "pat-1", substance: "Penicillin", reaction: "Rash",
    severity: "severe", status: "ACTIVE", verification: "CONFIRMED", recordedAt: AT,
  };

  it("maps clinical and verification status plus the reaction", () => {
    const r = mapAllergyToFhir(base);
    expect(r.clinicalStatus?.coding?.[0].code).toBe("active");
    expect(r.verificationStatus?.coding?.[0].code).toBe("confirmed");
    expect(r.reaction?.[0]).toMatchObject({ severity: "severe" });
  });

  it("omits the reaction block entirely when none was recorded", () => {
    expect(mapAllergyToFhir({ ...base, reaction: null }).reaction).toBeUndefined();
  });

  it("drops a severity it cannot map rather than guessing", () => {
    expect(mapAllergyToFhir({ ...base, severity: "catastrophic" }).reaction?.[0].severity).toBeUndefined();
  });
});

describe("mapVitalToFhirObservations", () => {
  const vital = {
    id: "vit-1", encounterId: "enc-1", recordedByStaffId: "staff-1",
    hr: 88, sbp: 120, dbp: 80, rr: null, spo2: 97, tempC: null, recordedAt: AT,
  };

  it("emits one Observation per PRESENT measurement only", () => {
    const obs = mapVitalToFhirObservations(vital, "pat-1");
    expect(obs.map((o) => o.id)).toEqual(["vit-1-hr", "vit-1-sbp", "vit-1-dbp", "vit-1-spo2"]);
    // rr and tempC were null and must not appear at all.
    expect(obs.find((o) => o.id === "vit-1-rr")).toBeUndefined();
  });

  it("uses LOINC codes and UCUM units", () => {
    const hr = mapVitalToFhirObservations(vital, "pat-1")[0];
    expect(hr.code.coding?.[0]).toMatchObject({ system: "http://loinc.org", code: "8867-4" });
    expect(hr.valueQuantity).toMatchObject({ value: 88, system: "http://unitsofmeasure.org", code: "/min" });
  });

  it("emits nothing when every measurement is absent", () => {
    expect(mapVitalToFhirObservations(
      { ...vital, hr: null, sbp: null, dbp: null, spo2: null }, "pat-1"
    )).toHaveLength(0);
  });

  it("derives deterministic ids from the source row", () => {
    const a = mapVitalToFhirObservations(vital, "pat-1");
    const b = mapVitalToFhirObservations(vital, "pat-1");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("mapLabResultToFhir", () => {
  const base = {
    id: "lab-1", value: "5.4", unit: "mmol/L", referenceRange: "3.5-5.5",
    numericValue: 5.4, abnormalFlag: null as string | null, status: "VERIFIED",
    resultedAt: AT, releasedByStaffId: "staff-1", testName: "Potassium", loincCode: null as string | null,
  };

  it("maps a numeric result to a Quantity", () => {
    const r = mapLabResultToFhir(base, { patientId: "pat-1", encounterId: "enc-1" });
    expect(r.status).toBe("final");
    expect(r.valueQuantity).toMatchObject({ value: 5.4, unit: "mmol/L" });
    expect(r.valueString).toBeUndefined();
  });

  it("keeps a non-numeric result as a string rather than coercing it", () => {
    const r = mapLabResultToFhir({ ...base, numericValue: null, value: "Reactive" }, { patientId: "pat-1" });
    expect(r.valueString).toBe("Reactive");
    expect(r.valueQuantity).toBeUndefined();
  });

  it("maps an abnormal flag to an R4 interpretation", () => {
    const r = mapLabResultToFhir({ ...base, abnormalFlag: "CRITICAL_HIGH" }, { patientId: "pat-1" });
    expect(r.interpretation?.[0].coding?.[0]).toMatchObject({ code: "HH" });
  });

  it("marks an unverified result preliminary, not final", () => {
    expect(mapLabResultToFhir({ ...base, status: "ENTERED" }, { patientId: "pat-1" }).status).toBe("preliminary");
  });
});

describe("mapMedicationOrderToFhir", () => {
  const order = {
    id: "mo-1", patientId: "pat-1", encounterId: "enc-1", drugName: "Amoxicillin",
    genericName: "amoxicillin", dose: "500 mg", route: "PO", frequency: "TDS",
    doseValue: 500, doseUnit: "mg", status: "ORDERED", orderedByStaffId: "staff-1",
    orderedAt: AT, externalCode: null as { system: string; code: string; display?: string } | null,
  };

  it("emits text-only medication when no terminology mapping exists", () => {
    const r = mapMedicationOrderToFhir(order);
    expect(r.medicationCodeableConcept?.coding).toBeUndefined();
    expect(r.medicationCodeableConcept?.text).toContain("Amoxicillin");
  });

  it("emits an external coding ONLY when a mapping supplied one", () => {
    const r = mapMedicationOrderToFhir({ ...order, externalCode: { system: "http://snomed.info/sct", code: "372687004" } });
    expect(r.medicationCodeableConcept?.coding?.[0]).toMatchObject({ code: "372687004" });
  });

  it("maps a discontinued order to stopped, not completed", () => {
    expect(mapMedicationOrderToFhir({ ...order, status: "DISCONTINUED" }).status).toBe("stopped");
  });

  it("omits doseAndRate when no structured dose exists", () => {
    const r = mapMedicationOrderToFhir({ ...order, doseValue: null, doseUnit: null });
    expect(r.dosageInstruction?.[0].doseAndRate).toBeUndefined();
    expect(r.dosageInstruction?.[0].text).toBe("500 mg PO TDS");
  });
});

describe("mapDocumentToFhir", () => {
  const doc = {
    id: "doc-1", patientId: "pat-1", encounterId: "enc-1", type: "REPORT",
    title: "Discharge note", storageRef: "s3://bucket/doc-1", status: "CURRENT",
    authorStaffId: "staff-1", createdAt: AT,
  };

  it("references the existing document instead of copying it", () => {
    const r = mapDocumentToFhir(doc);
    expect(r.status).toBe("current");
    expect(r.content[0].attachment.url).toBe("s3://bucket/doc-1");
  });

  it("omits the url when no file has been attached yet", () => {
    const r = mapDocumentToFhir({ ...doc, storageRef: null });
    expect(r.content[0].attachment.url).toBeUndefined();
    expect(r.content[0].attachment.title).toBe("Discharge note");
  });

  it("maps a superseded document to the superseded status", () => {
    expect(mapDocumentToFhir({ ...doc, status: "SUPERSEDED" }).status).toBe("superseded");
  });
});

describe("buildDocumentBundle", () => {
  const subject = mapPatientToFhir(patient);
  const custodian = mapOrganizationToFhir({ id: "fac-1", name: "Aarogya Medical Centre", city: "Pune" });
  const encounter = mapEncounterToFhir({
    id: "enc-1", patientId: "pat-1", facilityId: "fac-1", type: "OPD", status: "CLOSED",
    chiefComplaint: null, attendingStaffId: null, registeredAt: AT, closedAt: AT,
  });

  const build = () => buildDocumentBundle({
    bundleType: "OP_CONSULT", bundleId: "bundle-1", timestamp: AT,
    subject, author: custodian, custodian, encounter,
    sections: [
      { title: "Diagnoses", resources: [mapDiagnosisToFhir({
        id: "dx-1", patientId: "pat-1", encounterId: "enc-1", diagnosis: "Migraine",
        type: "FINAL", status: "ACTIVE", onsetDate: null, codeSystem: null, code: null,
        diagnosedByStaffId: "staff-1", createdAt: AT,
      })] },
      { title: "Empty", resources: [] },
    ],
  });

  it("is a document Bundle whose FIRST entry is the Composition", () => {
    const b = build();
    expect(b.type).toBe("document");
    expect(b.entry?.[0].resource?.resourceType).toBe("Composition");
  });

  it("drops empty sections from the Composition", () => {
    const composition = build().entry?.[0].resource as { section?: { title?: string }[] };
    expect(composition.section?.map((s) => s.title)).toEqual(["Diagnoses"]);
  });

  it("de-duplicates a resource referenced from several places", () => {
    const b = build();
    const keys = b.entry!.map((e) => `${e.resource?.resourceType}/${e.resource?.id}`);
    // author and custodian are the same Organization and must appear once.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("hashes identically across builds with the same inputs", () => {
    expect(hashBundle(build())).toBe(hashBundle(build()));
  });

  it("hashes differently when clinical content changes", () => {
    const other = buildDocumentBundle({
      bundleType: "OP_CONSULT", bundleId: "bundle-1", timestamp: AT,
      subject, author: custodian, custodian, encounter, sections: [],
    });
    expect(hashBundle(other)).not.toBe(hashBundle(build()));
  });

  it("is insensitive to key insertion order", () => {
    // Rebuild every object with its keys in REVERSE order. The content is
    // identical, only the insertion order differs — which is exactly the case
    // hashBundle must normalise, so that a bundle serialised by two different
    // code paths still proves to be the same document.
    const shuffleKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(shuffleKeys);
      if (value && typeof value === "object") {
        return Object.keys(value as Record<string, unknown>)
          .reverse()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = shuffleKeys((value as Record<string, unknown>)[k]);
            return acc;
          }, {});
      }
      return value;
    };
    const b = build();
    const reordered = shuffleKeys(b) as ReturnType<typeof build>;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(b)); // genuinely reordered
    expect(hashBundle(reordered)).toBe(hashBundle(b));
  });
});
