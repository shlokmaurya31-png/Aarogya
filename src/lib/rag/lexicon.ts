import { latinSkeleton, romanizeWord } from "./romanize";

/**
 * RAG Phase 3, step 3.10 (plan §13.3 decision C, b) — a multilingual medical
 * concept lexicon: common conditions, symptoms, tests and NLEM / WHO INN
 * medicines, each a concept with its names in the app's eleven languages.
 * Used ONLY to expand a search query with the same concept's other names:
 * it never rewrites the question, never adds a fact, and carries no dose.
 *
 * STATUS: every entry is PENDING NATIVE-SPEAKER AND CLINICAL REVIEW. The
 * names are common words written by the engineering team from general
 * usage (medicine names phonetically, as Indian prescriptions write them),
 * not taken from the Indic benchmark; a reviewer may change any of them.
 */
export const LEXICON_REVIEW_STATUS = "pending native-speaker and clinical review" as const;
export type ConceptKind = "CONDITION" | "SYMPTOM" | "TEST" | "MEDICINE";
export type LexLang = "en" | "hi" | "mr" | "bn" | "ta" | "te" | "kn" | "ml" | "gu" | "or" | "ur";
export interface Concept { id: string; kind: ConceptKind; review: typeof LEXICON_REVIEW_STATUS; names: Partial<Record<LexLang, string[]>> }

const c = (id: string, kind: ConceptKind, names: Concept["names"]): Concept => ({ id, kind, review: LEXICON_REVIEW_STATUS, names });

export const LEXICON: readonly Concept[] = [
  // ── conditions ──
  c("C_DIABETES", "CONDITION", { en: ["diabetes", "diabetes mellitus"], hi: ["मधुमेह", "डायबिटीज़", "डायबिटीज"], mr: ["मधुमेह", "डायबेटीस"], bn: ["ডায়াবেটিস", "বহুমূত্র"], ta: ["நீரிழிவு", "சர்க்கரை நோய்"], te: ["మధుమేహం", "చక్కెర వ్యాధి"], kn: ["ಮಧುಮೇಹ", "ಸಕ್ಕರೆ ಕಾಯಿಲೆ"], ml: ["പ്രമേഹം"], gu: ["ડાયાબિટીસ", "મધુપ્રમેહ"], or: ["ମଧୁମେହ", "ଡାଇବେଟିସ୍"], ur: ["ذیابیطس"] }),
  c("C_HYPERTENSION", "CONDITION", { en: ["hypertension", "high blood pressure"], hi: ["उच्च रक्तचाप", "हाइपरटेंशन"], mr: ["उच्च रक्तदाब"], bn: ["উচ্চ রক্তচাপ"], ta: ["உயர் இரத்த அழுத்தம்"], te: ["అధిక రక్తపోటు"], kn: ["ಅಧಿಕ ರಕ್ತದೊತ್ತಡ"], ml: ["രക്താതിമർദ്ദം", "ഉയർന്ന രക്തസമ്മർദ്ദം"], gu: ["ઉચ્ચ રક્તદાબ", "હાઈ બ્લડ પ્રેશર"], or: ["ଉଚ୍ଚ ରକ୍ତଚାପ"], ur: ["ہائی بلڈ پریشر", "فشار خون"] }),
  c("C_ASTHMA", "CONDITION", { en: ["asthma", "bronchial asthma"], hi: ["दमा", "अस्थमा"], mr: ["दमा", "अस्थमा"], bn: ["হাঁপানি", "অ্যাজমা"], ta: ["ஆஸ்துமா", "இழுப்பு"], te: ["ఉబ్బసం", "ఆస్తమా"], kn: ["ಅಸ್ತಮಾ", "ಉಬ್ಬಸ"], ml: ["ആസ്ത്മ"], gu: ["દમ", "અસ્થમા"], or: ["ଆଜମା"], ur: ["دمہ"] }),
  c("C_FEVER", "SYMPTOM", { en: ["fever", "pyrexia"], hi: ["बुखार", "ज्वर"], mr: ["ताप"], bn: ["জ্বর"], ta: ["காய்ச்சல்", "ஜுரம்"], te: ["జ్వరం"], kn: ["ಜ್ವರ"], ml: ["പനി"], gu: ["તાવ"], or: ["ଜ୍ୱର"], ur: ["بخار"] }),
  c("C_TUBERCULOSIS", "CONDITION", { en: ["tuberculosis"], hi: ["क्षय रोग", "तपेदिक", "टीबी"], mr: ["क्षयरोग", "टीबी"], bn: ["যক্ষ্মা"], ta: ["காசநோய்"], te: ["క్షయ"], kn: ["ಕ್ಷಯ"], ml: ["ക്ഷയം"], gu: ["ક્ષય"], or: ["ଯକ୍ଷ୍ମା"], ur: ["تپ دق"] }),
  c("C_ANAEMIA", "CONDITION", { en: ["anaemia", "anemia"], hi: ["खून की कमी", "एनीमिया", "रक्ताल्पता"], mr: ["रक्तक्षय"], bn: ["রক্তাল্পতা", "অ্যানিমিয়া"], ta: ["இரத்த சோகை"], te: ["రక్తహీనత"], kn: ["ರಕ್ತಹೀನತೆ"], ml: ["വിളർച്ച"], gu: ["પાંડુરોગ", "એનિમિયા"], or: ["ରକ୍ତହୀନତା"], ur: ["خون کی کمی"] }),
  c("C_JAUNDICE", "CONDITION", { en: ["jaundice"], hi: ["पीलिया"], mr: ["कावीळ"], bn: ["জন্ডিস", "ন্যাবা"], ta: ["மஞ்சள் காமாலை"], te: ["పచ్చకామెర్లు"], kn: ["ಕಾಮಾಲೆ"], ml: ["മഞ്ഞപ്പിത്തം"], gu: ["કમળો"], or: ["କାମଳ"], ur: ["یرقان"] }),
  c("C_DIARRHOEA", "SYMPTOM", { en: ["diarrhoea", "diarrhea", "loose motions"], hi: ["दस्त", "डायरिया"], mr: ["जुलाब", "अतिसार"], bn: ["ডায়রিয়া", "পাতলা পায়খানা"], ta: ["வயிற்றுப்போக்கு"], te: ["విరేచనాలు"], kn: ["ಅತಿಸಾರ", "ಭೇದಿ"], ml: ["വയറിളക്കം"], gu: ["ઝાડા"], or: ["ଝାଡ଼ା"], ur: ["اسہال"] }),
  c("C_PNEUMONIA", "CONDITION", { en: ["pneumonia"], hi: ["निमोनिया"], mr: ["न्यूमोनिया"], bn: ["নিউমোনিয়া"], ta: ["நிமோனியா"], te: ["న్యుమోనియా"], kn: ["ನ್ಯುಮೋನಿಯಾ"], ml: ["ന്യുമോണിയ"], gu: ["ન્યુમોનિયા"], or: ["ନିମୋନିଆ"], ur: ["نمونیا"] }),
  c("C_MALARIA", "CONDITION", { en: ["malaria"], hi: ["मलेरिया"], mr: ["मलेरिया", "हिवताप"], bn: ["ম্যালেরিয়া"], ta: ["மலேரியா"], te: ["మలేరియా"], kn: ["ಮಲೇರಿಯಾ"], ml: ["മലേറിയ"], gu: ["મેલેરિયા"], or: ["ମ୍ୟାଲେରିଆ"], ur: ["ملیریا"] }),
  c("C_DENGUE", "CONDITION", { en: ["dengue"], hi: ["डेंगू"], mr: ["डेंग्यू"], bn: ["ডেঙ্গু"], ta: ["டெங்கு"], te: ["డెంగ్యూ"], kn: ["ಡೆಂಗ್ಯೂ"], ml: ["ഡെങ്കിപ്പനി"], gu: ["ડેન્ગ્યુ"], or: ["ଡେଙ୍ଗୁ"], ur: ["ڈینگی"] }),
  c("C_TYPHOID", "CONDITION", { en: ["typhoid", "enteric fever"], hi: ["टाइफाइड", "मियादी बुखार"], mr: ["विषमज्वर", "टायफॉइड"], bn: ["টাইফয়েড"], ta: ["டைபாய்டு"], te: ["టైఫాయిడ్"], kn: ["ಟೈಫಾಯಿಡ್"], ml: ["ടൈഫോയ്ഡ്"], gu: ["ટાઇફોઇડ"], or: ["ଟାଇଫଏଡ୍"], ur: ["ٹائیفائیڈ"] }),
  c("C_HEART_ATTACK", "CONDITION", { en: ["heart attack", "myocardial infarction"], hi: ["दिल का दौरा", "हार्ट अटैक"], mr: ["हृदयविकाराचा झटका"], bn: ["হার্ট অ্যাটাক"], ta: ["மாரடைப்பு"], te: ["గుండెపోటు"], kn: ["ಹೃದಯಾಘಾತ"], ml: ["ഹൃദയാഘാതം"], gu: ["હાર્ટ એટેક"], or: ["ହୃଦଘାତ"], ur: ["دل کا دورہ"] }),
  c("C_STROKE", "CONDITION", { en: ["stroke"], hi: ["लकवा", "स्ट्रोक"], mr: ["पक्षाघात"], bn: ["স্ট্রোক", "পক্ষাঘাত"], ta: ["பக்கவாதம்"], te: ["పక్షవాతం"], kn: ["ಪಾರ್ಶ್ವವಾಯು"], ml: ["പക്ഷാഘാതം"], gu: ["લકવો"], or: ["ପକ୍ଷାଘାତ"], ur: ["فالج"] }),
  c("C_KIDNEY_DISEASE", "CONDITION", { en: ["kidney disease", "renal failure"], hi: ["गुर्दे की बीमारी", "किडनी की बीमारी"], mr: ["मूत्रपिंडाचा आजार"], bn: ["কিডনির রোগ"], ta: ["சிறுநீரக நோய்"], te: ["మూత్రపిండ వ్యాధి"], kn: ["ಮೂತ್ರಪಿಂಡ ಕಾಯಿಲೆ"], ml: ["വൃക്കരോഗം"], gu: ["કિડનીનો રોગ"], or: ["ବୃକ୍କ ରୋଗ"], ur: ["گردے کی بیماری"] }),
  c("C_THYROID", "CONDITION", { en: ["hypothyroidism", "thyroid"], hi: ["थायराइड"], mr: ["थायरॉईड"], bn: ["থাইরয়েড"], ta: ["தைராய்டு"], te: ["థైరాయిడ్"], kn: ["ಥೈರಾಯ್ಡ್"], ml: ["തൈറോയ്ഡ്"], gu: ["થાઇરોઇડ"], or: ["ଥାଇରଏଡ୍"], ur: ["تھائیرائیڈ"] }),
  // ── symptoms ──
  c("S_COUGH", "SYMPTOM", { en: ["cough"], hi: ["खांसी", "खाँसी"], mr: ["खोकला"], bn: ["কাশি"], ta: ["இருமல்"], te: ["దగ్గు"], kn: ["ಕೆಮ್ಮು"], ml: ["ചുമ"], gu: ["ઉધરસ", "ખાંસી"], or: ["କାଶ"], ur: ["کھانسی"] }),
  c("S_COLD", "SYMPTOM", { en: ["common cold", "runny nose"], hi: ["जुकाम", "सर्दी"], mr: ["सर्दी"], bn: ["সর্দি"], ta: ["சளி"], te: ["జలుబు"], kn: ["ನೆಗಡಿ"], ml: ["ജലദോഷം"], gu: ["શરદી"], or: ["ଥଣ୍ଡା"], ur: ["زکام", "نزلہ"] }),
  c("S_HEADACHE", "SYMPTOM", { en: ["headache"], hi: ["सिरदर्द", "सिर दर्द"], mr: ["डोकेदुखी"], bn: ["মাথাব্যথা"], ta: ["தலைவலி"], te: ["తలనొప్పి"], kn: ["ತಲೆನೋವು"], ml: ["തലവേദന"], gu: ["માથાનો દુખાવો"], or: ["ମୁଣ୍ଡବିନ୍ଧା"], ur: ["سر درد"] }),
  c("S_VOMITING", "SYMPTOM", { en: ["vomiting"], hi: ["उल्टी", "उलटी"], mr: ["उलटी", "ओकारी"], bn: ["বমি"], ta: ["வாந்தி"], te: ["వాంతులు", "వాంతి"], kn: ["ವಾಂತಿ"], ml: ["ഛർദ്ദി"], gu: ["ઉલટી"], or: ["ବାନ୍ତି"], ur: ["الٹی", "قے"] }),
  c("S_CHEST_PAIN", "SYMPTOM", { en: ["chest pain"], hi: ["सीने में दर्द", "छाती में दर्द"], mr: ["छातीत दुखणे"], bn: ["বুকে ব্যথা"], ta: ["நெஞ்சு வலி"], te: ["ఛాతీ నొప్పి"], kn: ["ಎದೆ ನೋವು"], ml: ["നെഞ്ചുവേദന"], gu: ["છાતીમાં દુખાવો"], or: ["ଛାତି ଯନ୍ତ୍ରଣା"], ur: ["سینے میں درد"] }),
  c("S_BREATHLESSNESS", "SYMPTOM", { en: ["breathlessness", "shortness of breath"], hi: ["सांस फूलना"], mr: ["दम लागणे"], bn: ["শ্বাসকষ্ট"], ta: ["மூச்சுத் திணறல்"], te: ["ఆయాసం"], kn: ["ಉಸಿರಾಟದ ತೊಂದರೆ"], ml: ["ശ്വാസതടസ്സം"], gu: ["શ્વાસ ચડવો"], or: ["ଶ୍ୱାସକଷ୍ଟ"], ur: ["سانس پھولنا"] }),
  c("S_ABDOMINAL_PAIN", "SYMPTOM", { en: ["abdominal pain", "stomach ache"], hi: ["पेट दर्द"], mr: ["पोटदुखी"], bn: ["পেট ব্যথা"], ta: ["வயிற்று வலி"], te: ["కడుపు నొప్పి"], kn: ["ಹೊಟ್ಟೆ ನೋವು"], ml: ["വയറുവേദന"], gu: ["પેટમાં દુખાવો"], or: ["ପେଟ ଯନ୍ତ୍ରଣା"], ur: ["پیٹ درد"] }),
  // ── tests and measurements ──
  c("T_BLOOD_SUGAR", "TEST", { en: ["blood sugar", "blood glucose"], hi: ["ब्लड शुगर", "रक्त शर्करा"], mr: ["रक्तातील साखर"], bn: ["ব্লাড সুগার", "রক্তে শর্করা"], ta: ["இரத்த சர்க்கரை"], te: ["రక్తంలో చక్కెర"], kn: ["ರಕ್ತದ ಸಕ್ಕರೆ"], ml: ["രക്തത്തിലെ പഞ്ചസാര"], gu: ["બ્લડ સુગર"], or: ["ରକ୍ତ ଶର୍କରା"], ur: ["بلڈ شوگر"] }),
  c("T_HAEMOGLOBIN", "TEST", { en: ["haemoglobin", "hemoglobin"], hi: ["हीमोग्लोबिन"], mr: ["हिमोग्लोबिन"], bn: ["হিমোগ্লোবিন"], ta: ["ஹீமோகுளோபின்"], te: ["హిమోగ్లోబిన్"], kn: ["ಹಿಮೋಗ್ಲೋಬಿನ್"], ml: ["ഹീമോഗ്ലോബിൻ"], gu: ["હિમોગ્લોબિન"], or: ["ହିମୋଗ୍ଲୋବିନ"], ur: ["ہیموگلوبن"] }),
  c("T_BLOOD_PRESSURE", "TEST", { en: ["blood pressure"], hi: ["रक्तचाप", "ब्लड प्रेशर"], mr: ["रक्तदाब"], bn: ["রক্তচাপ"], ta: ["இரத்த அழுத்தம்"], te: ["రక్తపోటు"], kn: ["ರಕ್ತದೊತ್ತಡ"], ml: ["രക്തസമ്മർദ്ദം"], gu: ["બ્લડ પ્રેશર", "રક્તદાબ"], or: ["ରକ୍ତଚାପ"], ur: ["بلڈ پریشر"] }),
  c("T_XRAY", "TEST", { en: ["x-ray", "xray"], hi: ["एक्स-रे", "एक्सरे"], mr: ["एक्स-रे"], bn: ["এক্স-রে"], ta: ["எக்ஸ்ரே"], te: ["ఎక్స్‌రే"], kn: ["ಎಕ್ಸ್‌ರೇ"], ml: ["എക്സ്റേ"], gu: ["એક્સ-રે"], or: ["ଏକ୍ସ-ରେ"], ur: ["ایکسرے"] }),
  // ── medicines (NLEM / WHO INN), phonetic in each script ──
  c("M_METFORMIN", "MEDICINE", { en: ["metformin"], hi: ["मेटफॉर्मिन"], mr: ["मेटफॉर्मिन"], bn: ["মেটফরমিন"], ta: ["மெட்ஃபார்மின்"], te: ["మెట్‌ఫార్మిన్"], kn: ["ಮೆಟ್‌ಫಾರ್ಮಿನ್"], ml: ["മെറ്റ്ഫോർമിൻ"], gu: ["મેટફોર્મિન"], or: ["ମେଟଫର୍ମିନ"], ur: ["میٹفارمن"] }),
  c("M_AMLODIPINE", "MEDICINE", { en: ["amlodipine"], hi: ["अम्लोडिपिन", "एम्लोडिपिन"], mr: ["अम्लोडिपिन"], bn: ["অ্যামলোডিপিন"], ta: ["அம்லோடிபின்"], te: ["అమ్లోడిపిన్"], kn: ["ಅಮ್ಲೋಡಿಪಿನ್"], ml: ["അംലോഡിപിൻ"], gu: ["એમ્લોડિપિન"], or: ["ଆମ୍ଲୋଡିପିନ"], ur: ["املوڈپین"] }),
  c("M_SALBUTAMOL", "MEDICINE", { en: ["salbutamol", "albuterol"], hi: ["सालबुटामोल", "साल्बुटामोल"], mr: ["साल्बुटामोल"], bn: ["সালবিউটামল"], ta: ["சால்புட்டமால்"], te: ["సాల్బుటమాల్"], kn: ["ಸಾಲ್ಬುಟಮಾಲ್"], ml: ["സാൽബ്യൂട്ടമോൾ"], gu: ["સાલ્બ્યુટામોલ"], or: ["ସାଲବୁଟାମଲ"], ur: ["سالبیوٹامول"] }),
  c("M_PARACETAMOL", "MEDICINE", { en: ["paracetamol", "acetaminophen"], hi: ["पैरासिटामोल"], mr: ["पॅरासिटामॉल"], bn: ["প্যারাসিটামল"], ta: ["பாராசிட்டமால்"], te: ["పారాసిటమాల్"], kn: ["ಪ್ಯಾರಸಿಟಮಾಲ್"], ml: ["പാരസെറ്റമോൾ"], gu: ["પેરાસિટામોલ"], or: ["ପାରାସିଟାମଲ"], ur: ["پیراسیٹامول"] }),
  c("M_INSULIN", "MEDICINE", { en: ["insulin"], hi: ["इंसुलिन"], mr: ["इन्सुलिन"], bn: ["ইনসুলিন"], ta: ["இன்சுலின்"], te: ["ఇన్సులిన్"], kn: ["ಇನ್ಸುಲಿನ್"], ml: ["ഇൻസുലിൻ"], gu: ["ઇન્સ્યુલિન"], or: ["ଇନସୁଲିନ"], ur: ["انسولین"] }),
  c("M_AMOXICILLIN", "MEDICINE", { en: ["amoxicillin", "amoxycillin"], hi: ["एमोक्सिसिलिन"], mr: ["अमोक्सिसिलिन"], bn: ["অ্যামোক্সিসিলিন"], ta: ["அமாக்சிசிலின்"], te: ["అమోక్సిసిలిన్"], kn: ["ಅಮಾಕ್ಸಿಸಿಲಿನ್"], ml: ["അമോക്സിസില്ലിൻ"], gu: ["એમોક્સિસિલિન"], or: ["ଆମୋକ୍ସିସିଲିନ"], ur: ["اموکسیسلن"] }),
  c("M_AZITHROMYCIN", "MEDICINE", { en: ["azithromycin"], hi: ["एज़िथ्रोमाइसिन"], bn: ["অ্যাজিথ্রোমাইসিন"], ta: ["அசித்ரோமைசின்"], te: ["అజిత్రోమైసిన్"], kn: ["ಅಜಿತ್ರೋಮೈಸಿನ್"], ml: ["അസിത്രോമൈസിൻ"], gu: ["એઝિથ્રોમાઇસિન"], ur: ["ازیتھرومائسن"] }),
  c("M_ATORVASTATIN", "MEDICINE", { en: ["atorvastatin"], hi: ["एटोरवास्टेटिन"], bn: ["অ্যাটোরভাস্টাটিন"], ta: ["அட்டோர்வாஸ்டாடின்"], te: ["అటోర్వాస్టాటిన్"], kn: ["ಅಟೋರ್ವಾಸ್ಟಾಟಿನ್"], ml: ["അറ്റോർവാസ്റ്റാറ്റിൻ"], gu: ["એટોર્વાસ્ટેટિન"], or: ["ଆଟୋରଭାଷ୍ଟାଟିନ"] }),
  c("M_OMEPRAZOLE", "MEDICINE", { en: ["omeprazole"], hi: ["ओमेप्राज़ोल"], bn: ["ওমিপ্রাজল"], ta: ["ஒமெப்ரசோல்"], te: ["ఒమెప్రజోల్"], kn: ["ಒಮೆಪ್ರಜೋಲ್"], ml: ["ഒമെപ്രസോൾ"], gu: ["ઓમેપ્રાઝોલ"], or: ["ଓମେପ୍ରାଜୋଲ"] }),
  c("M_ASPIRIN", "MEDICINE", { en: ["aspirin", "acetylsalicylic acid"], hi: ["एस्पिरिन"], mr: ["अ‍ॅस्पिरिन"], bn: ["অ্যাসপিরিন"], ta: ["ஆஸ்பிரின்"], te: ["ఆస్పిరిన్"], kn: ["ಆಸ್ಪಿರಿನ್"], ml: ["ആസ്പിരിൻ"], gu: ["એસ્પિરિન"], or: ["ଆସ୍ପିରିନ"], ur: ["اسپرین"] }),
  c("M_ORS", "MEDICINE", { en: ["oral rehydration salts", "ors"], hi: ["ओआरएस", "जीवन रक्षक घोल"], bn: ["ওআরএস", "খাবার স্যালাইন"], ta: ["உப்புக் கரைசல்"], te: ["ఓఆర్ఎస్"], gu: ["ઓઆરએસ"], ur: ["او آر ایس"] }),
];

const VIRAMA_END = /[\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0CCD\u0D4D]$/u;
const LATIN = /^[\p{Script=Latin}\p{N}\s-]+$/u;
const words = (s: string) => s.toLowerCase().normalize("NFC").split(/[^\p{L}\p{M}\p{N}‌‍]+/u).filter(Boolean);

/**
 * The concepts a question names. A Latin name matches as whole words; a name
 * in an Indic script matches a word that starts with it (Indic languages
 * inflect at the end: "मधुमेहासाठी"), names of one or two letters excepted.
 * With `romanized` (step 3.9 too), a Latin word also matches an Indic name
 * whose romanisation has the same skeleton ("madhumeh" → मधुमेह).
 */
export function conceptsIn(question: string, opts: { romanized?: boolean } = {}): Concept[] {
  const qWords = words(question);
  const qSkeletons = opts.romanized ? new Set(qWords.filter((w) => LATIN.test(w)).map(latinSkeleton)) : new Set<string>();
  const qText = ` ${qWords.join(" ")} `;
  return LEXICON.filter((concept) => Object.values(concept.names).some((names) => names!.some((name) => {
    const nWords = words(name);
    if (!nWords.length) return false;
    if (LATIN.test(name)) return qText.includes(` ${nWords.join(" ")} `);
    // A name ending in a virama ("இருமல்") inflects through that consonant ("இருமலுக்கு"): matched without it.
    const stems = nWords.map((nw) => nw.replace(VIRAMA_END, ""));
    if (stems.every((nw) => [...nw].length >= 2 && qWords.some((w) => w === nw || w.startsWith(nw)))) return true;
    return opts.romanized === true && nWords.length === 1 && qSkeletons.has(latinSkeleton(romanizeWord(nWords[0])));
  })));
}

/** Function words inside multi-word names, never search terms on their own. */
const STOP = new Set(["of", "the", "a", "an", "in", "and", "or", "high", "blood", "common", "acid", "salts", "की", "का", "के", "में"]);

/** The extra search words for a question: every other name of each concept it names, in every language (none already in the question). */
export function lexiconTerms(question: string, opts: { romanized?: boolean } = {}): string[] {
  const have = new Set(words(question));
  const out = new Set<string>();
  for (const concept of conceptsIn(question, opts)) for (const names of Object.values(concept.names)) for (const n of names!) for (const w of words(n)) if (!have.has(w) && !STOP.has(w)) out.add(w);
  return [...out];
}
