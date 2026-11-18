import { describe, expect, it } from "vitest";
import { findPatientIdentifiers } from "./identifiers";

/** RAG Phase 2, step 2.5: one fixture per pattern is refused; clean text, short codes and toll-free numbers pass. Synthetic values only. */
describe("findPatientIdentifiers", () => {
  const refused: [string, string][] = [
    ["ABHA_NUMBER", "Linked ABHA 91-2345-6789-0123 at registration."],
    ["ABHA_NUMBER", "ABHA 91234567890123 verified"],
    ["ABHA_NUMBER", "Address ramesh.k@abdm on file"],
    ["AADHAAR_NUMBER", "ID proof 2345 6789 0123 seen"],
    ["AADHAAR_NUMBER", "Aadhaar: 234567890123"],
    ["MOBILE_NUMBER", "Call the relative on +91 98765 43210."],
    ["MOBILE_NUMBER", "Contact 9876543210 after discharge"],
    ["MOBILE_NUMBER", "Ring 09876543210"],
    ["UHID_OR_MRN", "Patient UHID-AMCP-7Q2XKD was admitted"],
    ["UHID_OR_MRN", "MRN: 00451234"],
    ["UHID_OR_MRN", "IP No. 2026/1187"],
    ["NAME_WITH_AGE", "Mr. Ramesh Kumar, 45 years, presented with chest pain."],
    ["NAME_WITH_AGE", "Smt Lata Devi 62 yrs"],
    ["NAME_WITH_AGE", "Sunita Sharma (34/F) was reviewed"],
    ["NAME_WITH_AGE", "Name: Anil Rao  Age: 51"],
    ["NAME_WITH_AGE", "श्री रमेश कुमार, 45 वर्ष"],
  ];
  for (const [kind, text] of refused) {
    it(`finds ${kind} in "${text}"`, () => expect(findPatientIdentifiers(text)).toContain(kind));
  }

  const clean = [
    "Hand hygiene: wash for 40 seconds before and after patient contact.",
    "Adults, 18 years and above: Paracetamol 500 mg every 6 hours, at most 4 g a day.",
    "Children under 5 years: 15 mg/kg per dose.",
    "In an emergency dial 112 or 108; the poison helpline is 1800-116-117.",
    "Record the patient's UHID and MRN in the register before transfer.",
    "Store insulin at 2–8 °C. Batch codes are six characters (AB12CD).",
    "HbA1c target below 7.0% for most adults; review every 3 months.",
    "Table 2: Pediatric doses, 2 years to 12 years.",
    "Version 3, effective 01-04-2026. Section 4.2.1.",
    "मधुमेह के रोगी, 40 वर्ष से अधिक आयु: वार्षिक जाँच।",
  ];
  for (const text of clean) {
    it(`passes "${text}"`, () => expect(findPatientIdentifiers(text)).toEqual([]));
  }

  it("never returns the text it matched", () => {
    const out = JSON.stringify(findPatientIdentifiers("Call 9876543210; Aadhaar 2345 6789 0123"));
    expect(out).not.toMatch(/\d{4}/);
  });
});
