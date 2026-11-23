/**
 * RAG Phase 3, step 3.8 — the evaluation's knowledge library (fixture
 * "rag-eval-v2"): synthetic hospital SOPs and policies, uploaded, ingested
 * and approved through the services like any document. Written by the team;
 * the clinical content and the Indic wording are PENDING CLINICAL ADVISOR
 * AND NATIVE-SPEAKER SIGN-OFF. No patient appears in any of them.
 *
 * One SOP per Indic language, each on a different topic, so a cross-script
 * or transliterated question has exactly one right document. Stale versions:
 * a superseded policy, an expired one and one approved for a future date.
 */
export interface EvalKnowledgeDoc {
  key: string; title: string; type: "SOP" | "POLICY" | "CLINICAL_REFERENCE" | "FORMULARY" | "ADMIN" | "EDUCATIONAL";
  accessClass: "ALL_STAFF" | "CLINICAL" | "PHARMACY" | "BILLING" | "ADMIN"; scope?: "FACILITY" | "ORGANIZATION"; language?: string;
  body?: string; versions?: { body: string }[]; state?: "EXPIRED" | "FUTURE";
}

export const KNOWLEDGE_DOCS: EvalKnowledgeDoc[] = [
  { key: "K_SEPSIS", title: "Sepsis bundle", type: "SOP", accessClass: "CLINICAL", body: "# Sepsis bundle\n\nGive the first antibiotic dose within 1 hour of recognising sepsis.\n\nTake blood cultures before the first antibiotic dose.\n\n## Fluids\n\nGive 30 mL/kg crystalloid for hypotension or a lactate of 4 mmol/L or more.\n" },
  { key: "K_HAND", title: "Hand hygiene", type: "POLICY", accessClass: "ALL_STAFF", body: "# Hand hygiene\n\nRub hands with alcohol hand rub for 20 to 30 seconds.\n\nWash hands with soap and water for 40 to 60 seconds when they are visibly soiled.\n\nPerform hand hygiene before and after every patient contact.\n" },
  { key: "K_NEEDLE", title: "Needle-stick injury", type: "SOP", accessClass: "ALL_STAFF", body: "# Needle-stick injury\n\nWash the wound with soap and running water and do not squeeze it.\n\nReport to the emergency department within 2 hours for post-exposure prophylaxis assessment.\n\nFill in the occupational exposure form the same day.\n" },
  { key: "K_TRANSFUSION", title: "Blood transfusion", type: "SOP", accessClass: "CLINICAL", body: "# Blood transfusion\n\nCheck the patient's identity and the blood unit at the bedside with two staff members.\n\nStart the transfusion within 30 minutes of the unit leaving the blood bank.\n\nRecord vital signs before the start, 15 minutes after the start, and at the end.\n" },
  { key: "K_PRESSURE", title: "Pressure injury prevention", type: "SOP", accessClass: "CLINICAL", body: "# Pressure injury prevention\n\nReposition bed-bound patients every 2 hours.\n\nScore pressure injury risk with the Braden scale on admission and daily.\n" },
  { key: "K_OXYGEN", title: "Oxygen cylinders", type: "SOP", accessClass: "ALL_STAFF", body: "# Oxygen cylinders\n\nCheck the cylinder gauge every shift and replace the cylinder below 500 psi.\n\nStore cylinders upright and chained to the wall.\n" },
  { key: "K_INSULIN", title: "Insulin storage", type: "FORMULARY", accessClass: "PHARMACY", body: "# Insulin storage\n\nStore unopened insulin in a refrigerator at 2 to 8 °C.\n\nAn opened insulin pen may be kept at room temperature for up to 28 days.\n" },
  { key: "K_FIRE", title: "Fire safety", type: "POLICY", accessClass: "ALL_STAFF", scope: "ORGANIZATION", body: "# Fire safety\n\nOn hearing the fire alarm follow RACE: rescue, alarm, contain, evacuate.\n\nNever use the lifts during a fire.\n" },
  { key: "K_DISCHARGE", title: "Discharge process", type: "SOP", accessClass: "CLINICAL", body: "# Discharge process\n\nGive the discharge summary to the patient before 11 am on the day of discharge.\n\nExplain every new medicine to the patient and a family member.\n" },
  { key: "K_ISOLATION", title: "Isolation precautions", type: "POLICY", accessClass: "CLINICAL", body: "# Isolation precautions\n\nPlace a patient with suspected tuberculosis in an airborne isolation room.\n\nStaff wear N95 respirators inside the room.\n" },
  { key: "K_BILLING", title: "Cashless claims", type: "ADMIN", accessClass: "BILLING", body: "# Cashless claims\n\nSend the pre-authorisation request within 24 hours of admission.\n" },
  // Stale: superseded (version 1 says every 4 hours), expired, and not yet in force.
  { key: "K_FALLS", title: "Falls prevention", type: "POLICY", accessClass: "CLINICAL", versions: [
    { body: "# Falls prevention\n\nAssess falls risk on admission and every 4 hours on the paper falls checklist.\n" },
    { body: "# Falls prevention\n\nAssess falls risk on admission and every shift using the Morse scale.\n\nKeep the bed at its lowest height with the brakes on.\n" },
  ] },
  { key: "K_VISITORS", title: "Visitor policy", type: "POLICY", accessClass: "ALL_STAFF", state: "EXPIRED", body: "# Visitor policy\n\nVisiting hours are 4 pm to 7 pm, two visitors per patient.\n" },
  { key: "K_STEWARDSHIP", title: "Antibiotic stewardship", type: "POLICY", accessClass: "CLINICAL", state: "FUTURE", body: "# Antibiotic stewardship\n\nMeropenem is released only with the infectious diseases team's approval.\n" },
  // One SOP per Indic language, each on its own topic (the cross-script and transliterated questions' only right answer).
  { key: "K_HI", title: "Diarrhoea care (Hindi)", type: "SOP", accessClass: "CLINICAL", language: "hi", body: "# दस्त की देखभाल\n\nदस्त होने पर हर पतले मल के बाद ओआरएस का घोल दें।\n\nदस्त के साथ खून आने पर तुरंत डॉक्टर को दिखाएँ।\n" },
  { key: "K_MR", title: "Fever care (Marathi)", type: "SOP", accessClass: "CLINICAL", language: "mr", body: "# तापाची काळजी\n\nताप आल्यास दर चार तासांनी तापमान मोजा.\n\nतापासाठी पॅरासिटामॉल डॉक्टरांच्या सल्ल्याने द्या.\n" },
  { key: "K_BN", title: "Cough care (Bengali)", type: "SOP", accessClass: "CLINICAL", language: "bn", body: "# কাশির যত্ন\n\nকাশি তিন সপ্তাহের বেশি থাকলে কফ পরীক্ষা করান।\n\nকাশির সময় মুখ রুমাল দিয়ে ঢাকুন।\n" },
  { key: "K_TA", title: "Jaundice care (Tamil)", type: "SOP", accessClass: "CLINICAL", language: "ta", body: "# மஞ்சள் காமாலை பராமரிப்பு\n\nமஞ்சள் காமாலை உள்ளவர்களுக்கு கல்லீரல் பரிசோதனை செய்யவும்.\n\nகொதிக்க வைத்த குடிநீர் மட்டும் கொடுக்கவும்.\n" },
  { key: "K_TE", title: "Anaemia care (Telugu)", type: "SOP", accessClass: "CLINICAL", language: "te", body: "# రక్తహీనత సంరక్షణ\n\nరక్తహీనత ఉన్నవారికి ఐరన్ మాత్రలు ఇవ్వండి.\n\nప్రతి నెల హిమోగ్లోబిన్ పరీక్ష చేయండి.\n" },
  { key: "K_KN", title: "Dengue care (Kannada)", type: "SOP", accessClass: "CLINICAL", language: "kn", body: "# ಡೆಂಗ್ಯೂ ಆರೈಕೆ\n\nಡೆಂಗ್ಯೂ ರೋಗಿಗಳ ಪ್ಲೇಟ್‌ಲೆಟ್ ಎಣಿಕೆಯನ್ನು ಪ್ರತಿದಿನ ಪರೀಕ್ಷಿಸಿ.\n\nಡೆಂಗ್ಯೂ ಜ್ವರದಲ್ಲಿ ಆಸ್ಪಿರಿನ್ ನೀಡಬೇಡಿ.\n" },
  { key: "K_ML", title: "Headache care (Malayalam)", type: "SOP", accessClass: "CLINICAL", language: "ml", body: "# തലവേദന പരിചരണം\n\nതലവേദനയുള്ള രോഗിയുടെ രക്തസമ്മർദ്ദം പരിശോധിക്കുക.\n\nപെട്ടെന്നുള്ള കഠിനമായ തലവേദനയാണെങ്കിൽ ഡോക്ടറെ ഉടൻ അറിയിക്കുക.\n" },
  { key: "K_GU", title: "Vomiting care (Gujarati)", type: "SOP", accessClass: "CLINICAL", language: "gu", body: "# ઉલટીની સંભાળ\n\nઉલટી થાય ત્યારે થોડું થોડું પાણી આપો.\n\nલોહીની ઉલટી થાય તો તરત ડૉક્ટરને જાણ કરો.\n" },
  { key: "K_OR", title: "Malaria care (Odia)", type: "SOP", accessClass: "CLINICAL", language: "or", body: "# ମ୍ୟାଲେରିଆ ଯତ୍ନ\n\nମ୍ୟାଲେରିଆ ସନ୍ଦେହ ହେଲେ ରକ୍ତ ପରୀକ୍ଷା କରନ୍ତୁ।\n\nମଶାରି ବ୍ୟବହାର କରିବାକୁ କୁହନ୍ତୁ।\n" },
  { key: "K_UR", title: "Typhoid care (Urdu)", type: "SOP", accessClass: "CLINICAL", language: "ur", body: "# ٹائیفائیڈ کی دیکھ بھال\n\nٹائیفائیڈ کے مریض کو ابلا ہوا پانی پلائیں۔\n\nٹائیفائیڈ کے شبہ میں خون کا کلچر کروائیں۔\n" },
];
