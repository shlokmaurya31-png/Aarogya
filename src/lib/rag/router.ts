import { contentWords } from "@/lib/ai/record/mock";
import { classesIn } from "./medicineClasses";

/**
 * RAG Phase 3, step 3.2 — the intent router (docs/RAG_ARCHITECTURE.md §5.2).
 * Deterministic rules over the question's words decide which retrieval
 * channels run. The vocabulary covers the app's eleven languages for the
 * structured intents; it was written by the engineering team and is PENDING
 * NATIVE-SPEAKER AND CLINICAL REVIEW.
 *
 *   RULE      a rule matched: a structured lookup ("latest haemoglobin"), a
 *             narrative question, knowledge, or an operational question
 *   DEFAULT   nothing matched: the full hybrid retrieval every question got
 *             before Phase 3. The router can only make a request cheaper or
 *             more exact, never less safe than that.
 *   AMBIGUOUS two families matched that the mode can't both serve (a bed in
 *             the chart and beds in the hospital; a protocol and this
 *             patient's value). Only then may a model choose, and only among
 *             the candidates the rules found (src/lib/rag/intentModel.ts).
 *
 * An extracted analyte, vital, medicine or period only narrows a reader's
 * query; nothing taken from the question widens the scope (§5.3).
 */
export type Intent = "STRUCTURED_LOOKUP" | "NARRATIVE" | "MIXED" | "KNOWLEDGE" | "OPERATIONAL" | "UNSUPPORTED";
export type ReaderId = "VITALS" | "LAB_LATEST" | "LAB_TREND" | "ORDERS_PENDING" | "ENCOUNTER_CURRENT" | "PROBLEMS" | "ALLERGIES" | "MEDICINES";
export type VitalKind = "BP" | "HR" | "SPO2" | "TEMP" | "RR" | "PAIN";
export type RouteMode = "VISIT_BRIEF" | "CHART_QA" | "NURSE_HANDOFF" | "EXPLAIN_REPORT" | "HEALTH_TIMELINE" | "PREVISIT_QUESTIONS" | "KNOWLEDGE_QA";

export interface RetrievalPlan {
  intent: Intent;
  entities: { analyte?: string; vitals?: VitalKind[]; medicine?: string; /** RAG Phase 5, step 3c: an ATC class or form the question names (medicineClasses.ts), when it names no medicine. */ medicineClass?: string; period?: { from?: Date; to?: Date }; latest: boolean; trend: boolean };
  readers: ReaderId[];
  semantic: boolean;
  keyword: boolean;
  risk: "LOW" | "CLINICAL" | "HIGH_RISK";
  confidence: "RULE" | "DEFAULT" | "MODEL";
  /** The rule families that matched, for the interaction record and the tests. */
  matched: string[];
}

export type RouteResult = { kind: "PLAN"; plan: RetrievalPlan } | { kind: "AMBIGUOUS"; candidates: RetrievalPlan[] };

// ── vocabulary (eleven languages; pending native-speaker and clinical review) ──

/** Canonical analyte → how a question may name it. The canonical name is matched against lab test names (English). */
export const ANALYTE_NAMES: Record<string, string[]> = {
  Hemoglobin: ["hemoglobin", "haemoglobin", "hb", "hgb", "हीमोग्लोबिन", "हिमोग्लोबिन", "হিমোগ্লোবিন", "ஹீமோகுளோபின்", "హిమోగ్లోబిన్", "ಹಿಮೋಗ್ಲೋಬಿನ್", "ഹീമോഗ്ലോബിൻ", "હિમોગ્લોબિન", "ହିମୋଗ୍ଲୋବିନ", "ہیموگلوبن"],
  HbA1c: ["hba1c", "a1c", "glycated", "glycosylated", "एचबीए1सी", "এইচবিএ১সি"],
  Glucose: ["glucose", "sugar", "fbs", "rbs", "ppbs", "शुगर", "शर्करा", "साखर", "সুগার", "শর্করা", "சர்க்கரை", "షుగర్", "చక్కెర", "ಸಕ್ಕರೆ", "ഷുഗർ", "പഞ്ചസാര", "સુગર", "ସୁଗାର", "شوگر"],
  Creatinine: ["creatinine", "क्रिएटिनिन", "ক্রিয়েটিনিন", "கிரியேட்டினின்", "క్రియాటినిన్", "ಕ್ರಿಯೇಟಿನಿನ್", "ക്രിയാറ്റിനിൻ", "ક્રિએટિનિન", "କ୍ରିଏଟିନିନ", "کریٹینین"],
  Potassium: ["potassium", "पोटैशियम", "पोटॅशियम", "পটাশিয়াম", "பொட்டாசியம்", "పొటాషియం", "ಪೊಟ್ಯಾಸಿಯಮ್", "പൊട്ടാസ്യം", "પોટેશિયમ", "ପୋଟାସିୟମ", "پوٹاشیم"],
  Sodium: ["sodium", "सोडियम", "সোডিয়াম", "சோடியம்", "సోడియం", "ಸೋಡಿಯಂ", "സോഡിയം", "સોડિયમ", "ସୋଡିୟମ", "سوڈیم"],
  TSH: ["tsh", "thyroid stimulating", "थायरॉइड", "थायराइड", "থাইরয়েড", "தைராய்டு", "థైరాయిడ్", "ಥೈರಾಯ್ಡ್", "തൈറോയ്ഡ്", "થાઇરોઇડ", "ଥାଇରଏଡ", "تھائیرائیڈ"],
  Platelets: ["platelet", "platelets", "प्लेटलेट", "प्लेटलेट्स", "প্লেটলেট", "தட்டணு", "ప్లేట్‌లెట్", "ಪ್ಲೇಟ್‌ಲೆಟ್", "പ്ലേറ്റ്‌ലെറ്റ്", "પ્લેટલેટ", "ପ୍ଲେଟଲେଟ", "پلیٹلیٹ"],
  WBC: ["wbc", "tlc", "white cell", "white cells", "leucocyte", "leukocyte"],
  CRP: ["crp", "c-reactive", "c reactive"],
  Cholesterol: ["cholesterol", "ldl", "hdl", "lipid", "कोलेस्ट्रॉल", "কোলেস্টেরল", "கொலஸ்ட்ரால்", "కొలెస్ట్రాల్", "ಕೊಲೆಸ್ಟ್ರಾಲ್", "കൊളസ്ട്രോൾ", "કોલેસ્ટ્રોલ", "କୋଲେଷ୍ଟ୍ରଲ", "کولیسٹرول"],
  Urea: ["urea", "bun"],
  Bilirubin: ["bilirubin", "बिलीरुबिन"],
  "Vitamin D": ["vitamin d", "vit d", "25-oh"],
  INR: ["inr", "prothrombin"],
  ESR: ["esr"],
  Calcium: ["calcium", "कैल्शियम"],
  Albumin: ["albumin"],
  ALT: ["alt", "sgpt"],
  AST: ["ast", "sgot"],
  "Uric acid": ["uric acid"],
  Lactate: ["lactate", "lactic acid"],
};

/** Test-name patterns per canonical analyte (lower case, matched as whole words in the lab test's name). */
export const ANALYTE_TEST_NAMES: Record<string, string[]> = {
  Hemoglobin: ["hemoglobin", "haemoglobin", "hb", "hgb"], HbA1c: ["hba1c", "glycated hemoglobin", "glycated haemoglobin", "a1c"],
  Glucose: ["glucose", "blood sugar", "fbs", "rbs", "ppbs"], Creatinine: ["creatinine"], Potassium: ["potassium"], Sodium: ["sodium"], TSH: ["tsh"],
  Platelets: ["platelet", "platelets", "platelet count"], WBC: ["wbc", "tlc", "white blood cell", "total leucocyte count", "total leukocyte count"], CRP: ["crp", "c-reactive protein"],
  Cholesterol: ["cholesterol", "ldl", "hdl", "lipid profile"], Urea: ["urea", "bun"], Bilirubin: ["bilirubin"], "Vitamin D": ["vitamin d", "25-oh vitamin d"],
  INR: ["inr", "prothrombin time"], ESR: ["esr"], Calcium: ["calcium"], Albumin: ["albumin"], ALT: ["alt", "sgpt"], AST: ["ast", "sgot"], "Uric acid": ["uric acid"], Lactate: ["lactate"],
};

const VITAL_NAMES: Record<VitalKind, string[]> = {
  BP: ["bp", "blood pressure", "pressure", "systolic", "diastolic", "रक्तचाप", "बीपी", "ब्लड प्रेशर", "रक्तदाब", "রক্তচাপ", "বিপি", "இரத்த அழுத்தம்", "ரத்த அழுத்தம்", "రక్తపోటు", "బీపీ", "ರಕ್ತದೊತ್ತಡ", "ಬಿಪಿ", "രക്തസമ്മർദ്ദം", "ബിപി", "બ્લડ પ્રેશર", "બીપી", "રક્તદાબ", "ରକ୍ତଚାପ", "ବିପି", "بلڈ پریشر", "بی پی"],
  HR: ["pulse", "heart rate", "hr", "नाड़ी", "नब्ज़", "पल्स", "नाडी", "নাড়ি", "পালস", "நாடித்துடிப்பு", "நாடி", "నాడి", "పల్స్", "ನಾಡಿ", "ಪಲ್ಸ್", "നാഡി", "പൾസ്", "નાડી", "પલ્સ", "ନାଡ଼ି", "ନାଡି", "نبض"],
  SPO2: ["spo2", "sp02", "saturation", "sats", "oxygen", "o2 sat", "ऑक्सीजन", "অক্সিজেন", "ஆக்சிஜன்", "ஆக்ஸிஜன்", "ఆక్సిజన్", "ಆಮ್ಲಜನಕ", "ಆಕ್ಸಿಜನ್", "ഓക്സിജൻ", "ઓક્સિજન", "ଅମ୍ଳଜାନ", "ଅକ୍ସିଜେନ", "آکسیجن"],
  TEMP: ["temperature", "temp", "तापमान", "তাপমাত্রা", "வெப்பநிலை", "ఉష్ణోగ్రత", "ತಾಪಮಾನ", "താപനില", "તાપમાન", "ତାପମାତ୍ରା", "درجہ حرارت"],
  RR: ["respiratory rate", "breathing rate", "resp rate", "rr", "श्वसन दर", "শ্বাসের হার", "சுவாச விகிதம்", "శ్వాస రేటు", "ಉಸಿರಾಟದ ದರ", "ശ്വസന നിരക്ക്", "શ્વાસ દર", "ଶ୍ୱାସ ହାର", "سانس کی رفتار"],
  PAIN: ["pain score", "pain scale"],
  // The NEWS2 score isn't routed to a reader: it awaits clinical sign-off and the AI doesn't read it.
};
const VITALS_GENERIC = ["vitals", "vital signs", "obs", "observations", "वाइटल्स", "जीवन संकेत", "ভাইটালস", "முக்கிய அறிகுறிகள்", "వైటల్స్", "ವೈಟಲ್ಸ್", "വൈറ്റൽസ്", "વાઇટલ્સ", "ଭାଇଟାଲ", "وائٹلز"];

const LATEST = ["latest", "last", "current", "recent", "newest", "today", "now", "most recent", "नवीनतम", "ताज़ा", "ताजा", "आखिरी", "अंतिम", "अभी", "शेवटचा", "शेवटची", "शेवटचे", "सध्याचा", "सध्याची", "সর্বশেষ", "শেষ", "এখনকার", "சமீபத்திய", "கடைசி", "தற்போதைய", "తాజా", "చివరి", "ప్రస్తుత", "ಇತ್ತೀಚಿನ", "ಕೊನೆಯ", "ಪ್ರಸ್ತುತ", "ഏറ്റവും പുതിയ", "അവസാന", "ഇപ്പോഴത്തെ", "તાજેતરનું", "તાજેતરનો", "છેલ્લું", "છેલ્લો", "છેલ્લી", "હાલનું", "ସର୍ବଶେଷ", "ଶେଷ", "ବର୍ତ୍ତମାନ", "تازہ", "آخری", "موجودہ"];
const TREND = ["trend", "trends", "all", "over time", "previous", "all values", "all results", "serial", "series", "history of values", "changed", "change in", "over the last", "रुझान", "पिछले", "सभी", "मागील", "সব", "আগের", "প্রবণতা", "முந்தைய", "அனைத்து", "போக்கு", "మునుపటి", "అన్ని", "ధోరణి", "ಹಿಂದಿನ", "ಎಲ್ಲಾ", "ಪ್ರವೃತ್ತಿ", "മുൻ", "എല്ലാ", "പ്രവണത", "અગાઉના", "બધા", "વલણ", "ପୂର୍ବ", "ସମସ୍ତ", "ଧାରା", "پچھلے", "تمام", "رجحان"];
const PENDING = ["pending", "awaiting", "outstanding", "not yet done", "yet to be done", "not yet resulted", "not resulted", "yet to come", "still waiting", "लंबित", "बाकी", "प्रलंबित", "बाकी आहे", "অপেক্ষমাণ", "বাকি", "நிலுவையில்", "நிலுவை", "పెండింగ్", "బాకీ", "ಬಾಕಿ", "ಬಾಕಿ ಇರುವ", "തീർപ്പാക്കാത്ത", "ബാക്കി", "બાકી", "બાકી રહેલા", "ବାକି", "ଅପେକ୍ଷାରତ", "زیر التوا", "باقی"];
const ORDER_WORDS = ["test", "tests", "investigation", "investigations", "order", "orders", "lab", "labs", "scan", "scans", "imaging", "x-ray", "xray", "report", "reports", "result", "results", "जाँच", "जांच", "टेस्ट", "चाचणी", "পরীক্ষা", "சோதனை", "சோதனைகள்", "పరీక్ష", "పరీక్షలు", "ಪರೀಕ್ಷೆ", "ಪರೀಕ್ಷೆಗಳು", "പരിശോധന", "ടെസ്റ്റ്", "તપાસ", "ટેસ્ટ", "ପରୀକ୍ଷା", "ٹیسٹ", "جانچ"];
const ENCOUNTER = ["admitted", "admission", "which bed", "her bed", "his bed", "bed number", "ward", "current encounter", "current visit", "this visit", "this admission", "length of stay", "भर्ती", "बिस्तर", "बेड", "वार्ड", "दाखल", "खाट", "ভর্তি", "শয্যা", "বেড", "அனுமதி", "படுக்கை", "వార్డు", "అడ్మిట్", "పడక", "ದಾಖಲು", "ಹಾಸಿಗೆ", "ವಾರ್ಡ್", "അഡ്മിറ്റ്", "കിടക്ക", "വാർഡ്", "દાખલ", "પથારી", "વોર્ડ", "ଭର୍ତ୍ତି", "ଶଯ୍ୟା", "ୱାର୍ଡ", "داخل", "بستر", "وارڈ"];
const PROBLEMS = ["diagnosis", "diagnoses", "problem list", "problems", "conditions", "comorbidities", "co-morbidities", "known case", "निदान", "बीमारियाँ", "बीमारी", "आजार", "রোগনির্ণয়", "நோயறிதல்", "நோய்கள்", "రోగనిర్ధారణ", "వ్యాధులు", "ರೋಗನಿರ್ಣಯ", "ಕಾಯಿಲೆಗಳು", "രോഗനിർണയം", "രോഗങ്ങൾ", "નિદાન", "બીમારીઓ", "ରୋଗ ନିର୍ଣ୍ଣୟ", "تشخیص", "بیماریاں"];
const ALLERGY = ["allergy", "allergies", "allergic", "एलर्जी", "অ্যালার্জি", "ஒவ்வாமை", "అలెర్జీ", "ಅಲರ್ಜಿ", "അലർജി", "એલર્જી", "ଆଲର୍ଜି", "الرجی"];
const MEDICINE = ["medicine", "medicines", "medication", "medications", "drug", "drugs", "tablet", "tablets", "on any", "दवा", "दवाई", "दवाएँ", "औषध", "ওষুধ", "மருந்து", "மருந்துகள்", "మందు", "మందులు", "ಔಷಧ", "ಔಷಧಿ", "മരുന്ന്", "દવા", "ଔଷଧ", "دوا", "ادویات"];
const KNOWLEDGE = ["policy", "policies", "protocol", "protocols", "sop", "sops", "guideline", "guidelines", "procedure for", "how do we", "how should we", "what is our", "formulary", "according to", "as per", "नीति", "प्रोटोकॉल", "दिशानिर्देश", "धोरण", "নীতি", "প্রোটোকল", "கொள்கை", "நெறிமுறை", "విధానం", "ప్రోటోకాల్", "ನೀತಿ", "ಶಿಷ್ಟಾಚಾರ", "നയം", "പ്രോട്ടോക്കോൾ", "નીતિ", "પ્રોટોકોલ", "ନୀତି", "ପ୍ରୋଟୋକଲ", "پالیسی", "پروٹوکول"];
const OPERATIONAL = ["how many beds", "beds are free", "beds are available", "beds free", "beds available", "bed availability", "free beds", "available beds", "occupancy", "queue", "waiting list", "how many patients", "stock", "in stock", "inventory", "census", "discharges today", "admissions today", "bed occupancy", "खाली बिस्तर", "कतार", "स्टॉक", "রিক্ত শয্যা", "স্টক", "காலியான படுக்கைகள்", "ఖాళీ పడకలు", "ಖಾಲಿ ಹಾಸಿಗೆಗಳು", "ഒഴിവുള്ള കിടക്കകൾ", "ખાલી પથારી", "ଖାଲି ଶଯ୍ୟା", "خالی بستر"];
/**
 * RAG Phase 5, step 3b: a question about the hospital's supplies ("oxygen cylinders in stock", "ventilators free") is
 * operational even when it names a vital or a medicine ("oxygen", "ceftriaxone"): the patient's chart has no stock.
 */
const SUPPLY = ["stock", "in stock", "inventory", "cylinder", "cylinders", "ventilators free", "ventilators available", "free ventilators", "any ventilators", "ventilator availability", "units in the blood bank", "supply of", "supplies", "स्टॉक", "সিলিন্ডার", "স্টক"];
const NARRATIVE = ["upload", "uploaded", "outside report", "note", "notes", "discharge summary", "summary", "plan", "why", "reason", "compare", "agree", "agrees", "differ", "differs", "disagree", "told", "said", "advice", "impression", "findings", "x-ray show", "ct show", "mri", "ultrasound", "referral", "referred", "consultation", "specialist opinion", "radiology", "scan show", "panic", "history of", "any history", "procedure", "surgery", "operation"];
const HIGH_RISK = ["dose", "dosage", "how much", "should i give", "should we give", "can i give", "increase", "decrease", "stop", "start", "double", "मात्रा", "खुराक", "कितना दें", "ডোজ", "அளவு", "మోతాదు", "ಡೋಸ್", "ഡോസ്", "ડોઝ", "ମାତ୍ରା", "خوراک"];

const MONTHS: Record<string, number> = { january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11 };

// ── matching ──

const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}‌‍+]+/gu, " ").replace(/\s+/g, " ").trim()} `;
/** A phrase as whole words (Latin), or as a word start (Indic scripts inflect at the end: "रक्तदाबासाठी"). */
function has(q: string, phrase: string): boolean {
  const p = norm(phrase).trim();
  if (!p) return false;
  if (/^[\p{Script=Latin}\p{N}\s+-]+$/u.test(p)) return q.includes(` ${p} `);
  return q.includes(` ${p}`);
}
const anyOf = (q: string, xs: readonly string[]) => xs.filter((x) => has(q, x));

/** The period a question names, if any: a month and year, an ISO day, or "last N days/weeks/months". */
export function extractPeriod(question: string, now = new Date()): { from?: Date; to?: Date } | undefined {
  const q = question.toLowerCase();
  const iso = q.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) { const d = new Date(`${iso[0]}T00:00:00Z`); return { from: d, to: new Date(d.getTime() + 86_400_000 - 1) }; }
  const my = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?\s+(20\d{2})\b/);
  if (my) { const m = MONTHS[my[1]], y = Number(my[2]); return { from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 1, 1) - 1) }; }
  const year = q.match(/\b(?:in|during|for|of)\s+(20\d{2})\b/);
  if (year) { const y = Number(year[1]); return { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1) - 1) }; }
  const lastN = q.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+(day|days|week|weeks|month|months)\b/);
  if (lastN) { const n = Number(lastN[1]), unit = lastN[2].startsWith("day") ? 1 : lastN[2].startsWith("week") ? 7 : 30; return { from: new Date(now.getTime() - n * unit * 86_400_000), to: now }; }
  if (/\byesterday\b/.test(q)) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)); return { from: d, to: new Date(d.getTime() + 86_400_000 - 1) }; }
  return undefined;
}

const plan = (p: Partial<RetrievalPlan> & Pick<RetrievalPlan, "intent">, base: Pick<RetrievalPlan, "entities" | "risk" | "matched">): RetrievalPlan => ({
  readers: [], semantic: true, keyword: true, confidence: "RULE", ...base, ...p,
});

/**
 * The plan for one question in one mode. Pure. `medicines` is the medicine
 * dictionary (lower case) for the medicine entity; without it a medicine is
 * found only by the generic words.
 */
export function routeQuestion(question: string | undefined, mode: RouteMode, opts: { now?: Date; medicines?: ReadonlySet<string> } = {}): RouteResult {
  const empty: RetrievalPlan["entities"] = { latest: false, trend: false };
  // A mode without a free question (the brief, the handoff, the timeline, pre-visit) keeps its whole-record retrieval.
  if (!question?.trim()) return { kind: "PLAN", plan: { intent: "NARRATIVE", entities: empty, readers: [], semantic: true, keyword: true, risk: "CLINICAL", confidence: "DEFAULT", matched: [] } };
  const q = norm(question);
  const matched: string[] = [];
  const analyte = Object.entries(ANALYTE_NAMES).find(([, names]) => anyOf(q, names).length)?.[0];
  const vitals = (Object.entries(VITAL_NAMES) as [VitalKind, string[]][]).filter(([, names]) => anyOf(q, names).length).map(([k]) => k);
  const vitalsGeneric = anyOf(q, VITALS_GENERIC).length > 0;
  const latest = anyOf(q, LATEST).length > 0;
  const trend = anyOf(q, TREND).length > 0;
  const period = extractPeriod(question, opts.now);
  const pending = anyOf(q, PENDING).length > 0;
  const orderWords = anyOf(q, ORDER_WORDS).length > 0;
  const encounter = anyOf(q, ENCOUNTER).length > 0;
  const problems = anyOf(q, PROBLEMS).length > 0;
  const allergy = anyOf(q, ALLERGY).length > 0;
  const words = contentWords(question);
  const medicine = opts.medicines ? words.find((w) => opts.medicines!.has(w)) : undefined;
  const medicineClass = medicine ? undefined : classesIn(question)[0]?.id;
  const medicineWords = anyOf(q, MEDICINE).length > 0 || !!medicine || !!medicineClass;
  const knowledge = anyOf(q, KNOWLEDGE).length > 0;
  const supply = anyOf(q, SUPPLY).length > 0;
  const operational = anyOf(q, OPERATIONAL).length > 0;
  const narrative = anyOf(q, NARRATIVE).length > 0;
  const risk: RetrievalPlan["risk"] = anyOf(q, HIGH_RISK).length ? "HIGH_RISK" : knowledge || operational ? "LOW" : "CLINICAL";
  const entities: RetrievalPlan["entities"] = { ...(analyte ? { analyte } : {}), ...(vitals.length ? { vitals } : {}), ...(medicine ? { medicine } : {}), ...(medicineClass ? { medicineClass } : {}), ...(period ? { period } : {}), latest, trend };
  const base = { entities, risk, matched };

  // Structured readers the question asks for.
  const readers: ReaderId[] = [];
  // "Pending potassium" is an order, not a value.
  if (pending && (orderWords || analyte)) { readers.push("ORDERS_PENDING"); matched.push("pending"); }
  else {
    if (analyte) { readers.push(trend || (period && !latest) ? "LAB_TREND" : "LAB_LATEST"); matched.push(`analyte:${analyte}`); }
    if (vitals.length || vitalsGeneric) { readers.push("VITALS"); matched.push("vitals"); }
  }
  if (encounter && !operational) { readers.push("ENCOUNTER_CURRENT"); matched.push("encounter"); }
  if (problems) { readers.push("PROBLEMS"); matched.push("problems"); }
  if (allergy) { readers.push("ALLERGIES"); matched.push("allergies"); }
  if (medicineWords && !analyte) { readers.push("MEDICINES"); matched.push("medicines"); }
  if (knowledge) matched.push("knowledge");
  if (operational) matched.push("operational");
  if (narrative) matched.push("narrative");

  const structured = readers.length > 0;
  const patientPlan = (): RetrievalPlan => structured
    // A narrative cue beside a reader ("does the uploaded creatinine agree…") needs the passages too.
    ? plan({ intent: narrative ? "MIXED" : "STRUCTURED_LOOKUP", readers, semantic: narrative, keyword: narrative }, base)
    : plan({ intent: "NARRATIVE" }, base);
  const knowledgePlan = () => plan({ intent: "KNOWLEDGE" }, base);
  const opsPlan = () => plan({ intent: "OPERATIONAL", semantic: false, keyword: false }, base);

  if (mode === "KNOWLEDGE_QA") {
    // Knowledge Q&A has no patient: a patient value can't be read here. Operational questions aren't answered yet.
    if (operational && knowledge) return { kind: "AMBIGUOUS", candidates: [knowledgePlan(), opsPlan()] };
    if (operational) return { kind: "PLAN", plan: opsPlan() };
    if (structured && !knowledge && (analyte || vitals.length) && /\b(her|his|this patient|the patient's|patient's)\b/i.test(question)) return { kind: "PLAN", plan: plan({ intent: "UNSUPPORTED", semantic: false, keyword: false }, base) };
    return { kind: "PLAN", plan: knowledge ? knowledgePlan() : { ...knowledgePlan(), confidence: "DEFAULT" } };
  }
  // A record mode. A supply question is about the hospital, never the patient's value.
  if (supply) return { kind: "PLAN", plan: opsPlan() };
  if (operational && encounter) return { kind: "AMBIGUOUS", candidates: [patientPlan(), opsPlan()] };
  if (operational && !structured) return { kind: "PLAN", plan: opsPlan() };
  if (knowledge && structured) return { kind: "AMBIGUOUS", candidates: [patientPlan(), knowledgePlan()] };
  if (structured || narrative) return { kind: "PLAN", plan: patientPlan() };
  // Nothing matched: the full hybrid plan.
  return { kind: "PLAN", plan: plan({ intent: "NARRATIVE", confidence: "DEFAULT" }, base) };
}
