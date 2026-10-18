import { dischargeSummary, imagingReport, labReport, prescription, type LabTest, type Medicine } from "./build";
import type { DocumentFixture } from "./types";

/**
 * The synthetic evaluation set (docs/DOCUMENT_PIPELINE_DESIGN.md §10.1): 50
 * reports in the app's eleven languages (en hi mr ta bn gu te kn ml or ur;
 * Odia and Urdu added in Week 4b), 10 of them handwritten-style. Every person, doctor, registration number and facility
 * is invented; no real document was used. Expected facts are generated from
 * the same input as the report (exact by construction).
 *
 *   printed lab reports       15   en hi mr ta bn or
 *   printed prescriptions      8   en hi gu mr ur
 *   handwritten prescriptions 10   en hi mr te   (OCR misreads planted)
 *   discharge summaries        7   en hi kn ur
 *   imaging reports            5   en mr ml or
 *   mixed-language pages       5   hi+en, ta+en
 *
 * Pending clinical advisor: the reference ranges and drug regimens are
 * illustrative, not clinical guidance (docs/PRE_LAUNCH_CHECKLIST.md item 2).
 */

const t = (analyte: string, value: string, unit: string, range?: string, flag?: "H" | "L"): LabTest => ({ analyte, value, unit, range, flag });
const m = (form: Medicine["form"], name: string, dose: string, frequency: string, duration?: string): Medicine => ({ form, name, dose, frequency, duration });

const CBC = (hb: string, wbc: string, plt: string, esr: string, flagHb?: "H" | "L", flagEsr?: "H" | "L") => [
  t("Hemoglobin", hb, "g/dL", "13.0 - 17.0", flagHb), t("WBC", wbc, "/cumm", "4000 - 11000"), t("Platelet Count", plt, "x10^3/µL", "150 - 450"), t("ESR", esr, "mm/hr", "0 - 20", flagEsr),
  t("PCV", "41.5", "%", "40 - 50"), t("MCV", "88", "fL", "83 - 101"),
];
const LFT = (bili: string, sgpt: string, sgot: string, alp: string, alb: string, flagSgpt?: "H" | "L") => [
  t("Total Bilirubin", bili, "mg/dL", "0.3 - 1.2"), t("SGPT", sgpt, "U/L", "7 - 56", flagSgpt), t("SGOT", sgot, "U/L", "5 - 40"), t("ALP", alp, "U/L", "44 - 147"), t("Albumin", alb, "g/dL", "3.5 - 5.0"),
];
const KFT = (cr: string, urea: string, na: string, k: string, ua: string, flagCr?: "H" | "L") => [
  t("Creatinine", cr, "mg/dL", "0.70 - 1.30", flagCr), t("Urea", urea, "mg/dL", "15 - 45"), t("Sodium", na, "mEq/L", "135 - 145"), t("Potassium", k, "mEq/L", "3.5 - 5.1"), t("Uric Acid", ua, "mg/dL", "3.5 - 7.2"),
];
const LIPID = (tc: string, hdl: string, ldl: string, tg: string) => [
  t("Total Cholesterol", tc, "mg/dL", "< 200", Number(tc) >= 200 ? "H" : undefined), t("HDL", hdl, "mg/dL", "> 40"), t("LDL", ldl, "mg/dL", "< 100", Number(ldl) >= 100 ? "H" : undefined), t("Triglycerides", tg, "mg/dL", "< 150", Number(tg) >= 150 ? "H" : undefined),
];
const SUGAR = (a1c: string, fbs: string, ppbs: string) => [
  t("HbA1c", a1c, "%", "4.0 - 5.6", Number(a1c) > 5.6 ? "H" : undefined), t("Fasting Blood Sugar", fbs, "mg/dL", "70 - 100", Number(fbs) > 100 ? "H" : undefined), t("PPBS", ppbs, "mg/dL", "70 - 140", Number(ppbs) > 140 ? "H" : undefined),
];
const THYROID = (tsh: string, ft4: string, t3: string) => [
  t("TSH", tsh, "µIU/mL", "0.4 - 4.0", Number(tsh) > 4 ? "H" : Number(tsh) < 0.4 ? "L" : undefined), t("Free T4", ft4, "ng/dL", "0.8 - 1.8"), t("T3", t3, "ng/mL", "0.8 - 2.0"),
];

export const SAMPLES: DocumentFixture[] = [
  // ── Printed lab reports (15) ──
  labReport({ id: "lab-en-cbc", language: "en", facility: "Sunrise Diagnostics, Pune", date: "12/03/2026", patient: "Asha Verma", doctor: { name: "Dr. Meera Kulkarni", reg: "MMC-2011/04/1234" }, tests: [
    t("Hemoglobin", "11.2", "g/dL", "12.0 - 15.5", "L"), t("WBC", "7800", "/cumm", "4000 - 11000"), t("Platelet Count", "2.45", "x10^3/µL", "1.50 - 4.50"), t("ESR", "28", "mm/hr", "0 - 20", "H"),
  ] }),
  labReport({ id: "lab-en-lft", language: "en", facility: "Metro Path Labs, Bengaluru", date: "02/02/2026", patient: "Rohan Mehta", doctor: { name: "Dr. Kavita Rao", reg: "KMC-77812" }, tests: LFT("0.9", "72", "38", "110", "4.2", "H") }),
  labReport({ id: "lab-en-thyroid", language: "en", facility: "Lotus Diagnostics, Indore", date: "27/01/2026", patient: "Neha Joshi", tests: THYROID("6.8", "0.9", "1.1") }),
  labReport({ id: "lab-hi-kft", language: "hi", facility: "Ganga Pathology Lab, Varanasi", date: "05/02/2026", patient: "Ramesh Yadav", tests: [
    t("Creatinine", "1.42", "mg/dL", "0.70 - 1.30", "H"), t("Urea", "38", "mg/dL", "15 - 45"), t("Sodium", "138", "mEq/L", "135 - 145"), t("Potassium", "4.6", "mEq/L", "3.5 - 5.1"),
  ] }),
  labReport({ id: "lab-hi-sugar", language: "hi", facility: "Awadh Diagnostics, Lucknow", date: "14/03/2026", patient: "Sunil Tiwari", doctor: { name: "Dr. Alok Srivastava", reg: "UPMC-45120" }, tests: SUGAR("7.8", "142", "218") }),
  labReport({ id: "lab-hi-lipid", language: "hi", facility: "Rajdhani Labs, Jaipur", date: "08/01/2026", patient: "Pooja Sharma", tests: LIPID("214", "38", "141", "188") }),
  labReport({ id: "lab-mr-cbc", language: "mr", facility: "Swasthya Pathology, Aurangabad", date: "19/02/2026", patient: "Ganesh Pawar", tests: CBC("14.1", "9200", "310", "12") }),
  labReport({ id: "lab-mr-lft", language: "mr", facility: "Konkan Diagnostics, Ratnagiri", date: "23/03/2026", patient: "Savita Jadhav", doctor: { name: "Dr. Uday Sawant", reg: "MMC-2009/02/3301" }, tests: LFT("1.8", "41", "35", "96", "3.9") }),
  labReport({ id: "lab-mr-thyroid", language: "mr", facility: "Shivneri Labs, Pune", date: "11/02/2026", patient: "Manisha Gaikwad", tests: THYROID("0.21", "2.1", "1.9") }),
  labReport({ id: "lab-ta-kft", language: "ta", facility: "Marina Clinical Labs, Chennai", date: "04/03/2026", patient: "Karthik Raman", tests: KFT("0.98", "29", "141", "4.1", "6.4") }),
  labReport({ id: "lab-ta-sugar", language: "ta", facility: "Kongu Diagnostics, Coimbatore", date: "16/01/2026", patient: "Selvi Murugan", doctor: { name: "Dr. Prabhu Natarajan", reg: "TNMC-88214" }, tests: SUGAR("6.4", "118", "176") }),
  labReport({ id: "lab-ta-cbc", language: "ta", facility: "Vaigai Labs, Madurai", date: "29/02/2028", patient: "Anbu Selvan", tests: CBC("10.4", "13200", "512", "34", "L", "H") }),
  labReport({ id: "lab-bn-lipid", language: "bn", facility: "Hooghly Diagnostic Centre, Kolkata", date: "09/03/2026", patient: "Arindam Ghosh", tests: LIPID("182", "47", "96", "132") }),
  labReport({ id: "lab-bn-lft", language: "bn", facility: "Teesta Labs, Siliguri", date: "21/01/2026", patient: "Rupa Das", doctor: { name: "Dr. Sanjay Mukherjee", reg: "WBMC-61407" }, tests: LFT("2.4", "118", "96", "160", "3.2", "H") }),
  labReport({ id: "lab-or-thyroid", language: "or", facility: "Mahanadi Diagnostics, Cuttack", date: "06/02/2026", patient: "Sasmita Behera", tests: THYROID("3.1", "1.3", "1.4") }),

  // ── Printed prescriptions (8) ──
  prescription({ id: "rx-en-1", language: "en", facility: "Green Leaf Clinic, Nagpur", date: "15/03/2026", patient: "Vikram Singh", doctor: { name: "Dr. Ritu Bansal", reg: "MMC-2014/09/7781" }, diagnosis: "Essential Hypertension", meds: [
    m("Tab.", "Amlodipine", "5 mg", "1-0-0", "30 days"), m("Tab.", "Telmisartan", "40 mg", "1-0-0", "30 days"),
  ] }),
  prescription({ id: "rx-en-2", language: "en", facility: "City Care Clinic, Surat", date: "03/02/2026", patient: "Farah Khan", doctor: { name: "Dr. Imran Qureshi", reg: "GMC-33019" }, diagnosis: "Iron Deficiency Anaemia", allergy: "Aspirin", meds: [
    m("Tab.", "Ferrous Sulphate", "200 mg", "1-0-1", "60 days"), m("Tab.", "Folic Acid", "5 mg", "1-0-0", "60 days"),
  ] }),
  prescription({ id: "rx-en-3", language: "en", facility: "Harbour Family Practice, Kochi", date: "28/01/2026", patient: "Thomas Mathew", doctor: { name: "Dr. Anjali Menon", reg: "TCMC-55102" }, diagnosis: "Community Acquired Pneumonia", brands: ["Augmentin"], meds: [
    m("Tab.", "Augmentin", "625 mg", "1-0-1", "7 days"), m("Tab.", "Paracetamol", "500 mg", "SOS"), m("Syp.", "Ambroxol", "5 ml", "1-1-1", "5 days"),
  ] }),
  prescription({ id: "rx-hi-1", language: "hi", facility: "Seva Clinic, Patna", date: "10/03/2026", patient: "Manoj Kumar", doctor: { name: "Dr. Shalini Prasad", reg: "BMC-29874" }, diagnosis: "Type 2 Diabetes Mellitus", meds: [
    m("Tab.", "Metformin", "500 mg", "1-0-1", "30 days"), m("Tab.", "Sitagliptin", "100 mg", "1-0-0", "30 days"),
  ] }),
  prescription({ id: "rx-hi-2", language: "hi", facility: "Arogya Kendra, Bhopal", date: "22/02/2026", patient: "Geeta Devi", doctor: { name: "Dr. Rajesh Chouhan", reg: "MPMC-41177" }, diagnosis: "Acid Peptic Disease", allergy: "Ibuprofen", brands: ["Pan-D"], meds: [
    m("Cap.", "Pan-D", "40 mg", "1-0-0", "14 days"), m("Syp.", "Sucralfate", "10 ml", "1-1-1", "14 days"),
  ] }),
  prescription({ id: "rx-gu-1", language: "gu", facility: "Sabarmati Clinic, Ahmedabad", date: "18/01/2026", patient: "Hetal Patel", doctor: { name: "Dr. Nirav Shah", reg: "GMC-50231" }, diagnosis: "Hypothyroidism", meds: [m("Tab.", "Levothyroxine", "50 mcg", "1-0-0", "90 days")] }),
  prescription({ id: "rx-ur-1", language: "ur", facility: "Charminar Clinic, Hyderabad", date: "07/03/2026", patient: "Imran Siddiqui", doctor: { name: "Dr. Nazia Farooqui", reg: "TSMC-61842" }, diagnosis: "Allergic Rhinitis", brands: ["Montair"], meds: [
    m("Tab.", "Montair", "10 mg", "0-0-1", "15 days"), m("Tab.", "Cetirizine", "10 mg", "0-0-1", "5 days"),
  ] }),
  prescription({ id: "rx-mr-printed", language: "mr", facility: "Shree Clinic, Nashik", date: "21/01/2026", patient: "Sunita Patil", doctor: { name: "Dr. Prakash Joshi", reg: "MMC-2008/11/5521" }, diagnosis: "Type 2 Diabetes Mellitus", allergy: "Sulfonamides", meds: [
    m("Tab.", "Metformin", "500 mg", "1-0-1", "30 days"), m("Tab.", "Glimepiride", "1 mg", "1-0-0", "30 days"),
  ] }),

  // ── Handwritten-style prescriptions (10; OCR misreads planted) ──
  prescription({ id: "rx-hw-en-1", language: "en", handwritten: true, facility: "Rao Family Clinic, Hyderabad", date: "03/04/2026", patient: "Kiran Reddy", doctor: { name: "Dr. Srinivas Rao" }, diagnosis: "Acute Pharyngitis", brands: ["Dolo"], meds: [
    m("Cap.", "Amoxicillin", "500 mg", "1-1-1", "5 days"), m("Tab.", "Dolo", "650 mg", "SOS"),
  ], misreads: { Amoxicillin: "Amoxicilin" } }),
  prescription({ id: "rx-hw-en-2", language: "en", handwritten: true, facility: "Hill View Clinic, Shimla", date: "12/02/2026", patient: "Ankit Thakur", doctor: { name: "Dr. Neelam Verma" }, diagnosis: "Acute Gastroenteritis", meds: [
    m("Tab.", "Ondansetron", "4 mg", "1-1-1", "3 days"), m("Tab.", "Metronidazole", "400 mg", "1-1-1", "5 days"), m("Cap.", "Racecadotril", "100 mg", "1-1-1", "3 days"),
  ], misreads: { "400 mg": "4OO mg" } }),
  prescription({ id: "rx-hw-en-3", language: "en", handwritten: true, facility: "Riverside Clinic, Guwahati", date: "25/03/2026", patient: "Bikash Baruah", doctor: { name: "Dr. Dipankar Saikia" }, diagnosis: "Lumbar Spondylosis", meds: [
    m("Tab.", "Aceclofenac", "100 mg", "1-0-1", "5 days"), m("Tab.", "Thiocolchicoside", "4 mg", "1-0-1", "5 days"), m("Tab.", "Pantoprazole", "40 mg", "1-0-0", "5 days"),
  ], misreads: { Spondylosis: "Spondylosls" } }),
  prescription({ id: "rx-hw-hi-1", language: "hi", handwritten: true, facility: "Jan Seva Clinic, Kanpur", date: "09/02/2026", patient: "Rakesh Gupta", doctor: { name: "Dr. Vinod Mishra" }, diagnosis: "Viral Fever", meds: [
    m("Tab.", "Paracetamol", "650 mg", "1-1-1", "3 days"), m("Tab.", "Levocetirizine", "5 mg", "0-0-1", "5 days"),
  ], misreads: { "1-1-1": "1-l-1" } }),
  prescription({ id: "rx-hw-hi-2", language: "hi", handwritten: true, facility: "Sanjeevani Clinic, Agra", date: "17/03/2026", patient: "Kamla Devi", doctor: { name: "Dr. Suresh Agarwal" }, diagnosis: "Urinary Tract Infection", allergy: "Penicillin", meds: [
    m("Tab.", "Nitrofurantoin", "100 mg", "1-0-1", "5 days"), m("Tab.", "Cranberry Extract", "300 mg", "1-0-0", "10 days"),
  ], misreads: { Nitrofurantoin: "Nitrofurantion" } }),
  prescription({ id: "rx-hw-hi-3", language: "hi", handwritten: true, facility: "Prakash Clinic, Gwalior", date: "30/01/2026", patient: "Deepak Saxena", doctor: { name: "Dr. Mamta Joshi" }, diagnosis: "Migraine", meds: [
    m("Tab.", "Naproxen", "250 mg", "SOS"), m("Tab.", "Propranolol", "20 mg", "1-0-1", "30 days"),
  ] }),
  prescription({ id: "rx-hw-mr-1", language: "mr", handwritten: true, facility: "Dhanvantari Clinic, Satara", date: "05/03/2026", patient: "Sachin More", doctor: { name: "Dr. Archana Kale" }, diagnosis: "Acute Bronchitis", meds: [
    m("Tab.", "Azithromycin", "500 mg", "1-0-0", "3 days"), m("Syp.", "Dextromethorphan", "10 ml", "1-1-1", "5 days"),
  ], misreads: { "500 mg": "5OO mg" } }),
  prescription({ id: "rx-hw-mr-2", language: "mr", handwritten: true, facility: "Sahyadri Clinic, Sangli", date: "13/01/2026", patient: "Rekha Shinde", doctor: { name: "Dr. Mahesh Patil" }, diagnosis: "Osteoarthritis Knee", meds: [
    m("Tab.", "Diclofenac", "50 mg", "1-0-1", "7 days"), m("Tab.", "Calcium Carbonate", "500 mg", "1-0-0", "30 days"),
  ], misreads: { Diclofenac: "Diclofemac" } }),
  prescription({ id: "rx-hw-te-1", language: "te", handwritten: true, facility: "Godavari Clinic, Rajahmundry", date: "20/02/2026", patient: "Venkatesh Naidu", doctor: { name: "Dr. Lakshmi Prasanna" }, diagnosis: "Typhoid Fever", meds: [
    m("Tab.", "Cefixime", "200 mg", "1-0-1", "10 days"), m("Tab.", "Paracetamol", "650 mg", "SOS"),
  ], misreads: { Cefixime: "Cefixlme" } }),
  prescription({ id: "rx-hw-te-2", language: "te", handwritten: true, facility: "Krishna Clinic, Vijayawada", date: "26/03/2026", patient: "Padma Rani", doctor: { name: "Dr. Ravi Teja" }, diagnosis: "Hypertension", meds: [m("Tab.", "Losartan", "50 mg", "1-0-0", "30 days")] }),

  // ── Discharge summaries (7) ──
  dischargeSummary({ id: "dc-en-1", language: "en", facility: "St. Anne's Hospital, Mangaluru", date: "11/03/2026", patient: "Joseph D'Souza", doctor: { name: "Dr. Clara Pinto", reg: "KMC-60218" }, diagnosis: "Acute Appendicitis", procedure: "Laparoscopic Appendicectomy", meds: [
    m("Tab.", "Cefuroxime", "500 mg", "1-0-1", "5 days"), m("Tab.", "Paracetamol", "650 mg", "1-1-1", "3 days"),
  ] }),
  dischargeSummary({ id: "dc-en-2", language: "en", facility: "Lakeview Hospital, Udaipur", date: "24/02/2026", patient: "Kailash Meena", doctor: { name: "Dr. Sunita Rathore", reg: "RMC-38812" }, diagnosis: "Acute Myocardial Infarction", procedure: "Coronary Angioplasty", allergy: "Contrast Dye", tests: [t("Troponin I", "4.8", "ng/mL", "0 - 0.04", "H")], meds: [
    m("Tab.", "Aspirin", "75 mg", "1-0-0", "90 days"), m("Tab.", "Clopidogrel", "75 mg", "1-0-0", "90 days"), m("Tab.", "Atorvastatin", "40 mg", "0-0-1", "90 days"),
  ] }),
  dischargeSummary({ id: "dc-ur-1", language: "ur", facility: "Aligarh City Hospital, Aligarh", date: "06/01/2026", patient: "Shabana Khatoon", doctor: { name: "Dr. Tariq Ansari", reg: "UPMC-70145" }, diagnosis: "Dengue Fever", tests: [t("Platelet Count", "62", "x10^3/µL", "150 - 450", "L")], meds: [m("Tab.", "Paracetamol", "500 mg", "1-1-1", "5 days")] }),
  dischargeSummary({ id: "dc-hi-1", language: "hi", facility: "Shri Ram Hospital, Meerut", date: "15/02/2026", patient: "Om Prakash", doctor: { name: "Dr. Anita Goel", reg: "UPMC-52290" }, diagnosis: "Acute Exacerbation of COPD", tests: [t("Hemoglobin", "15.8", "g/dL", "13.0 - 17.0")], meds: [
    m("Tab.", "Prednisolone", "40 mg", "1-0-0", "5 days"), m("Tab.", "Doxofylline", "400 mg", "1-0-1", "14 days"),
  ] }),
  dischargeSummary({ id: "dc-hi-2", language: "hi", facility: "Narmada Hospital, Jabalpur", date: "02/03/2026", patient: "Savitri Bai", doctor: { name: "Dr. Pradeep Dubey", reg: "MPMC-47719" }, diagnosis: "Normal Vaginal Delivery", procedure: "Episiotomy Repair", meds: [
    m("Tab.", "Ferrous Sulphate", "200 mg", "1-0-0", "90 days"), m("Tab.", "Calcium Carbonate", "500 mg", "1-0-1", "90 days"),
  ] }),
  dischargeSummary({ id: "dc-kn", language: "kn", facility: "Cauvery Hospital, Mysuru", date: "14/02/2026", patient: "Lakshmi Gowda", doctor: { name: "Dr. Anil Hegde", reg: "KMC-45512" }, diagnosis: "Acute Calculous Cholecystitis", procedure: "Laparoscopic Cholecystectomy", allergy: "Penicillin",
    tests: [t("Total Bilirubin", "1.1", "mg/dL", "0.3 - 1.2")],
    meds: [m("Tab.", "Paracetamol", "650 mg", "1-1-1", "3 days"), m("Tab.", "Pantoprazole", "40 mg", "1-0-0", "7 days")] }),
  dischargeSummary({ id: "dc-kn-2", language: "kn", facility: "Tunga Hospital, Shivamogga", date: "19/03/2026", patient: "Manjunath Shetty", doctor: { name: "Dr. Rekha Bhat", reg: "KMC-58830" }, diagnosis: "Diabetic Foot Ulcer", procedure: "Wound Debridement", tests: [t("HbA1c", "9.4", "%", "4.0 - 5.6", "H")], meds: [
    m("Tab.", "Linezolid", "600 mg", "1-0-1", "10 days"), m("Inj.", "Insulin Glargine", "18 units", "0-0-1", "30 days"),
  ] }),

  // ── Imaging reports (5) ──
  imagingReport({ id: "img-en-xray", language: "en", facility: "Clear View Imaging, Chandigarh", date: "08/03/2026", patient: "Harpreet Kaur", doctor: { name: "Dr. Gurpreet Sandhu", reg: "PMC-30981" }, procedure: "X-Ray Chest PA View", impression: "Right lower zone consolidation" }),
  imagingReport({ id: "img-or-ct", language: "or", facility: "Kalinga Scan Centre, Bhubaneswar", date: "17/02/2026", patient: "Ashok Mohanty", doctor: { name: "Dr. Neha Panda", reg: "OMC-12764" }, procedure: "CT Brain Plain", impression: "No acute intracranial abnormality" }),
  imagingReport({ id: "img-mr-usg", language: "mr", facility: "Sahyadri Imaging Centre, Kolhapur", date: "09/03/2026", patient: "Vijay Shinde", doctor: { name: "Dr. Neha Deshpande", reg: "MMC-2015/07/8890" }, procedure: "USG Abdomen and Pelvis", impression: "Grade I fatty liver" }),
  imagingReport({ id: "img-mr-mri", language: "mr", facility: "Godavari Imaging, Nanded", date: "27/01/2026", patient: "Prakash Wagh", doctor: { name: "Dr. Swati Kulkarni", reg: "MMC-2012/03/6620" }, procedure: "MRI Lumbosacral Spine", impression: "L4-L5 disc bulge" }),
  imagingReport({ id: "img-ml-usg", language: "ml", facility: "Periyar Imaging Centre, Thrissur", date: "13/03/2026", patient: "Anitha Nair", doctor: { name: "Dr. Suresh Pillai", reg: "TCMC-61930" }, procedure: "USG Thyroid", impression: "Multinodular goitre" }),

  // ── Mixed-language pages (5) ──
  labReport({ id: "mixed-hi-cbc", language: "hi", mixed: true, facility: "Doaba Labs, Ludhiana", date: "01/03/2026", patient: "Gurdeep Singh", tests: CBC("12.6", "6400", "228", "18", "L") }),
  prescription({ id: "mixed-hi-rx", language: "hi", mixed: true, facility: "Sangam Clinic, Prayagraj", date: "12/01/2026", patient: "Neelam Pandey", doctor: { name: "Dr. Ashutosh Tripathi", reg: "UPMC-60213" }, diagnosis: "Vitamin D Deficiency", meds: [
    m("Cap.", "Cholecalciferol", "60000 IU", "WEEKLY", "8 weeks"),
  ] }),
  dischargeSummary({ id: "mixed-hi-dc", language: "hi", mixed: true, facility: "Yamuna Hospital, Mathura", date: "20/03/2026", patient: "Radha Krishnan", doctor: { name: "Dr. Kiran Bhatt", reg: "UPMC-58841" }, diagnosis: "Cellulitis Left Leg", meds: [m("Tab.", "Cephalexin", "500 mg", "1-1-1", "7 days")] }),
  labReport({ id: "mixed-ta-lipid", language: "ta", mixed: true, facility: "Kaveri Labs, Chennai", date: "18/01/2026", patient: "Meenakshi Sundaram", tests: [
    t("Total Cholesterol", "232", "mg/dL", "< 200", "H"), t("HDL", "41", "mg/dL", "> 40"), t("LDL", "158", "mg/dL", "< 100", "H"), t("Triglycerides", "165", "mg/dL", "< 150", "H"),
  ] }),
  prescription({ id: "mixed-ta-rx", language: "ta", mixed: true, facility: "Cauvery Clinic, Tiruchirappalli", date: "04/02/2026", patient: "Ravi Chandran", doctor: { name: "Dr. Malathi Srinivasan", reg: "TNMC-73390" }, diagnosis: "Bronchial Asthma", meds: [
    m("Tab.", "Montelukast", "10 mg", "0-0-1", "30 days"), m("Tab.", "Theophylline", "300 mg", "0-0-1", "30 days"),
  ] }),
];
