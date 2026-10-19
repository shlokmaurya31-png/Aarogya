/**
 * Week 4b — the patient-facing safety rules that run before any retrieval
 * or model call (docs/RAG_DESIGN.md §9.2). PENDING CLINICAL ADVISOR: the
 * patterns and the replies (pre-launch item 2d). They err towards refusing:
 * a refusal costs a patient a "please ask your care team"; a miss could be
 * advice the product must never give.
 *
 *   URGENT     symptoms that may be an emergency → the emergency line only
 *   DIAGNOSIS  "do I have…", "is it cancer", "what is wrong with me" → refused
 *   TREATMENT  starting, stopping, changing or dosing a medicine → refused
 */
export type SafetyVerdict = "OK" | "URGENT" | "DIAGNOSIS" | "TREATMENT";

const URGENT = /\b(chest pain|can'?t breathe|cannot breathe|short(ness)? of breath|breathless|unconscious|faint(ed|ing)?|seizure|fits?\b|stroke|face droop|slurred speech|heavy bleeding|bleeding (a lot|heavily)|suicid\w*|kill myself|end my life|overdose|poison\w*|severe (pain|headache|allergic)|anaphyla\w*|swollen (throat|tongue))|सीने में दर्द|सांस नहीं|बेहोश|आत्महत्या/i;
const DIAGNOSIS = /\b(do i have|have i got|am i (diabetic|sick|ill)|is (it|this|that) (cancer|serious|dangerous|tb|tuberculosis|covid|diabetes)|what('?s| is) wrong with me|diagnos\w*|what disease|which disease|what illness|is my (condition|disease))|क्या मुझे .*(है|हो गया)|मुझे क्या बीमारी/i;
const TREATMENT = /\b(should i (stop|start|take|increase|decrease|reduce|skip|change)|can i (stop|take|skip|double|increase|reduce)|how (much|many) (should|can) i take|stop (taking|my) (the )?(medicine|tablet|drug|insulin)|increase (the|my) dose|change (the|my) (dose|medicine)|what (medicine|tablet|drug) should|is it safe to take|dose of)|दवा (बंद|छोड़|बढ़ा)|कितनी गोली/i;

export function patientSafety(question: string | undefined): SafetyVerdict {
  if (!question) return "OK";
  if (URGENT.test(question)) return "URGENT";
  if (TREATMENT.test(question)) return "TREATMENT";
  if (DIAGNOSIS.test(question)) return "DIAGNOSIS";
  return "OK";
}
