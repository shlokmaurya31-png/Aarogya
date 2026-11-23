import { LANGUAGES, LINE as MED_LINE, type BenchDoc, type BenchQuery, type Lang } from "./dataset";

/**
 * RAG Phase 3 — the Indic benchmark's DEVELOPMENT split. Four topics the test
 * set (dataset.ts: diabetes, hypertension, asthma, fever) does not use —
 * cough, jaundice, vomiting, headache — in the eleven languages. Steps 3.9
 * and 3.10 (and the trigram threshold) are tuned on these only; the Phase 1
 * set is the held-out test split, reported and never tuned on.
 *
 * STATUS: written by the engineering team, not reviewed by native speakers
 * or a clinician. Synthetic; no patient.
 */
export type DevTopic = "cough" | "jaundice" | "vomiting" | "headache";
export const DEV_TOPICS: readonly DevTopic[] = ["cough", "jaundice", "vomiting", "headache"];

export const DEV_ENGLISH: Record<DevTopic, { doc: string; query: string }> = {
  cough: { doc: "Dry cough for two weeks. Advised steam inhalation and warm fluids.", query: "cough" },
  jaundice: { doc: "Jaundice with yellow eyes. Liver function tests ordered.", query: "jaundice" },
  vomiting: { doc: "Vomiting since morning. Oral rehydration started.", query: "vomiting" },
  headache: { doc: "Headache on waking. Blood pressure to be checked.", query: "headache" },
};

interface DevTerm { base: string; inflected: string; translit: string }

/** Each dev topic's medicine (INN, a dose) and how each language writes it, for the mixed-script and Latin-medicine cases. */
export const DEV_MEDICINE: Record<DevTopic, { inn: string; dose: string; names: Record<Exclude<Lang, "en">, string> }> = {
  cough: { inn: "amoxicillin", dose: "500 mg", names: { hi: "एमोक्सिसिलिन", mr: "अमोक्सिसिलिन", bn: "অ্যামোক্সিসিলিন", ta: "அமாக்சிசிலின்", te: "అమోక్సిసిలిన్", kn: "ಅಮಾಕ್ಸಿಸಿಲಿನ್", ml: "അമോക്സിസില്ലിൻ", gu: "એમોક્સિસિલિન", or: "ଆମୋକ୍ସିସିଲିନ", ur: "اموکسیسلن" } },
  jaundice: { inn: "omeprazole", dose: "20 mg", names: { hi: "ओमेप्राज़ोल", mr: "ओमेप्राझोल", bn: "ওমিপ্রাজল", ta: "ஒமெப்ரசோல்", te: "ఒమెప్రజోల్", kn: "ಒಮೆಪ್ರಜೋಲ್", ml: "ഒമെപ്രസോൾ", gu: "ઓમેપ્રાઝોલ", or: "ଓମେପ୍ରାଜୋଲ", ur: "اومیپرازول" } },
  vomiting: { inn: "ors", dose: "1 L", names: { hi: "ओआरएस", mr: "ओआरएस", bn: "ওআরএস", ta: "ஓஆர்எஸ்", te: "ఓఆర్ఎస్", kn: "ಒಆರ್‌ಎಸ್", ml: "ഒആർഎസ്", gu: "ઓઆરએસ", or: "ଓଆରଏସ", ur: "او آر ایس" } },
  headache: { inn: "aspirin", dose: "75 mg", names: { hi: "एस्पिरिन", mr: "अ‍ॅस्पिरिन", bn: "অ্যাসপিরিন", ta: "ஆஸ்பிரின்", te: "ఆస్పిరిన్", kn: "ಆಸ್ಪಿರಿನ್", ml: "ആസ്പിരിൻ", gu: "એસ્પિરિન", or: "ଆସ୍ପିରିନ", ur: "اسپرین" } },
};

export const DEV_INDIC: Record<Exclude<Lang, "en">, Record<DevTopic, DevTerm>> = {
  hi: { cough: { base: "खांसी", inflected: "खांसी", translit: "khansi" }, jaundice: { base: "पीलिया", inflected: "पीलिया", translit: "piliya" }, vomiting: { base: "उल्टी", inflected: "उल्टी", translit: "ulti" }, headache: { base: "सिरदर्द", inflected: "सिरदर्द", translit: "sirdard" } },
  mr: { cough: { base: "खोकला", inflected: "खोकल्यासाठी", translit: "khokla" }, jaundice: { base: "कावीळ", inflected: "काविळीसाठी", translit: "kavil" }, vomiting: { base: "उलटी", inflected: "उलटीसाठी", translit: "ulti" }, headache: { base: "डोकेदुखी", inflected: "डोकेदुखीसाठी", translit: "dokedukhi" } },
  bn: { cough: { base: "কাশি", inflected: "কাশির", translit: "kashi" }, jaundice: { base: "জন্ডিস", inflected: "জন্ডিসের", translit: "jondis" }, vomiting: { base: "বমি", inflected: "বমির", translit: "bomi" }, headache: { base: "মাথাব্যথা", inflected: "মাথাব্যথার", translit: "mathabyatha" } },
  ta: { cough: { base: "இருமல்", inflected: "இருமலுக்கு", translit: "irumal" }, jaundice: { base: "காமாலை", inflected: "காமாலைக்கு", translit: "kamalai" }, vomiting: { base: "வாந்தி", inflected: "வாந்திக்கு", translit: "vanthi" }, headache: { base: "தலைவலி", inflected: "தலைவலிக்கு", translit: "thalaivali" } },
  te: { cough: { base: "దగ్గు", inflected: "దగ్గుకు", translit: "daggu" }, jaundice: { base: "పచ్చకామెర్లు", inflected: "పచ్చకామెర్లకు", translit: "pachakamerlu" }, vomiting: { base: "వాంతి", inflected: "వాంతికి", translit: "vanti" }, headache: { base: "తలనొప్పి", inflected: "తలనొప్పికి", translit: "talanoppi" } },
  kn: { cough: { base: "ಕೆಮ್ಮು", inflected: "ಕೆಮ್ಮಿಗೆ", translit: "kemmu" }, jaundice: { base: "ಕಾಮಾಲೆ", inflected: "ಕಾಮಾಲೆಗೆ", translit: "kamale" }, vomiting: { base: "ವಾಂತಿ", inflected: "ವಾಂತಿಗೆ", translit: "vanti" }, headache: { base: "ತಲೆನೋವು", inflected: "ತಲೆನೋವಿಗೆ", translit: "talenovu" } },
  ml: { cough: { base: "ചുമ", inflected: "ചുമയ്ക്ക്", translit: "chuma" }, jaundice: { base: "മഞ്ഞപ്പിത്തം", inflected: "മഞ്ഞപ്പിത്തത്തിന്", translit: "manjappittam" }, vomiting: { base: "ഛർദ്ദി", inflected: "ഛർദ്ദിക്ക്", translit: "chardi" }, headache: { base: "തലവേദന", inflected: "തലവേദനയ്ക്ക്", translit: "thalavedana" } },
  gu: { cough: { base: "ઉધરસ", inflected: "ઉધરસની", translit: "udharas" }, jaundice: { base: "કમળો", inflected: "કમળાની", translit: "kamlo" }, vomiting: { base: "ઉલટી", inflected: "ઉલટીની", translit: "ulti" }, headache: { base: "માથાનો દુખાવો", inflected: "માથાનો દુખાવો", translit: "mathano dukhavo" } },
  or: { cough: { base: "କାଶ", inflected: "କାଶର", translit: "kasha" }, jaundice: { base: "କାମଳ", inflected: "କାମଳର", translit: "kamala" }, vomiting: { base: "ବାନ୍ତି", inflected: "ବାନ୍ତିର", translit: "banti" }, headache: { base: "ମୁଣ୍ଡବିନ୍ଧା", inflected: "ମୁଣ୍ଡବିନ୍ଧାର", translit: "mundabindha" } },
  ur: { cough: { base: "کھانسی", inflected: "کھانسی", translit: "khansi" }, jaundice: { base: "یرقان", inflected: "یرقان", translit: "yarkan" }, vomiting: { base: "الٹی", inflected: "الٹی", translit: "ulti" }, headache: { base: "سر درد", inflected: "سر درد", translit: "sar dard" } },
};

/** A short connective per language, so a document is a line ("… rest and fluids advised"). */
const LINE: Record<Exclude<Lang, "en">, (cond: string) => string> = {
  hi: (c) => `${c} के लिए आराम और पानी की सलाह दी गई।`,
  mr: (c) => `${c} विश्रांती आणि पाणी घेण्याचा सल्ला दिला.`,
  bn: (c) => `${c} জন্য বিশ্রাম ও জল খাওয়ার পরামর্শ দেওয়া হয়েছে।`,
  gu: (c) => `${c} માટે આરામ અને પાણી લેવાની સલાહ આપી.`,
  te: (c) => `${c} విశ్రాంతి మరియు నీరు తీసుకోమని సూచించారు.`,
  ta: (c) => `${c} ஓய்வு மற்றும் தண்ணீர் எடுக்க அறிவுறுத்தப்பட்டது.`,
  kn: (c) => `${c} ವಿಶ್ರಾಂತಿ ಮತ್ತು ನೀರು ಕುಡಿಯಲು ಸಲಹೆ ನೀಡಲಾಗಿದೆ.`,
  ml: (c) => `${c} വിശ്രമവും വെള്ളവും നിർദ്ദേശിച്ചു.`,
  or: (c) => `${c} ପାଇଁ ବିଶ୍ରାମ ଓ ପାଣି ପିଇବାକୁ ପରାମର୍ଶ ଦିଆଗଲା।`,
  ur: (c) => `${c} کے لیے آرام اور پانی کا مشورہ دیا گیا۔`,
};

export function buildDevCorpus(): BenchDoc[] {
  const docs: BenchDoc[] = DEV_TOPICS.map((t) => ({ id: `dev-en-${t}`, lang: "en", topic: t as never, text: DEV_ENGLISH[t].doc }));
  for (const lang of LANGUAGES) {
    if (lang === "en") continue;
    for (const t of DEV_TOPICS) docs.push({ id: `dev-${lang}-${t}`, lang, topic: t as never, text: `${LINE[lang](DEV_INDIC[lang][t].inflected)} ${MED_LINE[lang](DEV_INDIC[lang][t].base, DEV_MEDICINE[t].names[lang], DEV_MEDICINE[t].dose)}` });
  }
  return docs;
}

export function buildDevQueries(): BenchQuery[] {
  const qs: BenchQuery[] = [];
  for (const t of DEV_TOPICS) qs.push({ id: `dev-en-${t}-same`, lang: "en", kind: "SAME_SCRIPT", text: DEV_ENGLISH[t].query, relevant: [`dev-en-${t}`] });
  for (const lang of LANGUAGES) {
    if (lang === "en") continue;
    for (const t of DEV_TOPICS) {
      const w = DEV_INDIC[lang][t];
      const target = [`dev-${lang}-${t}`];
      qs.push({ id: `dev-${lang}-${t}-same`, lang, kind: "SAME_SCRIPT", text: w.inflected, relevant: target });
      if (w.base !== w.inflected) qs.push({ id: `dev-${lang}-${t}-inflected`, lang, kind: "INFLECTED", text: w.base, relevant: target });
      qs.push({ id: `dev-${lang}-${t}-translit`, lang, kind: "TRANSLITERATED", text: w.translit, relevant: target });
      qs.push({ id: `dev-${lang}-${t}-mixed`, lang, kind: "MIXED_SCRIPT", text: `${w.base} ${DEV_MEDICINE[t].inn}`, relevant: target });
      qs.push({ id: `dev-${lang}-${t}-cross`, lang, kind: "CROSS_SCRIPT", text: DEV_ENGLISH[t].query, relevant: target });
      qs.push({ id: `dev-${lang}-${t}-medicine`, lang, kind: "MEDICINE_LATIN", text: DEV_MEDICINE[t].inn, relevant: target });
    }
  }
  return qs;
}
