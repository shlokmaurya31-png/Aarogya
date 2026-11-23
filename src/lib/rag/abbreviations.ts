/**
 * RAG Phase 3, step 3.5 — clinical abbreviations (docs/RAG_ARCHITECTURE.md
 * §6.3): a query term is expanded with its long form, and a long form with
 * its abbreviation, so "BP" finds "blood pressure" and "blood pressure" finds
 * "BP 150/94 mmHg". Expansion only ADDS terms: the question itself is never
 * rewritten, and a chart's "no record" rule still counts only the words the
 * question used. Pending clinical review (local abbreviations differ).
 */
export const ABBREVIATIONS: Record<string, string[]> = {
  bp: ["blood pressure"], hr: ["heart rate", "pulse"], rr: ["respiratory rate"], spo2: ["oxygen saturation"], temp: ["temperature"],
  hb: ["hemoglobin", "haemoglobin"], hgb: ["hemoglobin"], hba1c: ["glycated hemoglobin"], fbs: ["fasting blood sugar"], ppbs: ["postprandial blood sugar"],
  rbs: ["random blood sugar"], cbc: ["complete blood count"], tlc: ["total leucocyte count"], wbc: ["white blood cell"], esr: ["erythrocyte sedimentation rate"],
  crp: ["c-reactive protein"], kft: ["kidney function test"], rft: ["renal function test"], lft: ["liver function test"], tft: ["thyroid function test"],
  tsh: ["thyroid stimulating hormone"], inr: ["international normalised ratio"], bun: ["blood urea nitrogen"], egfr: ["estimated glomerular filtration rate"],
  sgpt: ["alt", "alanine aminotransferase"], sgot: ["ast", "aspartate aminotransferase"], ecg: ["electrocardiogram"], ekg: ["electrocardiogram"],
  cxr: ["chest x-ray"], usg: ["ultrasound"], ct: ["computed tomography"], mri: ["magnetic resonance imaging"], echo: ["echocardiogram"],
  abg: ["arterial blood gas"], iv: ["intravenous"], im: ["intramuscular"], sc: ["subcutaneous"], po: ["oral", "by mouth"],
  od: ["once daily"], bd: ["twice daily"], bid: ["twice daily"], tds: ["three times daily"], tid: ["three times daily"], qid: ["four times daily"],
  hs: ["at bedtime"], sos: ["as needed"], prn: ["as needed"], stat: ["immediately"],
  dm: ["diabetes mellitus"], t2dm: ["type 2 diabetes mellitus"], htn: ["hypertension"], cad: ["coronary artery disease"], ihd: ["ischaemic heart disease"],
  mi: ["myocardial infarction"], ckd: ["chronic kidney disease"], aki: ["acute kidney injury"], copd: ["chronic obstructive pulmonary disease"],
  cva: ["stroke"], tb: ["tuberculosis"], uti: ["urinary tract infection"], urti: ["upper respiratory tract infection"], lrti: ["lower respiratory tract infection"],
  cap: ["community acquired pneumonia"], sob: ["shortness of breath", "breathlessness"], ors: ["oral rehydration salts"], icu: ["intensive care unit"],
  opd: ["outpatient"], ipd: ["inpatient"], er: ["emergency"], ed: ["emergency department"], dvt: ["deep vein thrombosis"], pe: ["pulmonary embolism"],
};

const LONG_TO_SHORT = new Map<string, string[]>();
for (const [short, longs] of Object.entries(ABBREVIATIONS)) for (const l of longs) LONG_TO_SHORT.set(l, [...(LONG_TO_SHORT.get(l) ?? []), short]);

/** Extra words for a question: each abbreviation's long forms, each long form's abbreviation. Lower case, deduplicated, none already present. */
export function abbreviationTerms(question: string): string[] {
  const q = ` ${question.toLowerCase().replace(/[^\p{L}\p{N}\s-]+/gu, " ").replace(/\s+/g, " ").trim()} `;
  const words = new Set(q.trim().split(" "));
  const out = new Set<string>();
  for (const w of words) for (const l of ABBREVIATIONS[w] ?? []) for (const x of l.split(/[\s-]+/)) out.add(x);
  for (const [long, shorts] of LONG_TO_SHORT) if (q.includes(` ${long} `)) for (const s of shorts) out.add(s);
  return [...out].filter((x) => x.length > 1 && !words.has(x));
}
