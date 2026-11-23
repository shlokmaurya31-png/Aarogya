/**
 * RAG Phase 1, step 1.9 — the Indic retrieval benchmark's data (ADR 0005 part
 * A). Synthetic clinical lines, no patient: four conditions, each with its
 * usual medicine and a dose, in the app's eleven languages.
 *
 * STATUS: written by the engineering team, not yet reviewed by a native
 * speaker of each language or by a clinician. The words are common ones
 * (and medicine names written phonetically, as Indian prescriptions and
 * leaflets do), but a reviewer may well change some of them. Results are
 * about this set only.
 *
 * Per Indic language and condition:
 *   doc        how a record might say it: the condition word INFLECTED where
 *              the language inflects (Marathi "मधुमेहासाठी"), the medicine in
 *              the script, the dose in digits
 *   base       the condition word as someone would type it in a search
 *   translit   that word typed in Latin letters (as on a phone keyboard)
 *   medicine   the medicine as written in the script
 * Hindi and Urdu mark case with separate postpositions, so their base and
 * inflected forms are the same word: no INFLECTED query is made for them.
 */
export const LANGUAGES = ["en", "hi", "bn", "mr", "te", "ta", "gu", "ur", "kn", "or", "ml"] as const;
export type Lang = (typeof LANGUAGES)[number];
export type Topic = "diabetes" | "hypertension" | "asthma" | "fever";
export const TOPICS: readonly Topic[] = ["diabetes", "hypertension", "asthma", "fever"];

/** The medicine and dose for each condition; the English (INN) name is how a doctor types it. */
export const MEDICINE: Record<Topic, { inn: string; dose: string }> = {
  diabetes: { inn: "metformin", dose: "500 mg" },
  hypertension: { inn: "amlodipine", dose: "5 mg" },
  asthma: { inn: "salbutamol", dose: "100 mcg" },
  fever: { inn: "paracetamol", dose: "650 mg" },
};

export const ENGLISH: Record<Topic, { doc: string; query: string }> = {
  diabetes: { doc: "Type 2 diabetes mellitus. Started metformin 500 mg twice daily.", query: "diabetes" },
  hypertension: { doc: "Hypertension, blood pressure high on two visits. Amlodipine 5 mg once daily.", query: "hypertension" },
  asthma: { doc: "Bronchial asthma with wheeze. Salbutamol inhaler 100 mcg as needed.", query: "asthma" },
  fever: { doc: "Fever for three days. Paracetamol 650 mg every six hours.", query: "fever" },
};

interface Term { base: string; inflected: string; translit: string; medicine: string }

export const INDIC: Record<Exclude<Lang, "en">, Record<Topic, Term>> = {
  hi: {
    diabetes: { base: "मधुमेह", inflected: "मधुमेह", translit: "madhumeh", medicine: "मेटफॉर्मिन" },
    hypertension: { base: "रक्तचाप", inflected: "रक्तचाप", translit: "raktchap", medicine: "एम्लोडिपिन" },
    asthma: { base: "दमा", inflected: "दमा", translit: "dama", medicine: "सालबुटामोल" },
    fever: { base: "बुखार", inflected: "बुखार", translit: "bukhar", medicine: "पैरासिटामोल" },
  },
  mr: {
    diabetes: { base: "मधुमेह", inflected: "मधुमेहासाठी", translit: "madhumeh", medicine: "मेटफॉर्मिन" },
    hypertension: { base: "रक्तदाब", inflected: "रक्तदाबासाठी", translit: "raktadab", medicine: "अॅम्लोडिपिन" },
    asthma: { base: "दमा", inflected: "दम्यासाठी", translit: "dama", medicine: "सालबुटामॉल" },
    fever: { base: "ताप", inflected: "तापासाठी", translit: "tap", medicine: "पॅरासिटामॉल" },
  },
  bn: {
    diabetes: { base: "ডায়াবেটিস", inflected: "ডায়াবেটিসের", translit: "diabetis", medicine: "মেটফরমিন" },
    hypertension: { base: "রক্তচাপ", inflected: "রক্তচাপের", translit: "roktochap", medicine: "অ্যামলোডিপিন" },
    asthma: { base: "হাঁপানি", inflected: "হাঁপানির", translit: "hanpani", medicine: "সালবুটামল" },
    fever: { base: "জ্বর", inflected: "জ্বরের", translit: "jor", medicine: "প্যারাসিটামল" },
  },
  gu: {
    diabetes: { base: "ડાયાબિટીસ", inflected: "ડાયાબિટીસની", translit: "diabitis", medicine: "મેટફોર્મિન" },
    hypertension: { base: "રક્તચાપ", inflected: "રક્તચાપની", translit: "raktachap", medicine: "એમ્લોડિપિન" },
    asthma: { base: "દમ", inflected: "દમની", translit: "dam", medicine: "સાલ્બુટામોલ" },
    fever: { base: "તાવ", inflected: "તાવની", translit: "tav", medicine: "પેરાસીટામોલ" },
  },
  te: {
    diabetes: { base: "మధుమేహం", inflected: "మధుమేహానికి", translit: "madhumeham", medicine: "మెట్‌ఫార్మిన్" },
    hypertension: { base: "రక్తపోటు", inflected: "రక్తపోటుకు", translit: "raktapotu", medicine: "అమ్లోడిపిన్" },
    asthma: { base: "ఉబ్బసం", inflected: "ఉబ్బసానికి", translit: "ubbasam", medicine: "సాల్బుటమాల్" },
    fever: { base: "జ్వరం", inflected: "జ్వరానికి", translit: "jwaram", medicine: "పారాసెటమాల్" },
  },
  ta: {
    diabetes: { base: "நீரிழிவு", inflected: "நீரிழிவுக்கு", translit: "neerizhivu", medicine: "மெட்ஃபார்மின்" },
    hypertension: { base: "அழுத்தம்", inflected: "அழுத்தத்திற்கு", translit: "azhutham", medicine: "அம்லோடிபின்" },
    asthma: { base: "ஆஸ்துமா", inflected: "ஆஸ்துமாவுக்கு", translit: "asthuma", medicine: "சால்பியூட்டமால்" },
    fever: { base: "காய்ச்சல்", inflected: "காய்ச்சலுக்கு", translit: "kaichal", medicine: "பாராசிட்டமால்" },
  },
  kn: {
    diabetes: { base: "ಮಧುಮೇಹ", inflected: "ಮಧುಮೇಹಕ್ಕೆ", translit: "madhumeha", medicine: "ಮೆಟ್‌ಫಾರ್ಮಿನ್" },
    hypertension: { base: "ರಕ್ತದೊತ್ತಡ", inflected: "ರಕ್ತದೊತ್ತಡಕ್ಕೆ", translit: "raktadottada", medicine: "ಅಮ್ಲೋಡಿಪಿನ್" },
    asthma: { base: "ಅಸ್ತಮಾ", inflected: "ಅಸ್ತಮಾಕ್ಕೆ", translit: "asthama", medicine: "ಸಾಲ್ಬುಟಮಾಲ್" },
    fever: { base: "ಜ್ವರ", inflected: "ಜ್ವರಕ್ಕೆ", translit: "jwara", medicine: "ಪ್ಯಾರಸಿಟಮಾಲ್" },
  },
  ml: {
    diabetes: { base: "പ്രമേഹം", inflected: "പ്രമേഹത്തിന്", translit: "prameham", medicine: "മെറ്റ്ഫോർമിൻ" },
    hypertension: { base: "രക്തസമ്മർദ്ദം", inflected: "രക്തസമ്മർദ്ദത്തിന്", translit: "rakthasammardam", medicine: "അംലോഡിപിൻ" },
    asthma: { base: "ആസ്ത്മ", inflected: "ആസ്ത്മയ്ക്ക്", translit: "aasthma", medicine: "സാൽബ്യൂട്ടമോൾ" },
    fever: { base: "പനി", inflected: "പനിക്ക്", translit: "pani", medicine: "പാരസെറ്റമോൾ" },
  },
  or: {
    diabetes: { base: "ମଧୁମେହ", inflected: "ମଧୁମେହର", translit: "madhumeha", medicine: "ମେଟଫର୍ମିନ" },
    hypertension: { base: "ରକ୍ତଚାପ", inflected: "ରକ୍ତଚାପର", translit: "raktachapa", medicine: "ଆମ୍ଲୋଡିପିନ" },
    asthma: { base: "ଆଜମା", inflected: "ଆଜମାର", translit: "ajama", medicine: "ସାଲବୁଟାମୋଲ" },
    fever: { base: "ଜ୍ୱର", inflected: "ଜ୍ୱରର", translit: "jwara", medicine: "ପାରାସିଟାମୋଲ" },
  },
  ur: {
    diabetes: { base: "ذیابیطس", inflected: "ذیابیطس", translit: "ziabetus", medicine: "میٹفارمین" },
    hypertension: { base: "پریشر", inflected: "پریشر", translit: "preshar", medicine: "املوڈیپین" },
    asthma: { base: "دمہ", inflected: "دمہ", translit: "dama", medicine: "سالبیوٹامول" },
    fever: { base: "بخار", inflected: "بخار", translit: "bukhar", medicine: "پیراسیٹامول" },
  },
};

/** A short connective per language ("for … give …"), so a document is a line, not a word list. */
export const LINE: Record<Exclude<Lang, "en">, (cond: string, med: string, dose: string) => string> = {
  hi: (c, m, d) => `${c} के लिए ${m} ${d} दिन में दो बार दी गई।`,
  mr: (c, m, d) => `${c} ${m} ${d} दिवसातून दोनदा दिले.`,
  bn: (c, m, d) => `${c} জন্য ${m} ${d} দিনে দুবার দেওয়া হয়েছে।`,
  gu: (c, m, d) => `${c} સારવાર માટે ${m} ${d} દિવસમાં બે વાર આપી.`,
  te: (c, m, d) => `${c} ${m} ${d} రోజుకు రెండుసార్లు ఇచ్చారు.`,
  ta: (c, m, d) => `${c} ${m} ${d} நாளுக்கு இருமுறை கொடுக்கப்பட்டது.`,
  kn: (c, m, d) => `${c} ${m} ${d} ದಿನಕ್ಕೆ ಎರಡು ಬಾರಿ ನೀಡಲಾಗಿದೆ.`,
  ml: (c, m, d) => `${c} ${m} ${d} ദിവസം രണ്ടുതവണ നൽകി.`,
  or: (c, m, d) => `${c} ପାଇଁ ${m} ${d} ଦିନକୁ ଦୁଇଥର ଦିଆଗଲା।`,
  ur: (c, m, d) => `${c} کے لیے ${m} ${d} دن میں دو بار دی گئی۔`,
};

export interface BenchDoc { id: string; lang: Lang; topic: Topic; text: string }
export type QueryKind = "SAME_SCRIPT" | "INFLECTED" | "TRANSLITERATED" | "MIXED_SCRIPT" | "CROSS_SCRIPT" | "MEDICINE_LATIN";
export interface BenchQuery { id: string; lang: Lang; kind: QueryKind; text: string; relevant: string[] }

export function buildCorpus(): BenchDoc[] {
  const docs: BenchDoc[] = TOPICS.map((t) => ({ id: `en-${t}`, lang: "en", topic: t, text: ENGLISH[t].doc }));
  for (const lang of LANGUAGES) {
    if (lang === "en") continue;
    for (const t of TOPICS) {
      const w = INDIC[lang][t];
      docs.push({ id: `${lang}-${t}`, lang, topic: t, text: LINE[lang](w.inflected, w.medicine, MEDICINE[t].dose) });
    }
  }
  return docs;
}

/**
 * The queries. Each has exactly one relevant document: the same condition in
 * the target language. (For a cross-script query the other languages' lines
 * about the same condition are not wrong answers, but this measures whether
 * the target-language line is found; ranks are reported with that in mind.)
 */
export function buildQueries(): BenchQuery[] {
  const qs: BenchQuery[] = [];
  for (const t of TOPICS) qs.push({ id: `en-${t}-same`, lang: "en", kind: "SAME_SCRIPT", text: ENGLISH[t].query, relevant: [`en-${t}`] });
  for (const lang of LANGUAGES) {
    if (lang === "en") continue;
    for (const t of TOPICS) {
      const w = INDIC[lang][t];
      const target = [`${lang}-${t}`];
      qs.push({ id: `${lang}-${t}-same`, lang, kind: "SAME_SCRIPT", text: w.inflected, relevant: target });
      if (w.base !== w.inflected) qs.push({ id: `${lang}-${t}-inflected`, lang, kind: "INFLECTED", text: w.base, relevant: target });
      qs.push({ id: `${lang}-${t}-translit`, lang, kind: "TRANSLITERATED", text: w.translit, relevant: target });
      qs.push({ id: `${lang}-${t}-mixed`, lang, kind: "MIXED_SCRIPT", text: `${w.base} ${MEDICINE[t].inn}`, relevant: target });
      qs.push({ id: `${lang}-${t}-cross`, lang, kind: "CROSS_SCRIPT", text: ENGLISH[t].query, relevant: target });
      qs.push({ id: `${lang}-${t}-medicine`, lang, kind: "MEDICINE_LATIN", text: MEDICINE[t].inn, relevant: target });
    }
  }
  return qs;
}
