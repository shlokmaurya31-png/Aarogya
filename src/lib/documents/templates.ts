/**
 * Phase 1.2 — document templates.
 *
 * Each template maps typed input to a data-only DocumentSpec (layout.ts renders
 * it). Templates are pure and side-effect free, so they are unit-tested without
 * pdf-lib or a database. Money is always passed in MINOR units (paise) and
 * formatted here — never a float.
 */
import type { DocumentSpec, DocumentSection, Letterhead } from "./pdf/layout";

export const DOCUMENT_TYPES = [
  "prescription",
  "opd-summary",
  "discharge-summary",
  "lab-report",
  "radiology-report",
  "invoice",
  "refund-note",
  "claim-packet",
  "certificate",
  "referral-letter",
  "death-certificate",
  "birth-record",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export function isDocumentType(v: string): v is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(v);
}

export interface PatientRef {
  name: string;
  uhid?: string;
  ageSex?: string;
  phone?: string;
}

export function formatINR(minorUnits: number): string {
  const rupees = minorUnits / 100;
  // "Rs." rather than the ₹ glyph: the standard PDF fonts are WinAnsi-encoded and
  // cannot render U+20B9 without embedding a full Unicode font. "Rs." is standard
  // on Indian tax invoices and keeps the document dependency-free.
  return `Rs. ${rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function patientSection(p: PatientRef): DocumentSection {
  const rows = [{ label: "Patient", value: p.name }];
  if (p.uhid) rows.push({ label: "UHID", value: p.uhid });
  if (p.ageSex) rows.push({ label: "Age / Sex", value: p.ageSex });
  if (p.phone) rows.push({ label: "Phone", value: p.phone });
  return { kind: "keyValues", rows };
}

// ── Per-type payloads ────────────────────────────────────────────────────────
export interface RxItem { drug: string; dose: string; frequency: string; duration: string; instructions?: string }
export interface PrescriptionInput {
  type: "prescription";
  patient: PatientRef;
  diagnosis?: string;
  items: RxItem[];
  advice?: string;
  followUp?: string;
}
export interface OpdSummaryInput {
  type: "opd-summary";
  patient: PatientRef;
  chiefComplaint?: string;
  findings?: string;
  diagnosis?: string;
  plan?: string;
  vitals?: Array<{ label: string; value: string }>;
}
export interface DischargeSummaryInput {
  type: "discharge-summary";
  patient: PatientRef;
  admittedOn?: string;
  dischargedOn?: string;
  diagnoses: string[];
  procedures?: string[];
  hospitalCourse?: string;
  dischargeMeds?: RxItem[];
  followUp?: string;
}
export interface LabReportInput {
  type: "lab-report";
  patient: PatientRef;
  panel: string;
  results: Array<{ analyte: string; value: string; unit: string; range: string; flag?: string }>;
  verifiedBy?: string;
}
export interface RadiologyReportInput {
  type: "radiology-report";
  patient: PatientRef;
  study: string;
  technique?: string;
  findings: string;
  impression: string;
}
export interface InvoiceLine { description: string; hsnSac?: string; qty: number; unitMinor: number; taxPct: number }
export interface InvoiceInput {
  type: "invoice";
  patient: PatientRef;
  invoiceNo: string;
  gstin?: string;
  lines: InvoiceLine[];
  paidMinor?: number;
}
export interface RefundNoteInput {
  type: "refund-note";
  patient: PatientRef;
  refundNo: string;
  againstInvoiceNo: string;
  amountMinor: number;
  reason: string;
  method?: string;
}
export interface ClaimPacketInput {
  type: "claim-packet";
  patient: PatientRef;
  claimNo: string;
  payer: string;
  policyNo?: string;
  diagnoses: string[];
  claimedMinor: number;
  documents: string[];
}
export interface CertificateInput {
  type: "certificate";
  patient: PatientRef;
  certificateKind: string; // Fitness / Medical / Sick Leave
  body: string;
  fromDate?: string;
  toDate?: string;
}
export interface ReferralLetterInput {
  type: "referral-letter";
  patient: PatientRef;
  referredTo: string;
  reason: string;
  clinicalSummary: string;
}
export interface DeathCertificateInput {
  type: "death-certificate";
  deceasedName: string;
  ageSex?: string;
  dateOfDeath: string;
  timeOfDeath?: string;
  placeOfDeath?: string;
  causeOfDeath: string;
  attendedByName?: string;
}
export interface BirthRecordInput {
  type: "birth-record";
  childSex: string;
  dateOfBirth: string;
  timeOfBirth?: string;
  motherName: string;
  fatherName?: string;
  placeOfBirth?: string;
  weightGrams?: number;
}

export type DocumentInput =
  | PrescriptionInput
  | OpdSummaryInput
  | DischargeSummaryInput
  | LabReportInput
  | RadiologyReportInput
  | InvoiceInput
  | RefundNoteInput
  | ClaimPacketInput
  | CertificateInput
  | ReferralLetterInput
  | DeathCertificateInput
  | BirthRecordInput;

export interface BuildContext {
  letterhead: Letterhead;
  documentNumber: string;
  issuedOn: string;
  verifyUrl?: string;
  isDraft?: boolean;
}

const rxRows = (items: RxItem[]): string[][] =>
  items.map((i) => [i.drug, i.dose, i.frequency, i.duration, i.instructions ?? ""]);

const RX_HEADERS = ["Medicine", "Dose", "Frequency", "Duration", "Instructions"];
const RX_WIDTHS = [0.28, 0.13, 0.18, 0.15, 0.26];

/** Build the human-readable title for a document. */
export function documentTitle(input: DocumentInput): string {
  switch (input.type) {
    case "prescription": return "Prescription";
    case "opd-summary": return "OPD Consultation Summary";
    case "discharge-summary": return "Discharge Summary";
    case "lab-report": return "Laboratory Report";
    case "radiology-report": return "Radiology Report";
    case "invoice": return "Tax Invoice / Receipt";
    case "refund-note": return "Refund Note";
    case "claim-packet": return "Insurance Claim Packet";
    case "certificate": return `${input.certificateKind} Certificate`;
    case "referral-letter": return "Referral Letter";
    case "death-certificate": return "Certificate of Cause of Death (Form 4/4A)";
    case "birth-record": return "Record of Birth";
  }
}

export function buildDocumentSpec(input: DocumentInput, ctx: BuildContext): DocumentSpec {
  const base = {
    letterhead: ctx.letterhead,
    title: documentTitle(input),
    meta: [
      { label: "Document No.", value: ctx.documentNumber },
      { label: "Issued On", value: ctx.issuedOn },
    ],
    verifyUrl: ctx.verifyUrl,
    footerNote: `${ctx.letterhead.facilityName} · Generated by Aarogya · Authenticity: ${ctx.verifyUrl ?? "n/a"}`,
    isDraft: ctx.isDraft,
  };

  const sign = (label: string): DocumentSection => ({
    kind: "signature",
    label,
    name: ctx.letterhead.authorName,
    registration: ctx.letterhead.authorRegistration,
  });

  let sections: DocumentSection[];
  switch (input.type) {
    case "prescription":
      sections = [
        patientSection(input.patient),
        ...(input.diagnosis ? [{ kind: "keyValues", rows: [{ label: "Diagnosis", value: input.diagnosis }] } as DocumentSection] : []),
        { kind: "heading", text: "Rx" },
        { kind: "table", headers: RX_HEADERS, rows: rxRows(input.items), widths: RX_WIDTHS },
        ...(input.advice ? [{ kind: "paragraph", text: `Advice: ${input.advice}` } as DocumentSection] : []),
        ...(input.followUp ? [{ kind: "keyValues", rows: [{ label: "Follow-up", value: input.followUp }] } as DocumentSection] : []),
        sign("Prescribing Doctor"),
      ];
      break;
    case "opd-summary":
      sections = [
        patientSection(input.patient),
        ...(input.vitals && input.vitals.length ? [{ kind: "keyValues", rows: input.vitals } as DocumentSection] : []),
        ...(input.chiefComplaint ? [{ kind: "heading", text: "Chief Complaint" } as DocumentSection, { kind: "paragraph", text: input.chiefComplaint } as DocumentSection] : []),
        ...(input.findings ? [{ kind: "heading", text: "Examination Findings" } as DocumentSection, { kind: "paragraph", text: input.findings } as DocumentSection] : []),
        ...(input.diagnosis ? [{ kind: "heading", text: "Diagnosis" } as DocumentSection, { kind: "paragraph", text: input.diagnosis } as DocumentSection] : []),
        ...(input.plan ? [{ kind: "heading", text: "Plan" } as DocumentSection, { kind: "paragraph", text: input.plan } as DocumentSection] : []),
        sign("Consulting Doctor"),
      ];
      break;
    case "discharge-summary":
      sections = [
        patientSection(input.patient),
        { kind: "keyValues", rows: [
          { label: "Admitted On", value: input.admittedOn ?? "-" },
          { label: "Discharged On", value: input.dischargedOn ?? "-" },
        ] },
        { kind: "heading", text: "Final Diagnoses" },
        { kind: "paragraph", text: input.diagnoses.join("\n") || "-" },
        ...(input.procedures && input.procedures.length ? [{ kind: "heading", text: "Procedures" } as DocumentSection, { kind: "paragraph", text: input.procedures.join("\n") } as DocumentSection] : []),
        ...(input.hospitalCourse ? [{ kind: "heading", text: "Hospital Course" } as DocumentSection, { kind: "paragraph", text: input.hospitalCourse } as DocumentSection] : []),
        ...(input.dischargeMeds && input.dischargeMeds.length ? [{ kind: "heading", text: "Medications at Discharge" } as DocumentSection, { kind: "table", headers: RX_HEADERS, rows: rxRows(input.dischargeMeds), widths: RX_WIDTHS } as DocumentSection] : []),
        ...(input.followUp ? [{ kind: "keyValues", rows: [{ label: "Follow-up", value: input.followUp }] } as DocumentSection] : []),
        sign("Discharging Doctor"),
      ];
      break;
    case "lab-report":
      sections = [
        patientSection(input.patient),
        { kind: "heading", text: input.panel },
        { kind: "table",
          headers: ["Analyte", "Result", "Unit", "Reference", "Flag"],
          rows: input.results.map((r) => [r.analyte, r.value, r.unit, r.range, r.flag ?? ""]),
          widths: [0.32, 0.16, 0.14, 0.26, 0.12] },
        sign(input.verifiedBy ? "Verified By" : "Pathologist"),
      ];
      break;
    case "radiology-report":
      sections = [
        patientSection(input.patient),
        { kind: "keyValues", rows: [{ label: "Study", value: input.study }, ...(input.technique ? [{ label: "Technique", value: input.technique }] : [])] },
        { kind: "heading", text: "Findings" },
        { kind: "paragraph", text: input.findings },
        { kind: "heading", text: "Impression" },
        { kind: "paragraph", text: input.impression },
        sign("Reporting Radiologist"),
      ];
      break;
    case "invoice": {
      const rows = input.lines.map((l) => {
        const gross = l.qty * l.unitMinor;
        const tax = Math.round((gross * l.taxPct) / 100);
        return [l.description, l.hsnSac ?? "", String(l.qty), formatINR(l.unitMinor), `${l.taxPct}%`, formatINR(gross + tax)];
      });
      const subtotal = input.lines.reduce((a, l) => a + l.qty * l.unitMinor, 0);
      const taxTotal = input.lines.reduce((a, l) => a + Math.round((l.qty * l.unitMinor * l.taxPct) / 100), 0);
      const total = subtotal + taxTotal;
      sections = [
        patientSection(input.patient),
        { kind: "keyValues", rows: [{ label: "Invoice No.", value: input.invoiceNo }, ...(input.gstin ? [{ label: "GSTIN", value: input.gstin }] : [])] },
        { kind: "table",
          headers: ["Description", "HSN/SAC", "Qty", "Rate", "Tax", "Amount"],
          rows, widths: [0.32, 0.14, 0.08, 0.16, 0.1, 0.2] },
        { kind: "keyValues", rows: [
          { label: "Subtotal", value: formatINR(subtotal) },
          { label: "Tax", value: formatINR(taxTotal) },
          { label: "Total", value: formatINR(total) },
          { label: "Paid", value: formatINR(input.paidMinor ?? 0) },
          { label: "Balance", value: formatINR(total - (input.paidMinor ?? 0)) },
        ] },
        { kind: "note", text: "This is a computer-generated tax invoice." },
      ];
      break;
    }
    case "refund-note":
      sections = [
        patientSection(input.patient),
        { kind: "keyValues", rows: [
          { label: "Refund No.", value: input.refundNo },
          { label: "Against Invoice", value: input.againstInvoiceNo },
          { label: "Amount", value: formatINR(input.amountMinor) },
          { label: "Method", value: input.method ?? "-" },
        ] },
        { kind: "heading", text: "Reason" },
        { kind: "paragraph", text: input.reason },
        sign("Authorised Signatory"),
      ];
      break;
    case "claim-packet":
      sections = [
        patientSection(input.patient),
        { kind: "keyValues", rows: [
          { label: "Claim No.", value: input.claimNo },
          { label: "Payer", value: input.payer },
          ...(input.policyNo ? [{ label: "Policy No.", value: input.policyNo }] : []),
          { label: "Amount Claimed", value: formatINR(input.claimedMinor) },
        ] },
        { kind: "heading", text: "Diagnoses" },
        { kind: "paragraph", text: input.diagnoses.join("\n") || "-" },
        { kind: "heading", text: "Enclosed Documents" },
        { kind: "paragraph", text: input.documents.map((d, i) => `${i + 1}. ${d}`).join("\n") || "-" },
        sign("Authorised Signatory"),
      ];
      break;
    case "certificate":
      sections = [
        patientSection(input.patient),
        ...(input.fromDate || input.toDate ? [{ kind: "keyValues", rows: [{ label: "Period", value: `${input.fromDate ?? "-"} to ${input.toDate ?? "-"}` }] } as DocumentSection] : []),
        { kind: "paragraph", text: input.body },
        sign("Certifying Doctor"),
      ];
      break;
    case "referral-letter":
      sections = [
        patientSection(input.patient),
        { kind: "keyValues", rows: [{ label: "Referred To", value: input.referredTo }] },
        { kind: "heading", text: "Reason for Referral" },
        { kind: "paragraph", text: input.reason },
        { kind: "heading", text: "Clinical Summary" },
        { kind: "paragraph", text: input.clinicalSummary },
        sign("Referring Doctor"),
      ];
      break;
    case "death-certificate":
      sections = [
        { kind: "keyValues", rows: [
          { label: "Name of Deceased", value: input.deceasedName },
          { label: "Age / Sex", value: input.ageSex ?? "-" },
          { label: "Date of Death", value: input.dateOfDeath },
          { label: "Time of Death", value: input.timeOfDeath ?? "-" },
          { label: "Place of Death", value: input.placeOfDeath ?? "-" },
        ] },
        { kind: "heading", text: "Cause of Death" },
        { kind: "paragraph", text: input.causeOfDeath },
        { kind: "note", text: "Issued in Form 4/4A format under the Registration of Births and Deaths Act, 1969." },
        sign(input.attendedByName ? "Medical Attendant" : "Certifying Doctor"),
      ];
      break;
    case "birth-record":
      sections = [
        { kind: "keyValues", rows: [
          { label: "Sex of Child", value: input.childSex },
          { label: "Date of Birth", value: input.dateOfBirth },
          { label: "Time of Birth", value: input.timeOfBirth ?? "-" },
          { label: "Weight", value: input.weightGrams ? `${input.weightGrams} g` : "-" },
          { label: "Mother's Name", value: input.motherName },
          { label: "Father's Name", value: input.fatherName ?? "-" },
          { label: "Place of Birth", value: input.placeOfBirth ?? "-" },
        ] },
        { kind: "note", text: "This hospital record supports statutory birth registration; it is not the municipal birth certificate." },
        sign("Authorised Signatory"),
      ];
      break;
  }

  return { ...base, sections };
}
