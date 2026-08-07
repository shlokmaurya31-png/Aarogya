import type {
  Appointment,
  BodySystem,
  EmergencyContact,
  HospitalBedAvailability,
  InsuranceClaim,
  LabResult,
  NotificationItem,
  PatientProfile,
  Prescription,
  ReportDoc,
  TimelineEvent,
  VitalSeries,
} from "@/types";

export const doctorProfile = {
  name: "Dr. Rakesh Sharma",
  specialty: "Cardiology",
  qualification: "MBBS, MD (Cardiology), DM (Cardiology)",
  facility: "Fortis Hospital, Pune",
  registrationId: "MCI-MH-48213",
  avatarInitials: "RS",
};

export const patient: PatientProfile = {
  name: "Meera Kulkarni",
  patientId: "AAR-2941-7053",
  hospitalId: "FMH-PUN-0231",
  age: 42,
  gender: "Female",
  height: "162 cm",
  weight: "68 kg",
  bloodGroup: "B+",
  allergies: ["Penicillin", "Peanuts"],
  insurance: "Star Health (Family Optima)",
  emergencyContact: "Arjun Kulkarni · +91 98220 XXXXX",
  abhaNumber: "91-4821-6620-1147",
  aadhaarLinked: true,
  ayushmanBharat: "enrolled",
  avatarInitials: "MK",
  tpa: {
    name: "Medi Assist Insurance TPA",
    healthCardId: "MAI-2941-77053",
    policyNumber: "SH-FMO-88213",
    helpline: "1800-425-9449",
  },
};

export interface TpaDirectoryEntry {
  name: string;
  description: string;
}

export const majorIndianTpas: TpaDirectoryEntry[] = [
  {
    name: "Medi Assist Insurance TPA",
    description: "One of India's largest TPAs, coordinating cashless admissions across a broad hospital network.",
  },
  {
    name: "MD India Health Insurance TPA",
    description: "Handles claim processing and network hospital coordination for several major insurers.",
  },
  {
    name: "Vidal Health Insurance TPA",
    description: "Manages cashless authorization, claims settlement, and policyholder support.",
  },
  {
    name: "Paramount Health Services & Insurance TPA",
    description: "One of India's earlier TPAs, focused on claims administration and hospital network management.",
  },
];

function series(base: number, spread: number, n = 24) {
  const arr = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    v += (Math.random() - 0.5) * spread;
    arr.push({ t: `${i}:00`, value: Math.round(v * 10) / 10 });
  }
  return arr;
}

export const vitals: VitalSeries[] = [
  {
    id: "heart-rate",
    label: "Heart Rate",
    unit: "bpm",
    color: "var(--red)",
    current: 72,
    delta: -3,
    risk: "optimal",
    data: series(72, 6),
  },
  {
    id: "blood-pressure",
    label: "Blood Pressure",
    unit: "mmHg",
    color: "var(--cyan)",
    current: 118,
    delta: 2,
    risk: "watch",
    data: series(118, 8),
  },
  {
    id: "blood-sugar",
    label: "Blood Sugar",
    unit: "mg/dL",
    color: "var(--amber)",
    current: 142,
    delta: 6,
    risk: "elevated",
    data: series(140, 10),
  },
  {
    id: "sleep",
    label: "Sleep",
    unit: "hrs",
    color: "var(--emerald)",
    current: 6.8,
    delta: 0.4,
    risk: "optimal",
    data: series(6.8, 1.2),
  },
];

export const bodySystems: BodySystem[] = [
  {
    id: "brain",
    name: "Neurological",
    status: "optimal",
    summary: "No cognitive risk markers detected. Sleep-linked recovery trending well.",
    metrics: [
      { label: "Cognitive Score", value: "94 / 100", risk: "optimal" },
      { label: "Stress Index", value: "Low", risk: "optimal" },
      { label: "Sleep Quality", value: "82%", risk: "watch" },
    ],
    lastChecked: "14 Jun 2026",
  },
  {
    id: "heart",
    name: "Cardiovascular",
    status: "watch",
    summary: "Mild elevation in resting BP. Aortic valve flow within normal range.",
    metrics: [
      { label: "Resting HR", value: "72 bpm", risk: "optimal" },
      { label: "Blood Pressure", value: "118 / 76", risk: "watch" },
      { label: "Aortic Flow", value: "Normal", risk: "optimal" },
    ],
    lastChecked: "02 Jul 2026",
  },
  {
    id: "lungs",
    name: "Respiratory",
    status: "optimal",
    summary: "Spirometry within expected range for age and activity level.",
    metrics: [
      { label: "SpO2", value: "98%", risk: "optimal" },
      { label: "FEV1", value: "3.1 L", risk: "optimal" },
      { label: "Respiratory Rate", value: "15 /min", risk: "optimal" },
    ],
    lastChecked: "02 Jul 2026",
  },
  {
    id: "kidneys",
    name: "Renal & Metabolic",
    status: "elevated",
    summary: "HbA1c trending upward over 3 years. Monitor renal filtration closely.",
    metrics: [
      { label: "eGFR", value: "76 mL/min", risk: "watch" },
      { label: "HbA1c", value: "7.2%", risk: "elevated" },
      { label: "Creatinine", value: "1.0 mg/dL", risk: "optimal" },
    ],
    lastChecked: "28 Jun 2026",
  },
  {
    id: "bones",
    name: "Musculoskeletal",
    status: "watch",
    summary: "Reduced bone density observed in lower lumbar region on last scan.",
    metrics: [
      { label: "Bone Density (T-score)", value: "-1.4", risk: "watch" },
      { label: "Vitamin D", value: "22 ng/mL", risk: "watch" },
      { label: "Calcium", value: "9.4 mg/dL", risk: "optimal" },
    ],
    lastChecked: "12 Jan 2026",
  },
];

export const timeline: TimelineEvent[] = [
  {
    id: "t1",
    date: "2026-06-14",
    type: "doctor-visit",
    title: "Cardiology Consultation",
    facility: "Fortis Hospital, Pune",
    description: "Dr. Rakesh Sharma reviewed 8-year cardiac history. AI flagged possible ACE inhibitor / statin interaction. Dosage adjusted.",
  },
  {
    id: "t2",
    date: "2026-06-02",
    type: "blood-test",
    title: "HbA1c + Lipid Panel",
    facility: "SRL Diagnostics, Bhopal",
    description: "Results uploaded directly by lab via secure API. No paper report generated.",
  },
  {
    id: "t3",
    date: "2026-03-21",
    type: "vaccination",
    title: "Influenza Booster",
    facility: "Apollo Pharmacy, Pune",
    description: "Seasonal booster administered. Added to national vaccination registry.",
  },
  {
    id: "t4",
    date: "2026-01-12",
    type: "ct-scan",
    title: "Lumbar Spine CT",
    facility: "Max Healthcare, Delhi NCR",
    description: "Mild reduced density noted in L3–L4. Recommended vitamin D supplementation.",
  },
  {
    id: "t5",
    date: "2025-09-08",
    type: "hospitalization",
    title: "Cardiac Observation (2 Days)",
    facility: "Fortis Hospital, Pune",
    description: "Admitted for chest discomfort. Discharge summary auto-uploaded, insurance claim approved in 4 hours.",
  },
  {
    id: "t6",
    date: "2025-04-30",
    type: "mri",
    title: "Brain MRI (Routine Screening)",
    facility: "Manipal Hospitals, Bengaluru",
    description: "No structural abnormalities detected.",
  },
];

export const notifications: NotificationItem[] = [
  {
    id: "n1",
    kind: "lab",
    title: "Lipid panel ready",
    detail: "SRL Diagnostics uploaded new results",
    time: "2h ago",
    risk: "watch",
  },
  {
    id: "n2",
    kind: "medicine",
    title: "Metformin 500mg",
    detail: "Next dose in 45 minutes",
    time: "Today, 8:00 PM",
  },
  {
    id: "n3",
    kind: "appointment",
    title: "Dr. Sharma: Follow-up",
    detail: "Fortis Hospital, Pune · Cardiology",
    time: "Tomorrow, 11:30 AM",
  },
  {
    id: "n4",
    kind: "message",
    title: "New message from Dr. Iyer",
    detail: "\"Your vitamin D levels look better...\"",
    time: "Yesterday",
  },
];

export const appointments: Appointment[] = [
  {
    id: "a1",
    doctor: "Dr. Rakesh Sharma",
    specialty: "Cardiology",
    facility: "Fortis Hospital, Pune",
    date: "2026-07-18",
    time: "11:30 AM",
    mode: "in-person",
    status: "upcoming",
  },
  {
    id: "a2",
    doctor: "Dr. Anjali Iyer",
    specialty: "Endocrinology",
    facility: "Aarogya Teleconsult",
    date: "2026-07-22",
    time: "6:00 PM",
    mode: "video",
    status: "upcoming",
  },
  {
    id: "a3",
    doctor: "Dr. Rakesh Sharma",
    specialty: "Cardiology",
    facility: "Fortis Hospital, Pune",
    date: "2026-06-14",
    time: "10:00 AM",
    mode: "in-person",
    status: "completed",
  },
  {
    id: "a4",
    doctor: "Dr. Meenal Kulkarni",
    specialty: "Orthopedics",
    facility: "Max Healthcare, Delhi NCR",
    date: "2026-01-12",
    time: "3:15 PM",
    mode: "in-person",
    status: "completed",
  },
];

export const reports: ReportDoc[] = [
  {
    id: "r1",
    title: "HbA1c + Lipid Panel",
    kind: "lab",
    facility: "SRL Diagnostics, Bhopal",
    date: "2026-06-02",
    sizeKb: 214,
    verified: true,
    labCategory: "lipid-panel",
  },
  {
    id: "r2",
    title: "Lumbar Spine CT Report",
    kind: "radiology",
    facility: "Max Healthcare, Delhi NCR",
    date: "2026-01-12",
    sizeKb: 4820,
    verified: true,
  },
  {
    id: "r3",
    title: "Cardiac Observation (Discharge Summary)",
    kind: "discharge",
    facility: "Fortis Hospital, Pune",
    date: "2025-09-10",
    sizeKb: 356,
    verified: true,
  },
  {
    id: "r4",
    title: "Brain MRI (Routine Screening)",
    kind: "radiology",
    facility: "Manipal Hospitals, Bengaluru",
    date: "2025-04-30",
    sizeKb: 6120,
    verified: true,
  },
  {
    id: "r5",
    title: "Digital Prescription (Metformin, Atorvastatin)",
    kind: "prescription",
    facility: "Dr. Rakesh Sharma, Fortis Pune",
    date: "2026-06-14",
    sizeKb: 88,
    verified: true,
  },
];

export const labResults: LabResult[] = [
  { id: "l1", test: "HbA1c", panel: "Diabetes Panel", value: 7.2, unit: "%", refLow: 4, refHigh: 5.6, risk: "elevated", date: "2026-06-02" },
  { id: "l2", test: "Fasting Glucose", panel: "Diabetes Panel", value: 142, unit: "mg/dL", refLow: 70, refHigh: 100, risk: "elevated", date: "2026-06-02" },
  { id: "l3", test: "LDL Cholesterol", panel: "Lipid Panel", value: 118, unit: "mg/dL", refLow: 0, refHigh: 100, risk: "watch", date: "2026-06-02" },
  { id: "l4", test: "HDL Cholesterol", panel: "Lipid Panel", value: 52, unit: "mg/dL", refLow: 40, refHigh: 60, risk: "optimal", date: "2026-06-02" },
  { id: "l5", test: "Triglycerides", panel: "Lipid Panel", value: 148, unit: "mg/dL", refLow: 0, refHigh: 150, risk: "optimal", date: "2026-06-02" },
  { id: "l6", test: "Creatinine", panel: "Renal Panel", value: 1.0, unit: "mg/dL", refLow: 0.6, refHigh: 1.2, risk: "optimal", date: "2026-06-28" },
  { id: "l7", test: "eGFR", panel: "Renal Panel", value: 76, unit: "mL/min", refLow: 90, refHigh: 120, risk: "watch", date: "2026-06-28" },
  { id: "l8", test: "Vitamin D (25-OH)", panel: "Bone Health", value: 22, unit: "ng/mL", refLow: 30, refHigh: 100, risk: "watch", date: "2026-01-12" },
];

export const prescriptions: Prescription[] = [
  {
    id: "p1",
    drug: "Metformin",
    dose: "500mg",
    frequency: "Twice daily, after meals",
    prescribedBy: "Dr. Anjali Iyer",
    qualification: "MBBS, MD (Endocrinology)",
    registrationId: "MCI-KA-51267",
    facility: "Aarogya Teleconsult",
    startDate: "2025-03-10",
    status: "active",
    adherence: 92,
  },
  {
    id: "p2",
    drug: "Atorvastatin",
    dose: "10mg",
    frequency: "Once daily, at night",
    prescribedBy: "Dr. Rakesh Sharma",
    qualification: "MBBS, MD (Cardiology), DM (Cardiology)",
    registrationId: "MCI-MH-48213",
    facility: "Fortis Hospital, Pune",
    startDate: "2026-06-14",
    status: "active",
    adherence: 88,
  },
  {
    id: "p3",
    drug: "Vitamin D3",
    dose: "60,000 IU",
    frequency: "Once weekly",
    prescribedBy: "Dr. Meenal Kulkarni",
    qualification: "MBBS, MS (Orthopedics)",
    registrationId: "MCI-DL-33489",
    facility: "Max Healthcare, Delhi NCR",
    startDate: "2026-01-14",
    status: "refill-due",
    adherence: 74,
  },
  {
    id: "p4",
    drug: "Azithromycin",
    dose: "500mg",
    frequency: "Once daily",
    prescribedBy: "Dr. Rakesh Sharma",
    qualification: "MBBS, MD (Cardiology), DM (Cardiology)",
    registrationId: "MCI-MH-48213",
    facility: "Fortis Hospital, Pune",
    startDate: "2025-09-08",
    status: "completed",
    adherence: 100,
  },
];

export const insuranceClaims: InsuranceClaim[] = [
  { id: "c1", claimNo: "SH-2025-88213", reason: "Cardiac observation (2 days)", amount: 84500, status: "approved", date: "2025-09-12" },
  { id: "c2", claimNo: "SH-2026-11042", reason: "Lumbar CT scan", amount: 6200, status: "approved", date: "2026-01-13" },
  { id: "c3", claimNo: "SH-2026-30981", reason: "Cardiology consultation", amount: 1500, status: "processing", date: "2026-06-15" },
];

export const emergencyContacts: EmergencyContact[] = [
  { id: "e1", name: "Arjun Kulkarni", relation: "Spouse", phone: "+91 98220 41XXX", priority: 1 },
  { id: "e2", name: "Dr. Rakesh Sharma", relation: "Primary Cardiologist", phone: "+91 98450 22XXX", priority: 2 },
  { id: "e3", name: "Sunita Kulkarni", relation: "Mother", phone: "+91 98220 55XXX", priority: 3 },
  { id: "e4", name: "Fortis Hospital Ambulance", relation: "Emergency Services", phone: "1066", priority: 4 },
];

export const hospitalBeds: HospitalBedAvailability[] = [
  {
    id: "h1",
    name: "Fortis Hospital, Pune",
    city: "Pune",
    distanceKm: 3.2,
    avgWaitMinutes: 45,
    emergencyBeds: 4,
    icuBeds: 1,
    generalBeds: 9,
    emergencyCapacity: 6,
    icuCapacity: 3,
    generalCapacity: 13,
  },
  {
    id: "h2",
    name: "Max Healthcare, Delhi NCR",
    city: "Delhi NCR",
    distanceKm: 6.8,
    avgWaitMinutes: 60,
    emergencyBeds: 2,
    icuBeds: 0,
    generalBeds: 5,
    emergencyCapacity: 4,
    icuCapacity: 2,
    generalCapacity: 8,
  },
  {
    id: "h3",
    name: "Manipal Hospitals, Bengaluru",
    city: "Bengaluru",
    distanceKm: 9.5,
    avgWaitMinutes: 35,
    emergencyBeds: 6,
    icuBeds: 3,
    generalBeds: 12,
    emergencyCapacity: 8,
    icuCapacity: 5,
    generalCapacity: 15,
  },
  {
    id: "h4",
    name: "Apollo Hospitals, Chennai",
    city: "Chennai",
    distanceKm: 12.1,
    avgWaitMinutes: 50,
    emergencyBeds: 3,
    icuBeds: 2,
    generalBeds: 7,
    emergencyCapacity: 5,
    icuCapacity: 4,
    generalCapacity: 10,
  },
  {
    id: "h5",
    name: "AIIMS, New Delhi",
    city: "New Delhi",
    distanceKm: 14.7,
    avgWaitMinutes: 90,
    emergencyBeds: 0,
    icuBeds: 0,
    generalBeds: 2,
    emergencyCapacity: 3,
    icuCapacity: 2,
    generalCapacity: 6,
  },
];
