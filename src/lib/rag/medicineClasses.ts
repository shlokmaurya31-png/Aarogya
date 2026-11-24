import { LEXICON_REVIEW_STATUS, type LexLang } from "./lexicon";

/**
 * RAG Phase 5, step 3c — medicine classes and common forms (WHO ATC
 * classification), part of the concept lexicon (plan §13.3 decision C, b).
 * The Phase 4 sealed split asked by class or form ("a statin", "the
 * antibiotic", "the inhaler", "an asthma reliever") and found 2 of 6: the
 * lexicon named medicines, not classes.
 *
 * Each class is an ATC group with its names in the app's eleven languages and
 * its members as WHO INN names the app already has: NLEM 2022, the INN
 * starter list and the variants table (a member in none of them is left out
 * until the full WHO INN list is imported; checklist item 11). A class word in a question (1) routes it to the medicines reader,
 * which then keeps only the class's members; (2) expands the search with the
 * members' names; (3) counts as the subject's evidence when a member is in
 * the sources (abstain.ts). A class never adds a fact or a dose, and a class
 * the patient takes no member of is "no record", never a guess.
 *
 * STATUS: PENDING NATIVE-SPEAKER AND CLINICAL REVIEW, like every lexicon
 * entry (checklist item 29). The Indic names are the common words and
 * phonetic spellings used on Indian prescriptions, written by the engineering
 * team; a pharmacist and a native speaker of each language may change any.
 * Tuned only on the development questions.
 */
export interface MedicineClass {
  /** The ATC code (level 2–4), or a group of codes for a lay class ("blood pressure medicine"). */
  atc: string;
  id: string;
  review: typeof LEXICON_REVIEW_STATUS;
  names: Record<LexLang, string[]>;
  /** WHO INN names, lower case, as the record writes them. */
  members: string[];
  /** A form or route that identifies the class on the chart ("inhalation" for an inhaler). */
  route?: string;
}

const k = (atc: string, id: string, members: string[], names: Record<LexLang, string[]>, route?: string): MedicineClass => ({ atc, id, review: LEXICON_REVIEW_STATUS, names, members, ...(route ? { route } : {}) });

const MACROLIDES = ["azithromycin", "clarithromycin"];
const PENICILLINS = ["amoxicillin", "ampicillin", "benzylpenicillin", "cloxacillin", "piperacillin"];
const CEPHALOSPORINS = ["ceftriaxone", "cefalexin", "cefixime", "cefuroxime", "cefotaxime", "ceftazidime"];
const QUINOLONES = ["ciprofloxacin", "levofloxacin", "ofloxacin", "moxifloxacin"];
const STATINS = ["atorvastatin", "rosuvastatin"];
const BETA_BLOCKERS = ["metoprolol", "propranolol", "bisoprolol", "carvedilol"];
const ACE_INHIBITORS = ["enalapril", "ramipril"];
const ARBS = ["telmisartan", "olmesartan"];
const CCBS = ["amlodipine", "nifedipine", "diltiazem", "verapamil"];
const DIURETICS = ["furosemide", "hydrochlorothiazide", "spironolactone"];
const ORAL_DIABETES = ["metformin", "glibenclamide", "glimepiride", "sitagliptin", "vildagliptin", "pioglitazone", "dapagliflozin", "empagliflozin"];
const INSULINS = ["insulin", "insulin glargine"];
const AIRWAY = ["salbutamol", "levosalbutamol", "ipratropium", "tiotropium", "budesonide", "formoterol", "salmeterol"];
const RELIEVERS = ["salbutamol", "levosalbutamol", "ipratropium"];
const ANTICOAGULANTS = ["warfarin", "heparin", "enoxaparin", "apixaban", "rivaroxaban", "dabigatran"];
const ANTIPLATELETS = ["aspirin", "clopidogrel", "ticagrelor", "prasugrel"];
const NSAIDS = ["ibuprofen", "diclofenac", "aceclofenac", "mefenamic acid"];
const PPIS = ["omeprazole", "pantoprazole", "rabeprazole", "esomeprazole"];
const ANTIBACTERIALS = [...MACROLIDES, ...PENICILLINS, ...CEPHALOSPORINS, ...QUINOLONES, "doxycycline", "metronidazole", "nitrofurantoin", "linezolid", "vancomycin", "meropenem", "gentamicin", "amikacin"];

export const MEDICINE_CLASSES: readonly MedicineClass[] = [
  k("J01", "ANTIBACTERIALS", ANTIBACTERIALS, { en: ["antibiotic", "antibiotics", "antibacterial", "antibacterials", "antimicrobial", "antimicrobials"], hi: ["एंटीबायोटिक", "एंटीबायोटिक्स", "प्रतिजैविक"], mr: ["प्रतिजैविक", "अँटिबायोटिक", "अँटीबायोटिक"], bn: ["অ্যান্টিবায়োটিক", "অ্যান্টিবায়োটিকস"], ta: ["ஆன்டிபயாடிக்", "ஆண்டிபயாடிக்", "நுண்ணுயிர் எதிர்ப்பி"], te: ["యాంటీబయాటిక్", "యాంటీబయోటిక్"], kn: ["ಆ್ಯಂಟಿಬಯೋಟಿಕ್", "ಆಂಟಿಬಯೋಟಿಕ್", "ಪ್ರತಿಜೀವಕ"], ml: ["ആന്റിബയോട്ടിക്", "ആൻറിബയോട്ടിക്"], gu: ["એન્ટિબાયોટિક", "એન્ટીબાયોટીક"], or: ["ଆଣ୍ଟିବାୟୋଟିକ୍", "ଆଣ୍ଟିବାୟୋଟିକ"], ur: ["اینٹی بائیوٹک", "اینٹی بایوٹک"] }),
  k("J01FA", "MACROLIDES", MACROLIDES, { en: ["macrolide", "macrolides"], hi: ["मैक्रोलाइड"], mr: ["मॅक्रोलाइड"], bn: ["ম্যাক্রোলাইড"], ta: ["மேக்ரோலைடு"], te: ["మాక్రోలైడ్"], kn: ["ಮ್ಯಾಕ್ರೋಲೈಡ್"], ml: ["മാക്രോലൈഡ്"], gu: ["મેક્રોલાઇડ"], or: ["ମାକ୍ରୋଲାଇଡ"], ur: ["میکرولائیڈ"] }),
  k("J01C", "PENICILLINS", PENICILLINS, { en: ["penicillins", "penicillin antibiotic", "penicillin antibiotics"], hi: ["पेनिसिलिन दवाएँ"], mr: ["पेनिसिलिन औषधे"], bn: ["পেনিসিলিন জাতীয় ওষুধ"], ta: ["பெனிசிலின் மருந்துகள்"], te: ["పెన్సిలిన్ మందులు"], kn: ["ಪೆನ್ಸಿಲಿನ್ ಔಷಧಗಳು"], ml: ["പെൻസിലിൻ മരുന്നുകൾ"], gu: ["પેનિસિલિન દવાઓ"], or: ["ପେନିସିଲିନ ଔଷଧ"], ur: ["پینسلین ادویات"] }),
  k("J01D", "CEPHALOSPORINS", CEPHALOSPORINS, { en: ["cephalosporin", "cephalosporins"], hi: ["सेफालोस्पोरिन"], mr: ["सेफॅलोस्पोरिन"], bn: ["সেফালোস্পোরিন"], ta: ["செஃபலோஸ்போரின்"], te: ["సెఫలోస్పోరిన్"], kn: ["ಸೆಫಲೋಸ್ಪೊರಿನ್"], ml: ["സെഫലോസ്പോറിൻ"], gu: ["સેફાલોસ્પોરિન"], or: ["ସେଫାଲୋସ୍ପୋରିନ"], ur: ["سیفالوسپورن"] }),
  k("J01MA", "FLUOROQUINOLONES", QUINOLONES, { en: ["fluoroquinolone", "fluoroquinolones", "quinolone", "quinolones"], hi: ["फ्लोरोक्विनोलोन"], mr: ["फ्लुरोक्विनोलोन"], bn: ["ফ্লুরোকুইনোলোন"], ta: ["ஃப்ளூரோகுயினோலோன்"], te: ["ఫ్లోరోక్వినోలోన్"], kn: ["ಫ್ಲೋರೋಕ್ವಿನೋಲೋನ್"], ml: ["ഫ്ലൂറോക്വിനോലോൺ"], gu: ["ફ્લોરોક્વિનોલોન"], or: ["ଫ୍ଲୋରୋକ୍ୱିନୋଲୋନ"], ur: ["فلوروکوئنولون"] }),
  k("C10AA", "STATINS", STATINS, { en: ["statin", "statins", "cholesterol-lowering", "lipid-lowering", "cholesterol medicine", "cholesterol tablet"], hi: ["स्टैटिन", "कोलेस्ट्रॉल की दवा"], mr: ["स्टॅटिन", "कोलेस्टेरॉलचे औषध"], bn: ["স্ট্যাটিন", "কোলেস্টেরলের ওষুধ"], ta: ["ஸ்டாடின்", "கொலஸ்ட்ரால் மருந்து"], te: ["స్టాటిన్", "కొలెస్ట్రాల్ మందు"], kn: ["ಸ್ಟ್ಯಾಟಿನ್", "ಕೊಲೆಸ್ಟ್ರಾಲ್ ಔಷಧ"], ml: ["സ്റ്റാറ്റിൻ", "കൊളസ്ട്രോൾ മരുന്ന്"], gu: ["સ્ટેટિન", "કોલેસ્ટ્રોલની દવા"], or: ["ଷ୍ଟାଟିନ", "କୋଲେଷ୍ଟ୍ରଲ ଔଷଧ"], ur: ["اسٹیٹن", "کولیسٹرول کی دوا"] }),
  k("C07", "BETA_BLOCKERS", BETA_BLOCKERS, { en: ["beta blocker", "beta blockers", "beta-blocker", "beta-blockers"], hi: ["बीटा ब्लॉकर"], mr: ["बीटा ब्लॉकर"], bn: ["বিটা ব্লকার"], ta: ["பீட்டா பிளாக்கர்"], te: ["బీటా బ్లాకర్"], kn: ["ಬೀಟಾ ಬ್ಲಾಕರ್"], ml: ["ബീറ്റ ബ്ലോക്കർ"], gu: ["બીટા બ્લોકર"], or: ["ବିଟା ବ୍ଲକର"], ur: ["بیٹا بلاکر"] }),
  k("C09A", "ACE_INHIBITORS", ACE_INHIBITORS, { en: ["ace inhibitor", "ace inhibitors", "ace-inhibitor"], hi: ["एसीई इनहिबिटर"], mr: ["एसीई इनहिबिटर"], bn: ["এসিই ইনহিবিটর"], ta: ["ஏசிஇ தடுப்பான்"], te: ["ఏసీఈ ఇన్హిబిటర్"], kn: ["ಎಸಿಇ ಇನ್ಹಿಬಿಟರ್"], ml: ["എസിഇ ഇൻഹിബിറ്റർ"], gu: ["એસીઈ ઇન્હિબિટર"], or: ["ଏସିଇ ଇନହିବିଟର"], ur: ["اے سی ای انہیبیٹر"] }),
  k("C09C", "ARBS", ARBS, { en: ["arb", "arbs", "angiotensin receptor blocker", "angiotensin receptor blockers", "sartan", "sartans"], hi: ["एआरबी"], mr: ["एआरबी"], bn: ["এআরবি"], ta: ["ஏஆர்பி"], te: ["ఏఆర్బీ"], kn: ["ಎಆರ್‌ಬಿ"], ml: ["എആർബി"], gu: ["એઆરબી"], or: ["ଏଆରବି"], ur: ["اے آر بی"] }),
  k("C08", "CALCIUM_CHANNEL_BLOCKERS", CCBS, { en: ["calcium channel blocker", "calcium channel blockers", "ccb"], hi: ["कैल्शियम चैनल ब्लॉकर"], mr: ["कॅल्शियम चॅनेल ब्लॉकर"], bn: ["ক্যালসিয়াম চ্যানেল ব্লকার"], ta: ["கால்சியம் சேனல் பிளாக்கர்"], te: ["కాల్షియం ఛానల్ బ్లాకర్"], kn: ["ಕ್ಯಾಲ್ಸಿಯಂ ಚಾನೆಲ್ ಬ್ಲಾಕರ್"], ml: ["കാൽസ്യം ചാനൽ ബ്ലോക്കർ"], gu: ["કેલ્શિયમ ચેનલ બ્લોકર"], or: ["କ୍ୟାଲସିୟମ ଚ୍ୟାନେଲ ବ୍ଲକର"], ur: ["کیلشیم چینل بلاکر"] }),
  k("C02-C09", "ANTIHYPERTENSIVES", [...BETA_BLOCKERS, ...ACE_INHIBITORS, ...ARBS, ...CCBS, ...DIURETICS], { en: ["antihypertensive", "antihypertensives", "blood pressure medicine", "blood pressure tablet", "bp medicine", "bp tablet"], hi: ["बीपी की दवा", "रक्तचाप की दवा", "ब्लड प्रेशर की दवा"], mr: ["रक्तदाबाचे औषध", "बीपीचे औषध"], bn: ["রক্তচাপের ওষুধ", "প্রেশারের ওষুধ"], ta: ["இரத்த அழுத்த மருந்து", "பிபி மாத்திரை"], te: ["రక్తపోటు మందు", "బీపీ మాత్ర"], kn: ["ರಕ್ತದೊತ್ತಡದ ಔಷಧ", "ಬಿಪಿ ಮಾತ್ರೆ"], ml: ["രക്തസമ്മർദ്ദ മരുന്ന്", "ബിപി ഗുളിക"], gu: ["બ્લડ પ્રેશરની દવા", "બીપીની દવા"], or: ["ରକ୍ତଚାପ ଔଷଧ"], ur: ["بلڈ پریشر کی دوا"] }),
  k("C03", "DIURETICS", DIURETICS, { en: ["diuretic", "diuretics", "water tablet", "water tablets", "water pill"], hi: ["मूत्रवर्धक", "पेशाब की गोली"], mr: ["मूत्रवर्धक"], bn: ["মূত্রবর্ধক"], ta: ["சிறுநீர் பெருக்கி"], te: ["మూత్రవర్ధకం"], kn: ["ಮೂತ್ರವರ್ಧಕ"], ml: ["മൂത്രവർദ്ധിനി"], gu: ["મૂત્રવર્ધક"], or: ["ମୂତ୍ରବର୍ଦ୍ଧକ"], ur: ["پیشاب آور دوا"] }),
  k("A10B", "ORAL_GLUCOSE_LOWERING", ORAL_DIABETES, { en: ["oral hypoglycaemic", "oral hypoglycaemics", "oral hypoglycemic", "oral hypoglycemics", "diabetes tablet", "diabetes tablets", "diabetes pill", "diabetes pills", "sugar tablet", "sugar tablets", "antidiabetic", "antidiabetics"], hi: ["शुगर की गोली", "मधुमेह की दवा", "डायबिटीज़ की गोली"], mr: ["मधुमेहाची गोळी", "साखरेची गोळी"], bn: ["ডায়াবেটিসের ওষুধ", "সুগারের ট্যাবলেট"], ta: ["நீரிழிவு மாத்திரை", "சர்க்கரை மாத்திரை"], te: ["మధుమేహం మాత్ర", "షుగర్ మాత్ర"], kn: ["ಮಧುಮೇಹದ ಮಾತ್ರೆ", "ಸಕ್ಕರೆ ಮಾತ್ರೆ"], ml: ["പ്രമേഹ ഗുളിക", "ഷുഗർ ഗുളിക"], gu: ["ડાયાબિટીસની ગોળી", "સુગરની ગોળી"], or: ["ମଧୁମେହ ଔଷଧ"], ur: ["شوگر کی گولی", "ذیابیطس کی دوا"] }),
  k("A10BA", "BIGUANIDES", ["metformin"], { en: ["biguanide", "biguanides"], hi: ["बिगुआनाइड"], mr: ["बिगुआनाइड"], bn: ["বাইগুয়ানাইড"], ta: ["பைகுவானைடு"], te: ["బైగ్వానైడ్"], kn: ["ಬೈಗ್ವಾನೈಡ್"], ml: ["ബൈഗ്വാനൈഡ്"], gu: ["બાયગ્વાનાઇડ"], or: ["ବାଇଗୁଆନାଇଡ"], ur: ["بائیگوانائیڈ"] }),
  k("A10A", "INSULINS", INSULINS, { en: ["insulins", "insulin injection", "insulin injections", "insulin pen"], hi: ["इंसुलिन इंजेक्शन"], mr: ["इन्सुलिन इंजेक्शन"], bn: ["ইনসুলিন ইনজেকশন"], ta: ["இன்சுலின் ஊசி"], te: ["ఇన్సులిన్ ఇంజెక్షన్"], kn: ["ಇನ್ಸುಲಿನ್ ಚುಚ್ಚುಮದ್ದು"], ml: ["ഇൻസുലിൻ കുത്തിവയ്പ്പ്"], gu: ["ઇન્સ્યુલિન ઇન્જેક્શન"], or: ["ଇନସୁଲିନ ଇଞ୍ଜେକସନ"], ur: ["انسولین کا انجیکشن"] }),
  k("R03", "AIRWAY_INHALERS", AIRWAY, { en: ["inhaler", "inhalers", "puffer", "puffers", "pump inhaler", "nebuliser", "nebulizer", "nebulisation", "nebulization"], hi: ["इनहेलर"], mr: ["इनहेलर"], bn: ["ইনহেলার"], ta: ["இன்ஹேலர்"], te: ["ఇన్హేలర్"], kn: ["ಇನ್ಹೇಲರ್"], ml: ["ഇൻഹേലർ"], gu: ["ઇન્હેલર"], or: ["ଇନହେଲର"], ur: ["انہیلر"] }, "inhalation"),
  k("R03A", "BRONCHODILATORS", [...RELIEVERS, "tiotropium", "formoterol", "salmeterol"], { en: ["bronchodilator", "bronchodilators", "reliever", "relievers", "asthma reliever", "reliever inhaler"], hi: ["ब्रोंकोडाइलेटर", "दमे की दवा"], mr: ["ब्रॉन्कोडायलेटर", "दम्याचे औषध"], bn: ["ব্রঙ্কোডাইলেটর", "হাঁপানির ওষুধ"], ta: ["மூச்சுக்குழாய் விரிவாக்கி", "ஆஸ்துமா மருந்து"], te: ["బ్రాంకోడైలేటర్", "ఆస్తమా మందు"], kn: ["ಬ್ರಾಂಕೋಡೈಲೇಟರ್", "ಅಸ್ತಮಾ ಔಷಧ"], ml: ["ബ്രോങ്കോഡൈലേറ്റർ", "ആസ്ത്മ മരുന്ന്"], gu: ["બ્રોન્કોડાઇલેટર", "દમની દવા"], or: ["ବ୍ରଙ୍କୋଡାଇଲେଟର"], ur: ["برونکوڈائلیٹر", "دمہ کی دوا"] }),
  k("B01AA-AF", "ANTICOAGULANTS", ANTICOAGULANTS, { en: ["anticoagulant", "anticoagulants", "anticoagulation"], hi: ["थक्कारोधी"], mr: ["रक्त गोठणविरोधी"], bn: ["অ্যান্টিকোয়াগুলেন্ট"], ta: ["இரத்த உறைவு எதிர்ப்பி"], te: ["యాంటీకోయాగ్యులెంట్"], kn: ["ರಕ್ತ ಹೆಪ್ಪುರೋಧಕ"], ml: ["ആന്റികൊയാഗുലന്റ്"], gu: ["એન્ટિકોએગ્યુલન્ટ"], or: ["ଆଣ୍ଟିକୋଆଗୁଲାଣ୍ଟ"], ur: ["اینٹی کوایگولنٹ"] }),
  k("B01AC", "ANTIPLATELETS", ANTIPLATELETS, { en: ["antiplatelet", "antiplatelets"], hi: ["एंटीप्लेटलेट"], mr: ["अँटीप्लेटलेट"], bn: ["অ্যান্টিপ্লেটলেট"], ta: ["ஆன்டிபிளேட்லெட்"], te: ["యాంటీప్లేట్‌లెట్"], kn: ["ಆಂಟಿಪ್ಲೇಟ್‌ಲೆಟ್"], ml: ["ആന്റിപ്ലേറ്റ്‌ലെറ്റ്"], gu: ["એન્ટિપ્લેટલેટ"], or: ["ଆଣ୍ଟିପ୍ଲେଟଲେଟ"], ur: ["اینٹی پلیٹلیٹ"] }),
  k("B01A", "BLOOD_THINNERS", [...ANTICOAGULANTS, ...ANTIPLATELETS], { en: ["blood thinner", "blood thinners"], hi: ["खून पतला करने की दवा"], mr: ["रक्त पातळ करणारे औषध"], bn: ["রক্ত পাতলা করার ওষুধ"], ta: ["இரத்தம் மெலிதாக்கும் மருந்து"], te: ["రక్తం పలుచన చేసే మందు"], kn: ["ರಕ್ತ ತೆಳುಗೊಳಿಸುವ ಔಷಧ"], ml: ["രക്തം നേർപ്പിക്കുന്ന മരുന്ന്"], gu: ["લોહી પાતળું કરવાની દવા"], or: ["ରକ୍ତ ପତଳା କରିବା ଔଷଧ"], ur: ["خون پتلا کرنے والی دوا"] }),
  k("M01A", "NSAIDS", NSAIDS, { en: ["nsaid", "nsaids", "anti-inflammatory", "anti-inflammatories"], hi: ["एनएसएआईडी", "सूजनरोधी दवा"], mr: ["सूजविरोधी औषध"], bn: ["প্রদাহনাশক ওষুধ"], ta: ["வீக்க எதிர்ப்பு மருந்து"], te: ["వాపు నివారణ మందు"], kn: ["ಉರಿಯೂತ ನಿವಾರಕ"], ml: ["വീക്കം കുറയ്ക്കുന്ന മരുന്ന്"], gu: ["સોજો ઘટાડવાની દવા"], or: ["ପ୍ରଦାହନାଶକ ଔଷଧ"], ur: ["سوزش کش دوا"] }),
  k("N02-M01A", "PAINKILLERS", ["paracetamol", "tramadol", "morphine", ...NSAIDS], { en: ["painkiller", "painkillers", "analgesic", "analgesics", "pain medicine", "pain relief"], hi: ["दर्द निवारक", "दर्द की दवा"], mr: ["वेदनाशामक"], bn: ["ব্যথানাশক"], ta: ["வலி நிவாரணி"], te: ["నొప్పి నివారిణి"], kn: ["ನೋವು ನಿವಾರಕ"], ml: ["വേദനസംഹാരി"], gu: ["દર્દશામક", "દુખાવાની દવા"], or: ["ଯନ୍ତ୍ରଣାନାଶକ"], ur: ["درد کش", "درد کی دوا"] }),
  k("A02BC", "PROTON_PUMP_INHIBITORS", PPIS, { en: ["ppi", "ppis", "proton pump inhibitor", "proton pump inhibitors", "antacid", "antacids", "acidity medicine"], hi: ["एसिडिटी की दवा", "गैस की दवा"], mr: ["अॅसिडिटीचे औषध"], bn: ["অ্যাসিডিটির ওষুধ", "গ্যাসের ওষুধ"], ta: ["அமிலத்தன்மை மருந்து"], te: ["ఎసిడిటీ మందు"], kn: ["ಆಸಿಡಿಟಿ ಔಷಧ"], ml: ["അസിഡിറ്റി മരുന്ന്"], gu: ["એસિડિટીની દવા"], or: ["ଏସିଡିଟି ଔଷଧ"], ur: ["تیزابیت کی دوا"] }),
  k("H03AA", "THYROID_HORMONES", ["levothyroxine"], { en: ["thyroid tablet", "thyroid tablets", "thyroid hormone", "thyroxine tablet"], hi: ["थायराइड की गोली"], mr: ["थायरॉईडची गोळी"], bn: ["থাইরয়েডের ওষুধ"], ta: ["தைராய்டு மாத்திரை"], te: ["థైరాయిడ్ మాత్ర"], kn: ["ಥೈರಾಯ್ಡ್ ಮಾತ್ರೆ"], ml: ["തൈറോയ്ഡ് ഗുളിക"], gu: ["થાઇરોઇડની ગોળી"], or: ["ଥାଇରଏଡ ଔଷଧ"], ur: ["تھائیرائیڈ کی گولی"] }),
];

const VIRAMA_END = /[्্੍્୍்్್്]$/u;
const LATIN = /^[\p{Script=Latin}\p{N}\s'-]+$/u;
const words = (s: string) => s.toLowerCase().normalize("NFC").split(/[^\p{L}\p{M}\p{N}‌‍-]+/u).filter(Boolean);

/** Whether a class name occurs in a question: a Latin name as whole words, an Indic one as word starts (inflection). */
function nameIn(qWords: string[], qText: string, name: string): boolean {
  const n = words(name);
  if (!n.length) return false;
  if (LATIN.test(name)) return qText.includes(` ${n.join(" ")} `);
  const stems = n.map((w) => w.replace(VIRAMA_END, ""));
  return stems.every((s) => [...s].length >= 2 && qWords.some((w) => w === s || w.startsWith(s)));
}

/** The classes a question names, most specific first (fewest members). */
export function classesIn(question: string): MedicineClass[] {
  const qWords = words(question);
  const qText = ` ${qWords.join(" ")} `;
  return MEDICINE_CLASSES.filter((c) => Object.values(c.names).some((ns) => ns.some((n) => nameIn(qWords, qText, n)))).sort((a, b) => a.members.length - b.members.length);
}

/** The members of every class the question names (INN, lower case); empty when it names none. */
export function classMembersIn(question: string): string[] {
  return [...new Set(classesIn(question).flatMap((c) => c.members))];
}

/** Whether a chart line (a medicine order) is a member of a class: by the INN in its text, or by the class's route. */
export function lineInClass(text: string, cls: MedicineClass): boolean {
  const t = text.toLowerCase();
  return cls.members.some((m) => new RegExp(`(^|[^a-z])${m.replace(/[-]/g, "[- ]?")}([^a-z]|$)`).test(t)) || (!!cls.route && t.includes(` ${cls.route} `));
}
