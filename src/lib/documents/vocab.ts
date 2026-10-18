/**
 * Week 4a — the pipeline's label vocabulary for the nine supported languages
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §10.1). Used by the evaluation fixtures
 * (to write synthetic reports), the rule-based mock extractor and translator,
 * and language detection. Labels only: clinical values on Indian reports are
 * printed in English, and the fixtures keep them so.
 *
 * Pending clinical advisor: the wording of these labels (they are not shown to
 * patients; they describe what synthetic reports say).
 */
export const SUPPORTED_LANGUAGES = ["en", "hi", "mr", "ta", "bn", "gu", "te", "kn", "ml"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LABEL_KEYS = ["diagnosis", "allergy", "procedure", "date", "labReport", "prescription", "dischargeSummary", "imagingReport", "impression", "patient", "advice", "adviceText"] as const;
export type LabelKey = (typeof LABEL_KEYS)[number];

export const LABELS: Record<SupportedLanguage, Record<LabelKey, string>> = {
  en: { diagnosis: "Diagnosis", allergy: "Allergy", procedure: "Procedure", date: "Date", labReport: "Laboratory Report", prescription: "Prescription", dischargeSummary: "Discharge Summary", imagingReport: "Radiology Report", impression: "Impression", patient: "Patient", advice: "Advice", adviceText: "Take the medicines on time and drink plenty of water." },
  hi: { diagnosis: "निदान", allergy: "एलर्जी", procedure: "प्रक्रिया", date: "दिनांक", labReport: "जाँच रिपोर्ट", prescription: "पर्चा", dischargeSummary: "डिस्चार्ज सारांश", imagingReport: "रेडियोलॉजी रिपोर्ट", impression: "निष्कर्ष", patient: "मरीज़", advice: "सलाह", adviceText: "दवाइयाँ समय पर लें और खूब पानी पिएं।" },
  mr: { diagnosis: "रोगनिदान", allergy: "ॲलर्जी", procedure: "उपचार प्रक्रिया", date: "तारीख", labReport: "तपासणी अहवाल", prescription: "औषधचिठ्ठी", dischargeSummary: "डिस्चार्ज सारांश अहवाल", imagingReport: "रेडिओलॉजी अहवाल", impression: "अनुमान", patient: "रुग्ण", advice: "सल्ला", adviceText: "औषधे वेळेवर घ्या आणि भरपूर पाणी प्या." },
  ta: { diagnosis: "நோயறிதல்", allergy: "ஒவ்வாமை", procedure: "சிகிச்சை முறை", date: "தேதி", labReport: "ஆய்வக அறிக்கை", prescription: "மருந்துச்சீட்டு", dischargeSummary: "வெளியேற்ற சுருக்கம்", imagingReport: "கதிரியக்க அறிக்கை", impression: "முடிவு", patient: "நோயாளி", advice: "ஆலோசனை", adviceText: "மருந்துகளை நேரத்திற்கு எடுத்துக்கொள்ளவும், நிறைய தண்ணீர் குடிக்கவும்." },
  bn: { diagnosis: "রোগনির্ণয়", allergy: "অ্যালার্জি", procedure: "পদ্ধতি", date: "তারিখ", labReport: "পরীক্ষার রিপোর্ট", prescription: "প্রেসক্রিপশন", dischargeSummary: "ছাড়পত্রের সারাংশ", imagingReport: "রেডিওলজি রিপোর্ট", impression: "সিদ্ধান্ত", patient: "রোগী", advice: "পরামর্শ", adviceText: "সময়মতো ওষুধ খান এবং প্রচুর জল পান করুন।" },
  gu: { diagnosis: "નિદાન", allergy: "એલર્જી", procedure: "પ્રક્રિયા", date: "તારીખ", labReport: "લેબોરેટરી રિપોર્ટ", prescription: "પ્રિસ્ક્રિપ્શન", dischargeSummary: "ડિસ્ચાર્જ સારાંશ", imagingReport: "રેડિયોલોજી રિપોર્ટ", impression: "તારણ", patient: "દર્દી", advice: "સલાહ", adviceText: "દવાઓ સમયસર લો અને પુષ્કળ પાણી પીઓ." },
  te: { diagnosis: "రోగ నిర్ధారణ", allergy: "అలెర్జీ", procedure: "ప్రక్రియ", date: "తేదీ", labReport: "ల్యాబ్ నివేదిక", prescription: "ప్రిస్క్రిప్షన్", dischargeSummary: "డిశ్చార్జ్ సారాంశం", imagingReport: "రేడియాలజీ నివేదిక", impression: "ముగింపు", patient: "రోగి", advice: "సలహా", adviceText: "మందులు సమయానికి వేసుకోండి, ఎక్కువ నీరు తాగండి." },
  kn: { diagnosis: "ರೋಗನಿರ್ಣಯ", allergy: "ಅಲರ್ಜಿ", procedure: "ಪ್ರಕ್ರಿಯೆ", date: "ದಿನಾಂಕ", labReport: "ಪ್ರಯೋಗಾಲಯ ವರದಿ", prescription: "ಔಷಧ ಚೀಟಿ", dischargeSummary: "ಡಿಸ್ಚಾರ್ಜ್ ಸಾರಾಂಶ", imagingReport: "ರೇಡಿಯಾಲಜಿ ವರದಿ", impression: "ತೀರ್ಮಾನ", patient: "ರೋಗಿ", advice: "ಸಲಹೆ", adviceText: "ಔಷಧಿಗಳನ್ನು ಸಮಯಕ್ಕೆ ಸರಿಯಾಗಿ ತೆಗೆದುಕೊಳ್ಳಿ ಮತ್ತು ಸಾಕಷ್ಟು ನೀರು ಕುಡಿಯಿರಿ." },
  ml: { diagnosis: "രോഗനിർണയം", allergy: "അലർജി", procedure: "നടപടിക്രമം", date: "തീയതി", labReport: "ലാബ് റിപ്പോർട്ട്", prescription: "കുറിപ്പടി", dischargeSummary: "ഡിസ്ചാർജ് സംഗ്രഹം", imagingReport: "റേഡിയോളജി റിപ്പോർട്ട്", impression: "നിഗമനം", patient: "രോഗി", advice: "നിർദ്ദേശം", adviceText: "മരുന്നുകൾ കൃത്യസമയത്ത് കഴിക്കുക, ധാരാളം വെള്ളം കുടിക്കുക." },
};

/** Every language's label for one key (for rules that must read any language). */
export function labelsFor(key: LabelKey): string[] {
  return [...new Set(SUPPORTED_LANGUAGES.map((l) => LABELS[l][key]))];
}

/** Unicode script of each language (ISO 15924). Hindi and Marathi share Devanagari. */
export const LANGUAGE_SCRIPT: Record<SupportedLanguage, string> = { en: "Latn", hi: "Deva", mr: "Deva", ta: "Taml", bn: "Beng", gu: "Gujr", te: "Telu", kn: "Knda", ml: "Mlym" };

/** Words that tell Marathi from Hindi (both Devanagari). */
export const DEVANAGARI_STOPWORDS: Record<"hi" | "mr", readonly string[]> = {
  hi: ["है", "और", "का", "की", "के", "में", "लें", "पिएं", "मरीज़", "रिपोर्ट", "सलाह", "जाँच", "पर्चा", "दिनांक", "को", "से"],
  mr: ["आहे", "आणि", "घ्या", "प्या", "अहवाल", "रुग्ण", "सल्ला", "तपासणी", "तारीख", "चे", "ची", "औषधे", "वेळेवर"],
};
export const ENGLISH_STOPWORDS = ["the", "and", "of", "to", "in", "on", "with", "take", "is", "for", "no", "drink", "plenty"] as const;
