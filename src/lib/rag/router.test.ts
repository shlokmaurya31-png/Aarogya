import { describe, expect, it } from "vitest";
import { extractPeriod, routeQuestion, type ReaderId, type RouteMode } from "./router";
import { mockIntentClassifier, settle } from "./intentModel";
import { issueAiPermit } from "@/lib/ai/record/permit";

/**
 * RAG Phase 3, step 3.2 — the router, table-driven (plan §5.1: at least 150
 * phrasings, the eleven languages for the structured intents; an unmatched
 * question gets the full hybrid plan). Non-English phrasings are the team's,
 * pending native-speaker review.
 */
type Want = { intent: string; readers?: ReaderId[]; analyte?: string; confidence?: string; ambiguous?: boolean };
const MEDS = new Set(["warfarin", "metformin", "amlodipine", "insulin", "paracetamol", "azithromycin"]);
const route = (q: string, mode: RouteMode = "CHART_QA") => routeQuestion(q, mode, { now: new Date("2026-11-23T00:00:00Z"), medicines: MEDS });

const CASES: [string, Want, RouteMode?][] = [
  // ── English: latest analyte ──
  ["What was the latest hemoglobin?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["Latest Hb?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["current haemoglobin", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["What is the serum creatinine result?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Creatinine" }],
  ["What was the TSH value?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "TSH" }],
  ["What was the potassium level?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Potassium" }],
  ["last sodium", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Sodium" }],
  ["most recent HbA1c", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "HbA1c" }],
  ["Her fasting sugar today?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Glucose" }],
  ["platelet count", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Platelets" }],
  ["What's the CRP?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "CRP" }],
  ["latest INR", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "INR" }],
  ["current WBC count", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "WBC" }],
  ["recent lactate", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Lactate" }],
  ["What was the vitamin D?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Vitamin D" }],
  ["Bilirubin now", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Bilirubin" }],
  ["latest urea", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Urea" }],
  ["SGPT value", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "ALT" }],
  ["latest cholesterol", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Cholesterol" }],
  ["ESR?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "ESR" }],
  // ── English: trend and period ──
  ["Hemoglobin trend", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_TREND"], analyte: "Hemoglobin" }],
  ["creatinine over time", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_TREND"], analyte: "Creatinine" }],
  ["previous potassium values", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_TREND"], analyte: "Potassium" }],
  ["all sugar results", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_TREND"], analyte: "Glucose" }],
  ["What was the hemoglobin in August 2026?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_TREND"], analyte: "Hemoglobin" }],
  ["TSH on 2026-09-20", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_TREND"], analyte: "TSH" }],
  ["HbA1c over the last 6 months", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_TREND"], analyte: "HbA1c" }],
  ["How has the sodium changed?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_TREND"], analyte: "Sodium" }],
  // ── English: vitals ──
  ["What was the latest SpO2 reading?", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["latest BP", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["current blood pressure", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["pulse rate now", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["heart rate?", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["temperature today", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["respiratory rate", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["oxygen saturation", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["latest vitals", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["NEWS2 score", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["BP trend", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["vital signs this morning", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  // ── English: orders, encounter, problems, allergies, medicines ──
  ["Any pending lab tests?", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["pending investigations", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["which scans are awaiting results", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["outstanding orders", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["Is the potassium still pending?", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["tests not yet resulted", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["Which bed is she in?", { intent: "STRUCTURED_LOOKUP", readers: ["ENCOUNTER_CURRENT"] }],
  ["When was she admitted?", { intent: "STRUCTURED_LOOKUP", readers: ["ENCOUNTER_CURRENT"] }],
  ["current encounter", { intent: "STRUCTURED_LOOKUP", readers: ["ENCOUNTER_CURRENT"] }],
  ["which ward", { intent: "STRUCTURED_LOOKUP", readers: ["ENCOUNTER_CURRENT"] }],
  ["What are her diagnoses?", { intent: "STRUCTURED_LOOKUP", readers: ["PROBLEMS"] }],
  ["problem list", { intent: "STRUCTURED_LOOKUP", readers: ["PROBLEMS"] }],
  ["known comorbidities", { intent: "STRUCTURED_LOOKUP", readers: ["PROBLEMS"] }],
  ["active conditions", { intent: "STRUCTURED_LOOKUP", readers: ["PROBLEMS"] }],
  ["Which drug allergies are recorded?", { intent: "STRUCTURED_LOOKUP", readers: ["ALLERGIES", "MEDICINES"] }],
  ["Is the patient allergic to anything?", { intent: "STRUCTURED_LOOKUP", readers: ["ALLERGIES"] }],
  ["allergies", { intent: "STRUCTURED_LOOKUP", readers: ["ALLERGIES"] }],
  ["Is she on warfarin?", { intent: "STRUCTURED_LOOKUP", readers: ["MEDICINES"] }],
  ["current medications", { intent: "STRUCTURED_LOOKUP", readers: ["MEDICINES"] }],
  ["what medicines is he taking", { intent: "STRUCTURED_LOOKUP", readers: ["MEDICINES"] }],
  ["metformin?", { intent: "STRUCTURED_LOOKUP", readers: ["MEDICINES"] }],
  ["latest BP and potassium", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST", "VITALS"], analyte: "Potassium" }],
  // ── English: mixed (a reader and passages) ──
  ["Does the creatinine on the patient's uploaded report agree with the hospital's?", { intent: "MIXED", readers: ["LAB_LATEST"], analyte: "Creatinine" }],
  ["Why was the potassium high?", { intent: "MIXED", readers: ["LAB_LATEST"] }],
  ["compare the hemoglobin with the outside report", { intent: "MIXED", readers: ["LAB_LATEST"] }],
  ["plan for her sugar", { intent: "MIXED", readers: ["LAB_LATEST"] }],
  // ── English: narrative (passages only) ──
  ["What did the chest X-ray show?", { intent: "NARRATIVE" }],
  ["Any history of tuberculosis?", { intent: "NARRATIVE" }],
  ["What did the discharge summary say?", { intent: "NARRATIVE" }],
  ["summary of the last note", { intent: "NARRATIVE" }],
  ["Was she referred to cardiology?", { intent: "NARRATIVE" }],
  ["any surgery in the past", { intent: "NARRATIVE" }],
  ["What was the impression on the ultrasound?", { intent: "NARRATIVE" }],
  // ── English: nothing matched, the full hybrid plan ──
  ["What is the blood group and Rh type?", { intent: "NARRATIVE", confidence: "DEFAULT" }],
  ["When was the last insulin injection?", { intent: "STRUCTURED_LOOKUP", readers: ["MEDICINES"] }],
  ["anything I should know?", { intent: "NARRATIVE", confidence: "DEFAULT" }],
  ["How is she doing?", { intent: "NARRATIVE", confidence: "DEFAULT" }],
  ["Smoking status", { intent: "NARRATIVE", confidence: "DEFAULT" }],
  ["family members", { intent: "NARRATIVE", confidence: "DEFAULT" }],
  ["vaccinations", { intent: "NARRATIVE", confidence: "DEFAULT" }],
  ["diet", { intent: "NARRATIVE", confidence: "DEFAULT" }],
  // ── ambiguous: a model may choose among the rules' candidates ──
  ["How many beds are free in her ward?", { intent: "AMBIGUOUS", ambiguous: true }],
  ["What does the sepsis protocol say about her lactate?", { intent: "AMBIGUOUS", ambiguous: true }],
  ["as per our policy, is her potassium too high?", { intent: "AMBIGUOUS", ambiguous: true }],
  // ── operational in a record mode ──
  ["How many beds are available?", { intent: "OPERATIONAL" }],
  ["bed occupancy today", { intent: "OPERATIONAL" }],
  ["Is ceftriaxone in stock?", { intent: "OPERATIONAL" }],
  ["queue length at OPD", { intent: "OPERATIONAL" }],
  // ── knowledge Q&A ──
  ["What is our hand hygiene policy?", { intent: "KNOWLEDGE" }, "KNOWLEDGE_QA"],
  ["sepsis protocol", { intent: "KNOWLEDGE" }, "KNOWLEDGE_QA"],
  ["How do we handle a needle-stick injury?", { intent: "KNOWLEDGE" }, "KNOWLEDGE_QA"],
  ["SOP for oxygen cylinders", { intent: "KNOWLEDGE" }, "KNOWLEDGE_QA"],
  ["guidelines for blood transfusion", { intent: "KNOWLEDGE" }, "KNOWLEDGE_QA"],
  ["formulary antibiotics", { intent: "KNOWLEDGE" }, "KNOWLEDGE_QA"],
  ["according to the hospital's protocol, when do we give the first antibiotic dose?", { intent: "KNOWLEDGE" }, "KNOWLEDGE_QA"],
  ["visiting hours", { intent: "KNOWLEDGE", confidence: "DEFAULT" }, "KNOWLEDGE_QA"],
  ["fire evacuation", { intent: "KNOWLEDGE", confidence: "DEFAULT" }, "KNOWLEDGE_QA"],
  ["रक्त आधान की नीति", { intent: "KNOWLEDGE" }, "KNOWLEDGE_QA"],
  ["संक्रमण नियंत्रण प्रोटोकॉल", { intent: "KNOWLEDGE" }, "KNOWLEDGE_QA"],
  ["கை சுகாதார கொள்கை", { intent: "KNOWLEDGE" }, "KNOWLEDGE_QA"],
  ["How many beds are free?", { intent: "OPERATIONAL" }, "KNOWLEDGE_QA"],
  ["stock of paracetamol", { intent: "OPERATIONAL" }, "KNOWLEDGE_QA"],
  ["what is the policy on bed occupancy?", { intent: "AMBIGUOUS", ambiguous: true }, "KNOWLEDGE_QA"],
  ["What is this patient's potassium?", { intent: "UNSUPPORTED" }, "KNOWLEDGE_QA"],
  // ── Hindi ──
  ["नवीनतम हीमोग्लोबिन क्या था?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["आखिरी शुगर कितनी थी?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Glucose" }],
  ["क्रिएटिनिन का रुझान", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_TREND"], analyte: "Creatinine" }],
  ["अभी का रक्तचाप", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["ऑक्सीजन कितनी है?", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["कौन सी जाँच लंबित हैं?", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["मरीज़ किस बिस्तर पर भर्ती है?", { intent: "STRUCTURED_LOOKUP", readers: ["ENCOUNTER_CURRENT"] }],
  ["निदान क्या है?", { intent: "STRUCTURED_LOOKUP", readers: ["PROBLEMS"] }],
  ["क्या कोई एलर्जी है?", { intent: "STRUCTURED_LOOKUP", readers: ["ALLERGIES"] }],
  // ── Marathi ──
  ["शेवटचा हिमोग्लोबिन किती होता?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["सध्याचा रक्तदाब", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["कोणत्या चाचणी प्रलंबित आहेत?", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["रुग्ण कधी दाखल झाला?", { intent: "STRUCTURED_LOOKUP", readers: ["ENCOUNTER_CURRENT"] }],
  // ── Bengali ──
  ["সর্বশেষ হিমোগ্লোবিন কত?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["এখনকার রক্তচাপ", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["কোন পরীক্ষা বাকি আছে?", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["কোন অ্যালার্জি আছে?", { intent: "STRUCTURED_LOOKUP", readers: ["ALLERGIES"] }],
  // ── Tamil ──
  ["சமீபத்திய ஹீமோகுளோபின் என்ன?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["தற்போதைய இரத்த அழுத்தம்", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["நிலுவையில் உள்ள சோதனைகள்", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["நோயாளி எந்த படுக்கையில் இருக்கிறார்?", { intent: "STRUCTURED_LOOKUP", readers: ["ENCOUNTER_CURRENT"] }],
  // ── Telugu ──
  ["తాజా హిమోగ్లోబిన్ ఎంత?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["ప్రస్తుత రక్తపోటు", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["పెండింగ్ పరీక్షలు", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["రోగనిర్ధారణ ఏమిటి?", { intent: "STRUCTURED_LOOKUP", readers: ["PROBLEMS"] }],
  // ── Kannada ──
  ["ಇತ್ತೀಚಿನ ಹಿಮೋಗ್ಲೋಬಿನ್ ಎಷ್ಟು?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["ಪ್ರಸ್ತುತ ರಕ್ತದೊತ್ತಡ", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["ಬಾಕಿ ಇರುವ ಪರೀಕ್ಷೆಗಳು", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["ಯಾವುದೇ ಅಲರ್ಜಿ ಇದೆಯೇ?", { intent: "STRUCTURED_LOOKUP", readers: ["ALLERGIES"] }],
  // ── Malayalam ──
  ["ഏറ്റവും പുതിയ ഹീമോഗ്ലോബിൻ എത്ര?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["ഇപ്പോഴത്തെ രക്തസമ്മർദ്ദം", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["ബാക്കി ടെസ്റ്റ് ഫലങ്ങൾ", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["രോഗനിർണയം എന്താണ്?", { intent: "STRUCTURED_LOOKUP", readers: ["PROBLEMS"] }],
  // ── Gujarati ──
  ["છેલ્લું હિમોગ્લોબિન કેટલું હતું?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["હાલનું બ્લડ પ્રેશર", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["કયા ટેસ્ટ બાકી છે?", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["દર્દી કઈ પથારી પર દાખલ છે?", { intent: "STRUCTURED_LOOKUP", readers: ["ENCOUNTER_CURRENT"] }],
  // ── Odia ──
  ["ସର୍ବଶେଷ ହିମୋଗ୍ଲୋବିନ କେତେ?", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["ବର୍ତ୍ତମାନ ରକ୍ତଚାପ", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["କେଉଁ ପରୀକ୍ଷା ବାକି ଅଛି?", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["ରୋଗୀ କେବେ ଭର୍ତ୍ତି ହେଲେ?", { intent: "STRUCTURED_LOOKUP", readers: ["ENCOUNTER_CURRENT"] }],
  // ── Urdu ──
  ["تازہ ہیموگلوبن کیا ہے؟", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Hemoglobin" }],
  ["موجودہ بلڈ پریشر", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["کون سے ٹیسٹ زیر التوا ہیں؟", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["کیا کوئی الرجی ہے؟", { intent: "STRUCTURED_LOOKUP", readers: ["ALLERGIES"] }],
  // ── more phrasings, each family ──
  ["show me the latest potassium please", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Potassium" }],
  ["K+ latest", { intent: "NARRATIVE", confidence: "DEFAULT" }],
  ["last glucose reading", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Glucose" }],
  ["RBS today", { intent: "STRUCTURED_LOOKUP", readers: ["LAB_LATEST"], analyte: "Glucose" }],
  ["latest temp", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["sats now", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["pain score", { intent: "STRUCTURED_LOOKUP", readers: ["VITALS"] }],
  ["any imaging pending", { intent: "STRUCTURED_LOOKUP", readers: ["ORDERS_PENDING"] }],
  ["ward and bed number", { intent: "STRUCTURED_LOOKUP", readers: ["ENCOUNTER_CURRENT"] }],
  ["list the diagnoses", { intent: "STRUCTURED_LOOKUP", readers: ["PROBLEMS"] }],
  ["drug allergy", { intent: "STRUCTURED_LOOKUP", readers: ["ALLERGIES", "MEDICINES"] }],
  ["Is she on amlodipine?", { intent: "STRUCTURED_LOOKUP", readers: ["MEDICINES"] }],
  ["What dose of insulin should I give?", { intent: "STRUCTURED_LOOKUP", readers: ["MEDICINES"] }],
];

describe("routeQuestion", () => {
  it("has at least 150 phrasings, with structured intents in all eleven languages", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(150);
    const scripts = [/\p{Script=Devanagari}/u, /\p{Script=Bengali}/u, /\p{Script=Tamil}/u, /\p{Script=Telugu}/u, /\p{Script=Kannada}/u, /\p{Script=Malayalam}/u, /\p{Script=Gujarati}/u, /\p{Script=Oriya}/u, /\p{Script=Arabic}/u];
    for (const re of scripts) expect(CASES.filter(([q, w]) => re.test(q) && w.intent === "STRUCTURED_LOOKUP").length).toBeGreaterThanOrEqual(4);
  });
  for (const [q, want, mode] of CASES) {
    it(`${mode ?? "CHART_QA"}: "${q}" → ${want.intent}${want.readers ? ` [${want.readers.join(", ")}]` : ""}`, () => {
      const r = route(q, mode);
      if (want.ambiguous) { expect(r.kind).toBe("AMBIGUOUS"); return; }
      expect(r.kind).toBe("PLAN");
      if (r.kind !== "PLAN") return;
      expect(r.plan.intent).toBe(want.intent);
      if (want.readers) expect([...r.plan.readers].sort()).toEqual([...want.readers].sort());
      if (want.analyte) expect(r.plan.entities.analyte).toBe(want.analyte);
      expect(r.plan.confidence).toBe(want.confidence ?? "RULE");
      // A structured lookup skips the vector and keyword search; everything else keeps the full hybrid search.
      if (r.plan.intent === "STRUCTURED_LOOKUP") expect(r.plan.semantic || r.plan.keyword).toBe(false);
      if (r.plan.intent === "NARRATIVE" || r.plan.intent === "MIXED" || r.plan.intent === "KNOWLEDGE") expect(r.plan.semantic && r.plan.keyword).toBe(true);
    });
  }

  it("an unmatched question gets the full hybrid plan with no reader", () => {
    const r = route("Tell me something");
    expect(r.kind === "PLAN" && r.plan.confidence === "DEFAULT" && r.plan.semantic && r.plan.keyword && r.plan.readers.length === 0).toBe(true);
  });
  it("a mode without a question keeps its whole-record retrieval", () => {
    const r = routeQuestion(undefined, "VISIT_BRIEF");
    expect(r.kind === "PLAN" && r.plan.semantic && r.plan.keyword && r.plan.readers.length === 0).toBe(true);
  });
  it("flags dosing questions as high risk", () => {
    const r = route("What dose of insulin should I give?");
    expect(r.kind === "PLAN" && r.plan.risk).toBe("HIGH_RISK");
  });
  it("reads periods", () => {
    expect(extractPeriod("in August 2026")).toEqual({ from: new Date("2026-08-01T00:00:00Z"), to: new Date(Date.UTC(2026, 8, 1) - 1) });
    expect(extractPeriod("on 2026-09-20")?.from).toEqual(new Date("2026-09-20T00:00:00Z"));
    expect(extractPeriod("over the last 2 weeks", new Date("2026-11-23T00:00:00Z"))?.from).toEqual(new Date("2026-11-09T00:00:00Z"));
    expect(extractPeriod("latest")).toBeUndefined();
  });
});

describe("the ambiguity classifier (mock)", () => {
  const permit = issueAiPermit("test", false);
  it("is used only for an ambiguous result and chooses only among the candidates", async () => {
    const r = route("How many beds are free in her ward?");
    expect(r.kind).toBe("AMBIGUOUS");
    const p = await settle(r, { question: "How many beds are free in her ward?", mode: "CHART_QA" }, permit);
    expect(p.confidence).toBe("MODEL");
    expect(r.kind === "AMBIGUOUS" && r.candidates.some((c) => c.intent === p.intent && c.readers.join() === p.readers.join())).toBe(true);
  });
  it("prefers what the mode can serve", async () => {
    const r = route("as per our policy, is her potassium too high?");
    expect((await settle(r, { question: "", mode: "CHART_QA" }, permit)).readers).toContain("LAB_LATEST");
    const k = route("what is the policy on bed occupancy?", "KNOWLEDGE_QA");
    expect((await settle(k, { question: "", mode: "KNOWLEDGE_QA" }, permit)).intent).toBe("KNOWLEDGE");
  });
  it("a plan the rules settled never reaches the classifier", async () => {
    const r = route("latest Hb");
    expect((await settle(r, { question: "latest Hb", mode: "CHART_QA" }, permit)).confidence).toBe("RULE");
  });
  it("never sees real data", async () => {
    await expect(mockIntentClassifier.choose({ question: "x", mode: "CHART_QA", candidates: [] }, issueAiPermit("t", true))).rejects.toThrow();
  });
});
