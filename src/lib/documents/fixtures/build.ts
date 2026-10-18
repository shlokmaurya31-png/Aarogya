import type { ExtractedFactType } from "@prisma/client";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { LABELS, LANGUAGE_SCRIPT, type LabelKey, type SupportedLanguage } from "../vocab";
import type { DocumentType } from "./types";
import type { DocumentFixture, ExpectedFact, FixtureLine } from "./types";

/**
 * Week 4a — synthetic report builders (docs/DOCUMENT_PIPELINE_DESIGN.md §10.1).
 * Each builder writes a report's lines AND its expected facts from the same
 * structured input, so the expected answers are exact by construction. No real
 * documents: every name, number and place is invented.
 */

export interface LabTest { analyte: string; value: string; unit: string; range?: string; flag?: "H" | "L" }
export interface Medicine { form: "Tab." | "Cap." | "Syp." | "Inj."; name: string; dose: string; frequency: string; duration?: string }
interface Common {
  id: string; language: SupportedLanguage; facility: string; date: string; patient: string;
  doctor?: { name: string; reg?: string };
  /** Bilingual labels ("native / English") and English prose: a mixed-language page. */
  mixed?: boolean;
  handwritten?: boolean;
  /** Handwritten OCR misreads: what the OCR mock returns instead (exact substring → misread). */
  misreads?: Record<string, string>;
  targetLanguage?: SupportedLanguage;
  brands?: string[];
}

const FREQ: Record<string, "OD" | "BD" | "TDS" | "QID" | "HS" | "SOS"> = { "1-0-0": "OD", "0-0-1": "HS", "1-0-1": "BD", "1-1-1": "TDS", "1-1-1-1": "QID", OD: "OD", BD: "BD", TDS: "TDS", QID: "QID", HS: "HS", SOS: "SOS" };

class Writer {
  lines: FixtureLine[] = [];
  facts: ExpectedFact[] = [];
  constructor(readonly c: Common) {}
  label(key: LabelKey) {
    const native = LABELS[this.c.language][key];
    return this.c.mixed && this.c.language !== "en" ? `${native} / ${LABELS.en[key]}` : native;
  }
  line(text: string) { this.lines.push({ text }); return text; }
  meta(documentType: DocumentType, titleKey: LabelKey) {
    this.line(this.c.facility);
    this.line(this.label(titleKey));
    this.line(`${this.label("patient")}: ${this.c.patient}`);
    this.line(`${this.label("date")}: ${this.c.date}`);
    const value: Record<string, string> = { documentType, documentDate: this.c.date, facilityName: this.c.facility };
    if (this.c.doctor) {
      this.line(this.c.doctor.name);
      value.doctorName = this.c.doctor.name;
      if (this.c.doctor.reg) { this.line(`Reg. No. ${this.c.doctor.reg}`); value.registrationNo = this.c.doctor.reg; }
    }
    this.facts.push({ factType: "DOCUMENT_META", value });
  }
  lab(t: LabTest) {
    const text = this.line(`${t.analyte} ${t.value} ${t.unit}${t.range ? ` (${t.range})` : ""}${t.flag ? ` ${t.flag}` : ""}`);
    const value: Record<string, unknown> = { analyte: t.analyte, value: t.value, unit: t.unit };
    if (/^\d+(\.\d+)?$/.test(t.value)) value.numericValue = Number(t.value);
    if (t.range) value.referenceRange = t.range;
    if (t.flag) value.flag = t.flag;
    this.facts.push({ factType: "LAB_VALUE", value, sourceText: text });
  }
  med(m: Medicine) {
    const text = this.line(`${m.form} ${m.name} ${m.dose} ${m.frequency}${m.duration ? ` x ${m.duration}` : ""}`);
    const value: Record<string, unknown> = { name: m.name, form: m.form, dose: m.dose, frequency: m.frequency };
    if (FREQ[m.frequency]) value.frequencyCode = FREQ[m.frequency];
    if (m.duration) value.duration = m.duration;
    this.facts.push({ factType: "MEDICATION", value, sourceText: text });
  }
  labelled(key: "diagnosis" | "allergy" | "procedure" | "impression", text: string) {
    const src = this.line(`${this.label(key)}: ${text}`);
    const factType: ExtractedFactType = key === "allergy" ? "ALLERGY" : key === "procedure" ? "PROCEDURE" : "DIAGNOSIS";
    this.facts.push({ factType, value: factType === "ALLERGY" ? { substance: text } : { text }, sourceText: src });
  }
  advice() {
    this.line(`${this.label("advice")}: ${LABELS[this.c.language].adviceText}`);
    if (this.c.mixed && this.c.language !== "en") this.line(LABELS.en.adviceText);
  }
  done(category: DocumentFixture["category"]): DocumentFixture {
    return {
      id: this.c.id, category, language: this.c.language, script: LANGUAGE_SCRIPT[this.c.language], mixed: !!this.c.mixed,
      handwritten: !!this.c.handwritten, targetLanguage: this.c.targetLanguage ?? (this.c.language === "en" ? "hi" : "en"),
      pages: [{ lines: this.lines }], expected: this.facts, misreads: this.c.misreads ?? {}, brands: this.c.brands ?? [], patientName: this.c.patient,
    };
  }
}

export function labReport(c: Common & { tests: LabTest[] }): DocumentFixture {
  const w = new Writer(c);
  w.meta("LAB_REPORT", "labReport");
  c.tests.forEach((t) => w.lab(t));
  if (c.mixed) w.advice();
  return w.done(c.mixed ? "MIXED" : "LAB_REPORT");
}

export function prescription(c: Common & { diagnosis?: string; allergy?: string; meds: Medicine[] }): DocumentFixture {
  const w = new Writer(c);
  w.meta("PRESCRIPTION", "prescription");
  if (c.diagnosis) w.labelled("diagnosis", c.diagnosis);
  if (c.allergy) w.labelled("allergy", c.allergy);
  c.meds.forEach((m) => w.med(m));
  w.advice();
  return w.done(c.handwritten ? "HANDWRITTEN_PRESCRIPTION" : c.mixed ? "MIXED" : "PRESCRIPTION");
}

export function dischargeSummary(c: Common & { diagnosis: string; procedure?: string; allergy?: string; meds: Medicine[]; tests?: LabTest[] }): DocumentFixture {
  const w = new Writer(c);
  w.meta("DISCHARGE_SUMMARY", "dischargeSummary");
  w.labelled("diagnosis", c.diagnosis);
  if (c.procedure) w.labelled("procedure", c.procedure);
  if (c.allergy) w.labelled("allergy", c.allergy);
  (c.tests ?? []).forEach((t) => w.lab(t));
  c.meds.forEach((m) => w.med(m));
  w.advice();
  return w.done("DISCHARGE_SUMMARY");
}

export function imagingReport(c: Common & { procedure: string; impression: string }): DocumentFixture {
  const w = new Writer(c);
  w.meta("IMAGING_REPORT", "imagingReport");
  w.labelled("procedure", c.procedure);
  w.labelled("impression", c.impression);
  return w.done("IMAGING_REPORT");
}

/** What the OCR mock reads on a page: the printed lines, with a fixture's handwritten misreads applied. */
export function ocrLines(f: DocumentFixture, pageNo: number): { text: string; confidence: number }[] {
  const page = f.pages[pageNo - 1];
  if (!page) return [];
  return page.lines.map((l) => {
    let text = l.text;
    let misread = false;
    for (const [from, to] of Object.entries(f.misreads)) if (text.includes(from)) { text = text.split(from).join(to); misread = true; }
    const confidence = l.confidence ?? (f.handwritten ? (misread ? 0.62 : 0.84) : 0.97);
    return { text, confidence };
  });
}

/** The PDF marker the OCR mock reads: a page-dictionary key that survives page splitting. */
export const FIXTURE_PAGE_KEY = "AarogyaFixture";

/**
 * A synthetic PDF for a fixture: one page per fixture page, each carrying the
 * marker, with the lines drawn where the standard font can draw them (Latin).
 * Deterministic bytes (fixed dates). Rendering every script with handwriting
 * fonts and noise is the manual real-provider run's job (scripts/eval-documents.ts).
 */
export async function fixturePdf(f: DocumentFixture): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Synthetic ${f.category} ${f.id}`);
  doc.setSubject("aarogya-synthetic-fixture");
  doc.setProducer("aarogya fixtures");
  doc.setCreator("aarogya fixtures");
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  doc.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  f.pages.forEach((p, i) => {
    const page = doc.addPage([595, 842]);
    page.node.set(PDFName.of(FIXTURE_PAGE_KEY), PDFString.of(`${f.id}#${i + 1}`));
    let y = 800;
    for (const l of p.lines) {
      const drawable = /^[\x20-\x7E]*$/.test(l.text) ? l.text : "[non-Latin line]";
      page.drawText(drawable, { x: 40, y, size: 11, font });
      y -= 18;
    }
  });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
