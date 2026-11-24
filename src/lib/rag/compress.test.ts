import { describe, expect, it } from "vitest";
import { compressSources, criticalFacts, lostFacts } from "./compress";
import { renderSource } from "./render";
import { KNOWLEDGE_DOCS } from "../../../eval/rag/knowledgeDocs";

/**
 * RAG Phase 4, step 4.2 — the property: every number, unit, date, medicine,
 * dose, route, frequency, allergy word, abnormal finding, negation,
 * uncertainty word and source number in a source survives compression.
 * Over rendered record sources, the knowledge fixture's documents and
 * generated passages (a seeded generator, so a failure reproduces).
 */
const at = new Date("2026-10-01T08:00:00Z");
function rendered() {
  const r = [
    renderSource({ sourceType: "LAB_RESULT", testName: "Hemoglobin", value: "11.2", unit: "g/dL", referenceRange: "12.0 - 15.5", flag: "LOW", critical: false, amended: false, at } as never),
    renderSource({ sourceType: "LAB_RESULT", testName: "Troponin I", value: "2.4", unit: "ng/mL", referenceRange: "0.00 - 0.04", flag: "HIGH", critical: true, amended: false, at } as never),
    renderSource({ sourceType: "ALLERGY", substance: "Penicillin", reaction: "urticarial rash", severity: "SEVERE", status: "ACTIVE", verification: "CONFIRMED", patientReported: false, at } as never),
    renderSource({ sourceType: "ALLERGY_STATUS", status: "NO_KNOWN_ALLERGIES", at } as never),
    renderSource({ sourceType: "OBSERVATION", day: at, rows: [{ at, hr: 112, sbp: 150, dbp: 94, rr: 22, spo2: 91, tempC: 38.4 }] } as never),
    renderSource({ sourceType: "IMAGING_REPORT", study: "Chest PA view", findings: "Homogeneous opacity in the right lower zone. No effusion.", impression: "Findings suggest right lower zone consolidation?", at, amended: false } as never),
    renderSource({ sourceType: "DIAGNOSIS", diagnosis: "Type 2 diabetes mellitus", code: "E11.9", type: "FINAL", status: "ACTIVE", at } as never),
  ];
  return r.map((x, i) => ({ n: i + 1, context: x.context, text: x.sections.map((s) => s.text).join("\n") }));
}

function* generated(seed = 7, n = 400) {
  let x = seed;
  const rnd = (k: number) => { x = (x * 1103515245 + 12345) % 2 ** 31; return x % k; };
  const pick = <T,>(xs: readonly T[]) => xs[rnd(xs.length)];
  const meds = ["Metformin", "Azithromycin", "Paracetamol", "Atorvastatin", "Salbutamol", "Insulin", "Amoxicillin"];
  const parts = [
    () => `${pick(meds)} ${rnd(900) + 1} ${pick(["mg", "mcg", "units", "mL"])} ${pick(["ORAL", "IV", "IM", "SC"])} ${pick(["BD", "OD", "TDS", "HS", "SOS", "every 6 hours"])}`,
    () => `${pick(["No", "Not", "Denies"])} ${pick(["fever", "chest pain", "known allergies", "vomiting"])}`,
    () => `${pick(["possible", "suspected", "likely"])} ${pick(["pneumonia", "UTI", "dengue"])}${pick(["", "?"])}`,
    () => `${pick(["Potassium", "Sodium", "Creatinine"])} ${rnd(10)}.${rnd(10)} ${pick(["mEq/L", "mg/dL", "mmol/L"])}, ${pick(["high", "low", "critical value"])}`,
    () => `recorded 2026-${String(rnd(12) + 1).padStart(2, "0")}-${String(rnd(28) + 1).padStart(2, "0")}`,
    () => `Allergic to ${pick(["sulfa", "penicillin", "NSAIDs"])}; contraindicated`,
    () => "दस्त होने पर हर पतले मल के बाद ओआरएस का घोल दें। खून आने पर तुरंत डॉक्टर को दिखाएँ, देर नहीं।",
    () => "Hospital Discharge Summary — Amrita Medical Centre",
  ];
  for (let i = 0; i < n; i++) {
    const lines = Array.from({ length: rnd(5) + 1 }, () => Array.from({ length: rnd(3) + 1 }, () => pick(parts)()).join(",  "));
    yield { n: i + 1, documentId: `doc-${rnd(5)}`, context: `[Clinical note · ${pick(["Progress note", "Hemoglobin"])} · 2026-10-0${rnd(9) + 1} · ${pick(["verified", "patient-provided"])}]`, text: `  ${lines.join("\n\n")}  ` };
  }
}

const sent = (s: { n: number; context: string; text: string }) => `[${s.n}] ${s.context}\n${s.text}`;

describe("deterministic compression keeps every critical fact", () => {
  it("over rendered record sources, the knowledge documents and 400 generated passages", () => {
    const knowledge = KNOWLEDGE_DOCS.flatMap((d, i) => (d.versions?.map((v) => v.body) ?? [d.body!]).map((body, j) => ({ n: i * 3 + j + 1, documentId: d.key, context: `[Reference · ${d.title} · version ${j + 1} · approved]`, text: body })));
    for (const set of [rendered(), knowledge, [...generated()]]) {
      const out = compressSources(set);
      expect(out).toHaveLength(set.length);
      for (let i = 0; i < set.length; i++) {
        expect(out[i].n).toBe(set[i].n);
        expect(lostFacts(sent(set[i]), sent(out[i])), sent(set[i])).toEqual([]);
      }
    }
  });

  it("shortens what it can: repeated metadata and whitespace", () => {
    const [hb] = rendered();
    const [c] = compressSources([hb]);
    expect(c.context).toBe("[Lab result · Hemoglobin · verified]");
    expect(sent(c).length).toBeLessThan(sent(hb).length);
    const ws = compressSources([{ n: 1, context: "[Note · x · verified]", text: "a   b\n\n\nc  " }])[0];
    expect(ws.text).toBe("a b\nc");
  });

  it("drops a repeated header only where it carries no fact, and never a repeated line that does", () => {
    const head = "Amrita Medical Centre — Discharge Summary";
    const dated = "Discharge Summary printed 2026-11-20";
    const out = compressSources([
      { n: 1, documentId: "d", context: "[Discharge summary · verified]", text: `${head}\nCourse uneventful` },
      { n: 2, documentId: "d", context: "[Discharge summary · verified]", text: `${head}\nAdvice: rest` },
      { n: 3, documentId: "d", context: "[Discharge summary · verified]", text: `${dated}\nReview in clinic` },
      { n: 4, documentId: "d", context: "[Discharge summary · verified]", text: `${dated}\nNo fever` },
    ]);
    expect(out[0].text).toContain(head);
    expect(out[1].text).not.toContain(head);
    expect(out[3].text).toContain(dated);
  });

  it("finds each kind of critical fact", () => {
    const f = criticalFacts("[2] Metformin 500 mg ORAL BD since 2026-09-20; no hypoglycaemia; possible UTI?; potassium 5.6 mEq/L high; allergic to penicillin");
    for (const k of ["sourceNo:[2]", "medicine:metformin", "number:500", "unit:mg", "route:oral", "frequency:bd", "date:2026-09-20", "negation:no", "uncertainty:possible", "uncertainty:?", "unit:meq/l", "abnormal:high", "allergy:allergic", "medicine:penicillin"]) expect(f, k).toContain(k);
  });
});
