import { dischargeSummary, imagingReport, labReport, prescription } from "./build";
import type { DocumentFixture } from "./types";

/**
 * The synthetic samples. Every person, doctor, registration number and
 * facility is invented.
 */
export const SAMPLES: DocumentFixture[] = [
  labReport({
    id: "lab-en-cbc", language: "en", facility: "Sunrise Diagnostics, Pune", date: "12/03/2026", patient: "Asha Verma",
    doctor: { name: "Dr. Meera Kulkarni", reg: "MMC-2011/04/1234" },
    tests: [
      { analyte: "Hemoglobin", value: "11.2", unit: "g/dL", range: "12.0 - 15.5", flag: "L" },
      { analyte: "WBC", value: "7800", unit: "/cumm", range: "4000 - 11000" },
      { analyte: "Platelet Count", value: "2.45", unit: "x10^3/µL", range: "1.50 - 4.50" },
      { analyte: "ESR", value: "28", unit: "mm/hr", range: "0 - 20", flag: "H" },
    ],
  }),
  labReport({
    id: "lab-hi-kft", language: "hi", facility: "Ganga Pathology Lab, Varanasi", date: "05/02/2026", patient: "Ramesh Yadav",
    tests: [
      { analyte: "Creatinine", value: "1.42", unit: "mg/dL", range: "0.70 - 1.30", flag: "H" },
      { analyte: "Urea", value: "38", unit: "mg/dL", range: "15 - 45" },
      { analyte: "Sodium", value: "138", unit: "mEq/L", range: "135 - 145" },
      { analyte: "Potassium", value: "4.6", unit: "mEq/L", range: "3.5 - 5.1" },
    ],
  }),
  prescription({
    id: "rx-mr-printed", language: "mr", facility: "Shree Clinic, Nashik", date: "21/01/2026", patient: "Sunita Patil",
    doctor: { name: "Dr. Prakash Joshi", reg: "MMC-2008/11/5521" }, diagnosis: "Type 2 Diabetes Mellitus", allergy: "Sulfonamides",
    meds: [
      { form: "Tab.", name: "Metformin", dose: "500 mg", frequency: "1-0-1", duration: "30 days" },
      { form: "Tab.", name: "Glimepiride", dose: "1 mg", frequency: "1-0-0", duration: "30 days" },
    ],
  }),
  prescription({
    id: "rx-hw-en-1", language: "en", handwritten: true, facility: "Rao Family Clinic, Hyderabad", date: "03/04/2026", patient: "Kiran Reddy",
    doctor: { name: "Dr. Srinivas Rao" }, diagnosis: "Acute Pharyngitis", brands: ["Dolo"],
    meds: [
      { form: "Cap.", name: "Amoxicillin", dose: "500 mg", frequency: "1-1-1", duration: "5 days" },
      { form: "Tab.", name: "Dolo", dose: "650 mg", frequency: "SOS" },
    ],
    misreads: { Amoxicillin: "Amoxicilin" },
  }),
  dischargeSummary({
    id: "dc-kn", language: "kn", facility: "Cauvery Hospital, Mysuru", date: "14/02/2026", patient: "Lakshmi Gowda",
    doctor: { name: "Dr. Anil Hegde", reg: "KMC-45512" }, diagnosis: "Acute Calculous Cholecystitis", procedure: "Laparoscopic Cholecystectomy", allergy: "Penicillin",
    tests: [{ analyte: "Total Bilirubin", value: "1.1", unit: "mg/dL", range: "0.3 - 1.2" }],
    meds: [{ form: "Tab.", name: "Paracetamol", dose: "650 mg", frequency: "1-1-1", duration: "3 days" }, { form: "Tab.", name: "Pantoprazole", dose: "40 mg", frequency: "1-0-0", duration: "7 days" }],
  }),
  imagingReport({
    id: "img-mr-usg", language: "mr", facility: "Sahyadri Imaging Centre, Kolhapur", date: "09/03/2026", patient: "Vijay Shinde",
    doctor: { name: "Dr. Neha Deshpande", reg: "MMC-2015/07/8890" }, procedure: "USG Abdomen and Pelvis", impression: "Grade I fatty liver",
  }),
  labReport({
    id: "mixed-ta-lipid", language: "ta", mixed: true, facility: "Kaveri Labs, Chennai", date: "18/01/2026", patient: "Meenakshi Sundaram",
    tests: [
      { analyte: "Total Cholesterol", value: "232", unit: "mg/dL", range: "< 200", flag: "H" },
      { analyte: "HDL", value: "41", unit: "mg/dL", range: "> 40" },
      { analyte: "LDL", value: "158", unit: "mg/dL", range: "< 100", flag: "H" },
      { analyte: "Triglycerides", value: "165", unit: "mg/dL", range: "< 150", flag: "H" },
    ],
  }),
];
