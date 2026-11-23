import { describe, expect, it } from "vitest";
import { findPatientIdentifiers, highlightExcerpt, looksLikeAadhaar, maskNumber, normalizeMobile, scanIdentifiers, verhoeffValid } from "./identifiers";

/**
 * RAG Phase 2, step 2.5, with the rules revised before Phase 3 (plan §13.4 C):
 * one fixture per refused pattern; a 12-digit number is refused only when it
 * passes the Aadhaar checksum, otherwise highlighted; a mobile is highlighted
 * unless it is on the facility's published contact list. Synthetic values only
 * (234567890124 is checksum-valid and issued to no one).
 */
describe("findPatientIdentifiers (refusals)", () => {
  const refused: [string, string][] = [
    ["ABHA_NUMBER", "Linked ABHA 91-2345-6789-0123 at registration."],
    ["ABHA_NUMBER", "ABHA 91234567890123 verified"],
    ["ABHA_NUMBER", "Address ramesh.k@abdm on file"],
    ["AADHAAR_NUMBER", "ID proof 2345 6789 0124 seen"],
    ["AADHAAR_NUMBER", "Aadhaar: 234567890124"],
    ["AADHAAR_NUMBER", "Card 3456-7890-1238 copied"],
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
    it(`refuses ${kind} in "${text}"`, () => expect(findPatientIdentifiers(text)).toContain(kind));
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
    it(`passes "${text}" with nothing to refuse or highlight`, () => expect(scanIdentifiers(text)).toEqual({ refused: [], highlights: [] }));
  }

  it("never returns the text it matched", () => {
    const out = JSON.stringify(findPatientIdentifiers("Call 9876543210; Aadhaar 2345 6789 0124"));
    expect(out).not.toMatch(/\d{4}/);
  });
});

describe("the Aadhaar checksum", () => {
  it("accepts checksum-valid numbers and rejects a one-digit change", () => {
    expect(verhoeffValid("234567890124")).toBe(true);
    expect(verhoeffValid("234567890123")).toBe(false);
    expect(verhoeffValid("345678901238")).toBe(true);
  });
  it("never treats a number starting 0 or 1 as Aadhaar, even when the checksum holds", () => {
    const valid01 = ["0", "1"].flatMap((d) => Array.from({ length: 10 }, (_, k) => `${d}2345678901${k}`)).filter(verhoeffValid);
    expect(valid01.length).toBeGreaterThan(0);
    for (const n of valid01) {
      expect(looksLikeAadhaar(n)).toBe(false);
      expect(scanIdentifiers(`Code ${n}`).refused).toEqual([]);
      expect(scanIdentifiers(`Code ${n}`).highlights.map((h) => h.kind)).toEqual(["TWELVE_DIGIT_NUMBER"]);
    }
  });
});

describe("highlights", () => {
  it("highlights a 12-digit number that fails the checksum, grouped or not", () => {
    for (const text of ["Lot 2345 6789 0123 received", "GTIN 234567890123 on the box", "Ref 1234-5678-9012"]) {
      const s = scanIdentifiers(text);
      expect(s.refused).toEqual([]);
      expect(s.highlights.map((h) => h.kind)).toEqual(["TWELVE_DIGIT_NUMBER"]);
    }
  });
  it("highlights a mobile that isn't on the contact list, in each written form", () => {
    for (const text of ["Call the relative on +91 98765 43210.", "Contact 9876543210 after discharge", "Ring 09876543210"]) {
      const s = scanIdentifiers(text);
      expect(s.refused).toEqual([]);
      expect(s.highlights.map((h) => h.kind)).toEqual(["MOBILE_NUMBER"]);
    }
  });
  it("allows a mobile on the facility's published contact list, however it is written", () => {
    const allowed = new Set(["9876543210"]);
    for (const text of ["Ambulance: +91 98765 43210", "Switchboard 09876543210", "Helpline 98765-43210"]) expect(scanIdentifiers(text, { allowedMobiles: allowed }).highlights).toEqual([]);
    expect(scanIdentifiers("Ambulance 9876543210, ward 9123456780", { allowedMobiles: allowed }).highlights).toHaveLength(1);
  });
  it("a refusal and a highlight in one text are both reported", () => {
    const s = scanIdentifiers("Aadhaar 234567890124; call 9876543210");
    expect(s.refused).toEqual(["AADHAAR_NUMBER"]);
    expect(s.highlights.map((h) => h.kind)).toEqual(["MOBILE_NUMBER"]);
  });
  it("normalises mobiles to ten digits", () => {
    expect(normalizeMobile("+91 98765 43210")).toBe("9876543210");
    expect(normalizeMobile("098765-43210")).toBe("9876543210");
    expect(normalizeMobile("1800116117")).toBeNull();
  });
  it("shows the approver an excerpt with the number masked to its last four digits, and no other long number", () => {
    const text = "Blood bank after hours: 9876543210. Store code 4455667788 stays.";
    const h = scanIdentifiers(text).highlights[0];
    const ex = highlightExcerpt(text, h);
    expect(ex).toContain("[••••••3210]");
    expect(ex).not.toContain("9876543210");
    expect(ex).not.toContain("4455667788");
    expect(maskNumber("2345 6789 0123")).toBe("••••••••0123");
  });
});
