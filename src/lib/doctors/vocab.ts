/**
 * Week 5a — the doctor network's closed lists (docs/DOCTOR_NETWORK_DESIGN.md §3,
 * §6.2). Codes are stored; labels are shown. The symptom map is seeded from
 * SYMPTOM_SEED as version 1, every row "pending clinical advisor" until a
 * named clinical advisor signs it off (docs/PRE_LAUNCH_CHECKLIST.md item 2).
 */

/** The fixed specialty list (NMC broad specialties, as patients search for them). */
export const SPECIALTIES = {
  GENERAL_MEDICINE: "General physician",
  FAMILY_MEDICINE: "Family medicine",
  PAEDIATRICS: "Child specialist (paediatrics)",
  OBSTETRICS_GYNAECOLOGY: "Women's health (obstetrics and gynaecology)",
  ORTHOPAEDICS: "Bones and joints (orthopaedics)",
  CARDIOLOGY: "Heart (cardiology)",
  DERMATOLOGY: "Skin (dermatology)",
  ENT: "Ear, nose and throat (ENT)",
  OPHTHALMOLOGY: "Eyes (ophthalmology)",
  PSYCHIATRY: "Mental health (psychiatry)",
  NEUROLOGY: "Brain and nerves (neurology)",
  GASTROENTEROLOGY: "Stomach and liver (gastroenterology)",
  PULMONOLOGY: "Lungs (pulmonology)",
  NEPHROLOGY: "Kidneys (nephrology)",
  UROLOGY: "Urinary tract (urology)",
  ENDOCRINOLOGY: "Diabetes and hormones (endocrinology)",
  GENERAL_SURGERY: "General surgery",
  DENTISTRY: "Teeth (dentistry)",
  ONCOLOGY: "Cancer (oncology)",
  RHEUMATOLOGY: "Arthritis and immune joints (rheumatology)",
} as const;
export type Specialty = keyof typeof SPECIALTIES;
export const SPECIALTY_CODES = Object.keys(SPECIALTIES) as Specialty[];
/** Always offered beside a symptom search's results. */
export const FALLBACK_SPECIALTY: Specialty = "GENERAL_MEDICINE";

/** State medical councils (and the NMC's national register). */
export const STATE_COUNCILS = {
  NMC: "National Medical Commission",
  APMC: "Andhra Pradesh Medical Council", ASMC: "Assam Medical Council", BMC: "Bihar Medical Council", CGMC: "Chhattisgarh Medical Council",
  DMC: "Delhi Medical Council", GOAMC: "Goa Medical Council", GMC: "Gujarat Medical Council", HMC: "Haryana Medical Council",
  HPMC: "Himachal Pradesh Medical Council", JKMC: "Jammu and Kashmir Medical Council", JMC: "Jharkhand Medical Council",
  KMC: "Karnataka Medical Council", TCMC: "Travancore-Cochin (Kerala) Medical Council", MPMC: "Madhya Pradesh Medical Council",
  MMC: "Maharashtra Medical Council", OCMR: "Odisha Council of Medical Registration", PMC: "Punjab Medical Council",
  RMC: "Rajasthan Medical Council", SMC: "Sikkim Medical Council", TNMC: "Tamil Nadu Medical Council", TSMC: "Telangana State Medical Council",
  TRMC: "Tripura Medical Council", UPMC: "Uttar Pradesh Medical Council", UKMC: "Uttarakhand Medical Council", WBMC: "West Bengal Medical Council",
} as const;
export type StateCouncil = keyof typeof STATE_COUNCILS;

export const DEGREES = { MBBS: "MBBS", MD: "MD", MS: "MS", DNB: "DNB", DM: "DM", MCH: "MCh", BDS: "BDS", MDS: "MDS", DIPLOMA: "Diploma" } as const;
export type Degree = keyof typeof DEGREES;

/** The app's languages (a doctor consults in some of them). */
export const LANGUAGES = ["en", "hi", "bn", "te", "mr", "ta", "ur", "gu", "kn", "ml", "or", "pa"] as const;

/** Why a verification case was rejected or needs more (closed codes; no free text reaches the doctor's profile). */
export const VERIFICATION_REASONS = ["NOT_ON_REGISTER", "NAME_MISMATCH", "DOCUMENT_UNREADABLE", "REGISTRATION_SUSPENDED", "DUPLICATE_PROFILE", "MORE_DOCUMENTS_NEEDED", "OTHER"] as const;
export type VerificationReason = (typeof VERIFICATION_REASONS)[number];

/** The 48-hour review target for a verification case. */
export const VERIFICATION_TARGET_HOURS = 48;

/**
 * The seeded symptom → specialty map (version 1): ~50 everyday symptoms, each
 * to one or two specialties. PENDING CLINICAL ADVISOR: not clinical advice;
 * a general physician is always offered too.
 */
export const SYMPTOM_SEED: { code: string; label: string; specialties: Specialty[] }[] = [
  { code: "FEVER", label: "Fever", specialties: ["GENERAL_MEDICINE"] },
  { code: "COUGH", label: "Cough", specialties: ["GENERAL_MEDICINE", "PULMONOLOGY"] },
  { code: "COLD", label: "Cold or runny nose", specialties: ["GENERAL_MEDICINE", "ENT"] },
  { code: "SORE_THROAT", label: "Sore throat", specialties: ["ENT", "GENERAL_MEDICINE"] },
  { code: "BREATHLESSNESS", label: "Breathlessness", specialties: ["PULMONOLOGY", "CARDIOLOGY"] },
  { code: "WHEEZING", label: "Wheezing", specialties: ["PULMONOLOGY"] },
  { code: "CHEST_PAIN", label: "Chest pain", specialties: ["CARDIOLOGY"] },
  { code: "PALPITATIONS", label: "Palpitations", specialties: ["CARDIOLOGY"] },
  { code: "HIGH_BP", label: "High blood pressure", specialties: ["CARDIOLOGY", "GENERAL_MEDICINE"] },
  { code: "HEADACHE", label: "Headache", specialties: ["NEUROLOGY", "GENERAL_MEDICINE"] },
  { code: "DIZZINESS", label: "Dizziness", specialties: ["NEUROLOGY", "ENT"] },
  { code: "SEIZURE", label: "Fits or seizures", specialties: ["NEUROLOGY"] },
  { code: "NUMBNESS", label: "Numbness or tingling", specialties: ["NEUROLOGY"] },
  { code: "BACK_PAIN", label: "Back pain", specialties: ["ORTHOPAEDICS"] },
  { code: "KNEE_PAIN", label: "Knee pain", specialties: ["ORTHOPAEDICS", "RHEUMATOLOGY"] },
  { code: "JOINT_PAIN", label: "Joint pain or swelling", specialties: ["RHEUMATOLOGY", "ORTHOPAEDICS"] },
  { code: "NECK_PAIN", label: "Neck pain", specialties: ["ORTHOPAEDICS"] },
  { code: "FRACTURE", label: "Suspected broken bone", specialties: ["ORTHOPAEDICS"] },
  { code: "SPRAIN", label: "Sprain or twisted ankle", specialties: ["ORTHOPAEDICS"] },
  { code: "STOMACH_PAIN", label: "Stomach pain", specialties: ["GASTROENTEROLOGY", "GENERAL_MEDICINE"] },
  { code: "ACIDITY", label: "Acidity or heartburn", specialties: ["GASTROENTEROLOGY"] },
  { code: "VOMITING", label: "Vomiting", specialties: ["GASTROENTEROLOGY", "GENERAL_MEDICINE"] },
  { code: "DIARRHOEA", label: "Loose motions", specialties: ["GASTROENTEROLOGY", "GENERAL_MEDICINE"] },
  { code: "CONSTIPATION", label: "Constipation", specialties: ["GASTROENTEROLOGY"] },
  { code: "JAUNDICE", label: "Yellow eyes or skin (jaundice)", specialties: ["GASTROENTEROLOGY"] },
  { code: "BLOOD_IN_STOOL", label: "Blood in stool", specialties: ["GASTROENTEROLOGY", "GENERAL_SURGERY"] },
  { code: "BURNING_URINE", label: "Burning while passing urine", specialties: ["UROLOGY", "GENERAL_MEDICINE"] },
  { code: "KIDNEY_STONE", label: "Kidney stone pain", specialties: ["UROLOGY", "NEPHROLOGY"] },
  { code: "SWELLING_FEET", label: "Swelling of the feet", specialties: ["NEPHROLOGY", "CARDIOLOGY"] },
  { code: "FREQUENT_URINATION", label: "Passing urine often", specialties: ["UROLOGY", "ENDOCRINOLOGY"] },
  { code: "HIGH_SUGAR", label: "High blood sugar", specialties: ["ENDOCRINOLOGY", "GENERAL_MEDICINE"] },
  { code: "THYROID", label: "Thyroid problem", specialties: ["ENDOCRINOLOGY"] },
  { code: "WEIGHT_CHANGE", label: "Unexplained weight change", specialties: ["ENDOCRINOLOGY", "GENERAL_MEDICINE"] },
  { code: "TIREDNESS", label: "Tiredness", specialties: ["GENERAL_MEDICINE"] },
  { code: "SKIN_RASH", label: "Skin rash", specialties: ["DERMATOLOGY"] },
  { code: "ITCHING", label: "Itching", specialties: ["DERMATOLOGY"] },
  { code: "ACNE", label: "Acne", specialties: ["DERMATOLOGY"] },
  { code: "HAIR_LOSS", label: "Hair loss", specialties: ["DERMATOLOGY"] },
  { code: "EAR_PAIN", label: "Ear pain", specialties: ["ENT"] },
  { code: "HEARING_LOSS", label: "Hearing loss", specialties: ["ENT"] },
  { code: "BLURRED_VISION", label: "Blurred vision", specialties: ["OPHTHALMOLOGY"] },
  { code: "RED_EYE", label: "Red or painful eye", specialties: ["OPHTHALMOLOGY"] },
  { code: "TOOTHACHE", label: "Toothache", specialties: ["DENTISTRY"] },
  { code: "BLEEDING_GUMS", label: "Bleeding gums", specialties: ["DENTISTRY"] },
  { code: "MISSED_PERIOD", label: "Missed period", specialties: ["OBSTETRICS_GYNAECOLOGY"] },
  { code: "PREGNANCY_CARE", label: "Pregnancy check-up", specialties: ["OBSTETRICS_GYNAECOLOGY"] },
  { code: "PERIOD_PAIN", label: "Painful or heavy periods", specialties: ["OBSTETRICS_GYNAECOLOGY"] },
  { code: "CHILD_FEVER", label: "Fever in a child", specialties: ["PAEDIATRICS"] },
  { code: "CHILD_VACCINATION", label: "Child vaccination", specialties: ["PAEDIATRICS"] },
  { code: "LOW_MOOD", label: "Low mood or sadness", specialties: ["PSYCHIATRY"] },
  { code: "ANXIETY", label: "Anxiety or worry", specialties: ["PSYCHIATRY"] },
  { code: "SLEEP_PROBLEMS", label: "Trouble sleeping", specialties: ["PSYCHIATRY", "GENERAL_MEDICINE"] },
  { code: "LUMP", label: "A new lump", specialties: ["GENERAL_SURGERY", "ONCOLOGY"] },
  { code: "WOUND", label: "A wound that won't heal", specialties: ["GENERAL_SURGERY", "ENDOCRINOLOGY"] },
];
