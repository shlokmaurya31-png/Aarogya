import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  buildDocumentSpec,
  documentTitle,
  formatINR,
  isDocumentType,
  DOCUMENT_TYPES,
  type DocumentInput,
} from "./templates";
import { renderDocument, type DocumentSpec } from "./pdf/layout";
import { toPublicVerification } from "./verify";
import { defaultDocumentNumber, newVerifyToken, verifyUrlFor } from "./service";

const LETTERHEAD = { facilityName: "Test Hospital", authorName: "Dr. A. Rao", authorRegistration: "MH-12345" };
const CTX = { letterhead: LETTERHEAD, documentNumber: "TEST-1", issuedOn: "1 Jan 2026", verifyUrl: "http://x/verify/t" };
const PATIENT = { name: "Ravi Kumar", uhid: "UH-1", ageSex: "42 / M" };

// One representative input per document type.
const SAMPLES: DocumentInput[] = [
  { type: "prescription", patient: PATIENT, diagnosis: "URTI", items: [{ drug: "Amoxicillin 500mg", dose: "1 tab", frequency: "1-0-1", duration: "5 days", instructions: "after food" }], followUp: "after 5 days" },
  { type: "opd-summary", patient: PATIENT, chiefComplaint: "Fever", findings: "Throat congested", diagnosis: "URTI", plan: "Antibiotics", vitals: [{ label: "BP", value: "120/80" }] },
  { type: "discharge-summary", patient: PATIENT, admittedOn: "1 Jan", dischargedOn: "3 Jan", diagnoses: ["Pneumonia"], procedures: ["None"], hospitalCourse: "Improved", dischargeMeds: [{ drug: "Azithromycin", dose: "500mg", frequency: "1-0-0", duration: "3 days" }], followUp: "1 week" },
  { type: "lab-report", patient: PATIENT, panel: "CBC", results: [{ analyte: "Hb", value: "9.1", unit: "g/dL", range: "13-17", flag: "L" }], verifiedBy: "Dr. Path" },
  { type: "radiology-report", patient: PATIENT, study: "Chest X-ray", technique: "PA view", findings: "Consolidation RLL", impression: "Pneumonia" },
  { type: "invoice", patient: PATIENT, invoiceNo: "INV-1", gstin: "27ABCDE1234F1Z5", lines: [{ description: "Consultation", hsnSac: "9993", qty: 1, unitMinor: 50000, taxPct: 18 }], paidMinor: 59000 },
  { type: "refund-note", patient: PATIENT, refundNo: "RFD-1", againstInvoiceNo: "INV-1", amountMinor: 20000, reason: "Overpayment", method: "UPI" },
  { type: "claim-packet", patient: PATIENT, claimNo: "CLM-1", payer: "Star Health", policyNo: "P-9", diagnoses: ["Pneumonia"], claimedMinor: 500000, documents: ["Discharge summary", "Bills"] },
  { type: "certificate", patient: PATIENT, certificateKind: "Fitness", body: "Fit to resume duty.", fromDate: "1 Jan", toDate: "3 Jan" },
  { type: "referral-letter", patient: PATIENT, referredTo: "Dr. Cardio", reason: "Chest pain", clinicalSummary: "Stable angina suspected." },
  { type: "death-certificate", deceasedName: "X Y", ageSex: "80 / M", dateOfDeath: "2 Jan 2026", causeOfDeath: "Cardiac arrest" },
  { type: "birth-record", childSex: "Female", dateOfBirth: "2 Jan 2026", motherName: "A B", weightGrams: 3100 },
];

describe("document type guard", () => {
  it("recognises every known type and rejects others", () => {
    for (const t of DOCUMENT_TYPES) expect(isDocumentType(t)).toBe(true);
    expect(isDocumentType("nope")).toBe(false);
  });
  it("covers all 12 declared types with a sample", () => {
    expect(new Set(SAMPLES.map((s) => s.type)).size).toBe(DOCUMENT_TYPES.length);
  });
});

describe("money formatting", () => {
  it("formats minor units as INR with 2 decimals", () => {
    expect(formatINR(59000)).toBe("Rs. 590.00");
    expect(formatINR(0)).toBe("Rs. 0.00");
  });
});

describe("buildDocumentSpec", () => {
  for (const sample of SAMPLES) {
    it(`builds a non-empty spec for ${sample.type}`, () => {
      const spec = buildDocumentSpec(sample, CTX);
      expect(spec.title).toBe(documentTitle(sample));
      expect(spec.sections.length).toBeGreaterThan(0);
      expect(spec.verifyUrl).toBe(CTX.verifyUrl);
      expect(spec.footerNote).toContain("Test Hospital");
    });
  }

  it("computes invoice totals as subtotal + tax", () => {
    const spec = buildDocumentSpec(SAMPLES.find((s) => s.type === "invoice")!, CTX);
    const kv = spec.sections.find((s) => s.kind === "keyValues" && s.rows.some((r) => r.label === "Total"));
    expect(kv && kv.kind === "keyValues").toBe(true);
    if (kv && kv.kind === "keyValues") {
      // 500.00 + 18% = 590.00
      expect(kv.rows.find((r) => r.label === "Total")?.value).toBe("Rs. 590.00");
      expect(kv.rows.find((r) => r.label === "Balance")?.value).toBe("Rs. 0.00");
    }
  });
});

describe("PDF rendering", () => {
  it("renders a valid PDF beginning with the %PDF header", async () => {
    const bytes = await renderDocument(buildDocumentSpec(SAMPLES[0], CTX));
    expect(Buffer.from(bytes.slice(0, 5)).toString("ascii")).toBe("%PDF-");
  });

  it("paginates long content onto multiple pages", async () => {
    const spec: DocumentSpec = {
      letterhead: LETTERHEAD,
      title: "Long",
      sections: Array.from({ length: 80 }, (_, i) => ({ kind: "paragraph" as const, text: `Line ${i} ${"lorem ipsum ".repeat(6)}` })),
      footerNote: "x",
    };
    const bytes = await renderDocument(spec);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThan(1);
  });

  it("renders every template without throwing", async () => {
    for (const sample of SAMPLES) {
      const bytes = await renderDocument(buildDocumentSpec(sample, CTX));
      expect(bytes.length).toBeGreaterThan(500);
    }
  });
});

describe("public verification projection", () => {
  it("returns invalid for a missing row", () => {
    expect(toPublicVerification(null, undefined)).toEqual({ valid: false });
  });
  it("exposes only non-PHI fields", () => {
    const pub = toPublicVerification(
      { type: "prescription", title: "Prescription", documentNumber: "RX-1", isDraft: false, createdAt: new Date("2026-01-01T10:00:00Z") },
      "Test Hospital"
    );
    expect(pub.valid).toBe(true);
    expect(pub.facilityName).toBe("Test Hospital");
    expect(pub.documentNumber).toBe("RX-1");
    // No patient/clinical keys are present in the projection at all.
    expect(Object.keys(pub).sort()).toEqual(
      ["documentNumber", "documentType", "facilityName", "isDraft", "issuedOn", "title", "valid"].sort()
    );
  });
});

describe("service helpers", () => {
  it("builds a document number with the type prefix and a date", () => {
    expect(defaultDocumentNumber("prescription", new Date("2026-01-02T00:00:00"))).toMatch(/^RX-20260102-[0-9A-F]{6}$/);
    expect(defaultDocumentNumber("invoice", new Date("2026-01-02T00:00:00"))).toMatch(/^INV-/);
  });
  it("mints distinct verify tokens", () => {
    const a = newVerifyToken();
    const b = newVerifyToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(30);
  });
  it("builds an absolute verify URL", () => {
    expect(verifyUrlFor("abc")).toMatch(/\/verify\/abc$/);
  });
});
