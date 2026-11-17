/**
 * Flagship 5 (6a/6b) — the strings a page's shell needs (theme, toasts, the
 * patient app's navigation, sign-out, language picker and skip link), in all
 * eleven app languages, apart from the full dictionary in ./i18n (≈ 490 KB):
 * the patient app loads only this. ./i18n includes these too, so translate()
 * works for every key as before. The patient-app strings are machine
 * translations awaiting native review (docs/MOBILE_ACCESSIBILITY.md §3).
 */
export type LanguageCode = "en" | "hi" | "bn" | "mr" | "te" | "ta" | "gu" | "ur" | "kn" | "or" | "ml";

export const LANGUAGES: { code: LanguageCode; label: string; nativeLabel: string }[] = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
  { code: "bn", label: "Bengali", nativeLabel: "বাংলা" },
  { code: "mr", label: "Marathi", nativeLabel: "मराठी" },
  { code: "te", label: "Telugu", nativeLabel: "తెలుగు" },
  { code: "ta", label: "Tamil", nativeLabel: "தமிழ்" },
  { code: "gu", label: "Gujarati", nativeLabel: "ગુજરાતી" },
  { code: "ur", label: "Urdu", nativeLabel: "اردو" },
  { code: "kn", label: "Kannada", nativeLabel: "ಕನ್ನಡ" },
  { code: "or", label: "Odia", nativeLabel: "ଓଡ଼ିଆ" },
  { code: "ml", label: "Malayalam", nativeLabel: "മലയാളം" },
];

type Translation = Partial<Record<LanguageCode, string>> & { en: string };

export const SHELL_TRANSLATIONS: Record<string, Translation> = {
  "settings.theme.light": { en: "Light", hi: "लाइट", bn: "লাইট", mr: "लाइट", te: "లైట్", ta: "லைட்", gu: "લાઇટ", ur: "لائٹ", kn: "ಲೈಟ್", or: "ଲାଇଟ", ml: "ലൈറ്റ്" },
  "settings.theme.dark": { en: "Dark", hi: "डार्क", bn: "ডার্ক", mr: "डार्क", te: "డార్క్", ta: "டார்க்", gu: "ડાર્ક", ur: "ڈارک", kn: "ಡಾರ್ಕ್", or: "ଡାର୍କ", ml: "ഡാർക്ക്" },
  "theme.switchToLight": { en: "Switch to light theme", hi: "लाइट थीम पर स्विच करें", bn: "লাইট থিমে স্যুইচ করুন", mr: "लाइट थीमवर स्विच करा", te: "లైట్ థీమ్‌కు మారండి", ta: "லைட் தீமிற்கு மாறவும்", gu: "લાઇટ થીમ પર સ્વિચ કરો", ur: "لائٹ تھیم پر جائیں", kn: "ಲೈಟ್ ಥೀಮ್‌ಗೆ ಬದಲಿಸಿ", or: "ଲାଇଟ ଥିମକୁ ସ୍ୱିଚ କରନ୍ତୁ", ml: "ലൈറ്റ് തീമിലേക്ക് മാറുക" },
  "theme.switchToDark": { en: "Switch to dark theme", hi: "डार्क थीम पर स्विच करें", bn: "ডার্ক থিমে স্যুইচ করুন", mr: "डार्क थीमवर स्विच करा", te: "డార్క్ థీమ్‌కు మారండి", ta: "டார்க் தீமிற்கு மாறவும்", gu: "ડાર્ક થીમ પર સ્વિચ કરો", ur: "ڈارک تھیم پر جائیں", kn: "ಡಾರ್ಕ್ ಥೀಮ್‌ಗೆ ಬದಲಿಸಿ", or: "ଡାର୍କ ଥିମକୁ ସ୍ୱିଚ କରନ୍ତୁ", ml: "ഡാർക്ക് തീമിലേക്ക് മാറുക" },
  "common.dismiss": { en: "Dismiss", hi: "खारिज करें", bn: "খারিজ করুন", mr: "रद्द करा", te: "తీసివేయండి", ta: "நிராகரி", gu: "રદ કરો", ur: "برخاست کریں", kn: "ವಜಾಗೊಳಿಸಿ", or: "ଖାରଜ କରନ୍ତୁ", ml: "നിരസിക്കുക" },
  // Flagship 5 (6b): the patient app's shell and control names, in every app language (machine translations, for native review: docs/MOBILE_ACCESSIBILITY.md §3).
  "patient.nav.label": { en: "Main menu", hi: "मुख्य मेनू", bn: "প্রধান মেনু", mr: "मुख्य मेनू", te: "ప్రధాన మెనూ", ta: "முதன்மை மெனு", gu: "મુખ્ય મેનૂ", ur: "مرکزی مینو", kn: "ಮುಖ್ಯ ಮೆನು", or: "ମୁଖ୍ୟ ମେନୁ", ml: "പ്രധാന മെനു" },
  "patient.nav.home": { en: "Home", hi: "होम", bn: "হোম", mr: "मुख्यपृष्ठ", te: "హోమ్", ta: "முகப்பு", gu: "હોમ", ur: "ہوم", kn: "ಮುಖಪುಟ", or: "ମୂଳପୃଷ୍ଠା", ml: "ഹോം" },
  "patient.nav.appointments": { en: "Appointments", hi: "अपॉइंटमेंट", bn: "অ্যাপয়েন্টমেন্ট", mr: "अपॉइंटमेंट", te: "అపాయింట్‌మెంట్‌లు", ta: "சந்திப்புகள்", gu: "એપોઇન્ટમેન્ટ", ur: "اپائنٹمنٹس", kn: "ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್‌ಗಳು", or: "ଆପଏଣ୍ଟମେଣ୍ଟ", ml: "അപ്പോയിന്റ്മെന്റുകൾ" },
  "patient.nav.doctors": { en: "Find a doctor", hi: "डॉक्टर खोजें", bn: "ডাক্তার খুঁজুন", mr: "डॉक्टर शोधा", te: "డాక్టర్‌ను వెతకండి", ta: "மருத்துவரைத் தேடுங்கள்", gu: "ડૉક્ટર શોધો", ur: "ڈاکٹر تلاش کریں", kn: "ವೈದ್ಯರನ್ನು ಹುಡುಕಿ", or: "ଡାକ୍ତର ଖୋଜନ୍ତୁ", ml: "ഡോക്ടറെ കണ്ടെത്തുക" },
  "patient.nav.household": { en: "Household", hi: "घर के सदस्य", bn: "পরিবারের সদস্য", mr: "घरातील सदस्य", te: "ఇంటి సభ్యులు", ta: "குடும்ப உறுப்பினர்கள்", gu: "ઘરના સભ્યો", ur: "گھر کے افراد", kn: "ಮನೆಯ ಸದಸ್ಯರು", or: "ଘରର ସଦସ୍ୟ", ml: "വീട്ടിലെ അംഗങ്ങൾ" },
  "patient.nav.queue": { en: "Queue", hi: "कतार", bn: "সারি", mr: "रांग", te: "క్యూ", ta: "வரிசை", gu: "કતાર", ur: "قطار", kn: "ಸರತಿ", or: "ଧାଡ଼ି", ml: "ക്യൂ" },
  "patient.nav.share": { en: "Share access", hi: "पहुँच साझा करें", bn: "অ্যাক্সেস শেয়ার করুন", mr: "प्रवेश शेअर करा", te: "యాక్సెస్ షేర్ చేయండి", ta: "அணுகலைப் பகிருங்கள்", gu: "ઍક્સેસ શેર કરો", ur: "رسائی شیئر کریں", kn: "ಪ್ರವೇಶ ಹಂಚಿಕೊಳ್ಳಿ", or: "ପ୍ରବେଶ ସେୟାର କରନ୍ତୁ", ml: "ആക്സസ് പങ്കിടുക" },
  "patient.nav.records": { en: "Records", hi: "रिकॉर्ड", bn: "রেকর্ড", mr: "नोंदी", te: "రికార్డులు", ta: "பதிவுகள்", gu: "રેકોર્ડ", ur: "ریکارڈ", kn: "ದಾಖಲೆಗಳು", or: "ରେକର୍ଡ", ml: "റെക്കോർഡുകൾ" },
  "patient.nav.reports": { en: "Reports", hi: "रिपोर्ट", bn: "রিপোর্ট", mr: "अहवाल", te: "నివేదికలు", ta: "அறிக்கைகள்", gu: "રિપોર્ટ", ur: "رپورٹس", kn: "ವರದಿಗಳು", or: "ରିପୋର୍ଟ", ml: "റിപ്പോർട്ടുകൾ" },
  "patient.nav.documents": { en: "My documents", hi: "मेरे दस्तावेज़", bn: "আমার নথি", mr: "माझी कागदपत्रे", te: "నా పత్రాలు", ta: "எனது ஆவணங்கள்", gu: "મારા દસ્તાવેજો", ur: "میری دستاویزات", kn: "ನನ್ನ ಡಾಕ್ಯುಮೆಂಟ್‌ಗಳು", or: "ମୋ ଦଲିଲ", ml: "എന്റെ രേഖകൾ" },
  "patient.nav.medications": { en: "Medicines", hi: "दवाइयाँ", bn: "ওষুধ", mr: "औषधे", te: "మందులు", ta: "மருந்துகள்", gu: "દવાઓ", ur: "ادویات", kn: "ಔಷಧಗಳು", or: "ଔଷଧ", ml: "മരുന്നുകൾ" },
  "patient.nav.billing": { en: "Bills", hi: "बिल", bn: "বিল", mr: "बिले", te: "బిల్లులు", ta: "கட்டணங்கள்", gu: "બિલ", ur: "بل", kn: "ಬಿಲ್‌ಗಳು", or: "ବିଲ୍", ml: "ബില്ലുകൾ" },
  "patient.nav.insurance": { en: "Insurance", hi: "बीमा", bn: "বিমা", mr: "विमा", te: "బీమా", ta: "காப்பீடு", gu: "વીમો", ur: "بیمہ", kn: "ವಿಮೆ", or: "ବୀମା", ml: "ഇൻഷുറൻസ്" },
  "patient.nav.consent": { en: "Consent", hi: "सहमति", bn: "সম্মতি", mr: "संमती", te: "సమ్మతి", ta: "ஒப்புதல்", gu: "સંમતિ", ur: "رضامندی", kn: "ಸಮ್ಮತಿ", or: "ସମ୍ମତି", ml: "സമ്മതം" },
  "patient.nav.family": { en: "Family", hi: "परिवार", bn: "পরিবার", mr: "कुटुंब", te: "కుటుంబం", ta: "குடும்பம்", gu: "પરિવાર", ur: "خاندان", kn: "ಕುಟುಂಬ", or: "ପରିବାର", ml: "കുടുംബം" },
  "patient.nav.profile": { en: "Profile", hi: "प्रोफ़ाइल", bn: "প্রোফাইল", mr: "प्रोफाइल", te: "ప్రొఫైల్", ta: "சுயவிவரம்", gu: "પ્રોફાઇલ", ur: "پروفائل", kn: "ಪ್ರೊಫೈಲ್", or: "ପ୍ରୋଫାଇଲ୍", ml: "പ്രൊഫൈൽ" },
  "patient.signOut": { en: "Sign out", hi: "लॉग आउट", bn: "লগ আউট", mr: "लॉग आउट", te: "లాగ్ అవుట్", ta: "வெளியேறு", gu: "લોગ આઉટ", ur: "لاگ آؤٹ", kn: "ಲಾಗ್ ಔಟ್", or: "ଲଗ ଆଉଟ", ml: "ലോഗ് ഔട്ട്" },
  "patient.language": { en: "Language", hi: "भाषा", bn: "ভাষা", mr: "भाषा", te: "భాష", ta: "மொழி", gu: "ભાષા", ur: "زبان", kn: "ಭಾಷೆ", or: "ଭାଷା", ml: "ഭാഷ" },
  "patient.skip": { en: "Skip to main content", hi: "मुख्य सामग्री पर जाएँ", bn: "মূল বিষয়বস্তুতে যান", mr: "मुख्य मजकुराकडे जा", te: "ప్రధాన కంటెంట్‌కు వెళ్ళండి", ta: "முதன்மை உள்ளடக்கத்திற்குச் செல்லவும்", gu: "મુખ્ય સામગ્રી પર જાઓ", ur: "مرکزی مواد پر جائیں", kn: "ಮುಖ್ಯ ವಿಷಯಕ್ಕೆ ಹೋಗಿ", or: "ମୁଖ୍ୟ ବିଷୟବସ୍ତୁକୁ ଯାଆନ୍ତୁ", ml: "പ്രധാന ഉള്ളടക്കത്തിലേക്ക് പോകുക" },
};

export function translateShell(key: string, lang: LanguageCode): string {
  const entry = SHELL_TRANSLATIONS[key];
  if (!entry) return key;
  return entry[lang] ?? entry.en;
}
