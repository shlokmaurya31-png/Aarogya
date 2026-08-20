export type RiskLevel = "optimal" | "watch" | "elevated" | "critical";

export type SystemId = "brain" | "heart" | "lungs" | "kidneys" | "bones";

export interface SystemMetric {
  label: string;
  value: string;
  risk: RiskLevel;
}

export interface BodySystem {
  id: SystemId;
  name: string;
  status: RiskLevel;
  summary: string;
  metrics: SystemMetric[];
  lastChecked: string;
}

export interface VitalPoint {
  t: string;
  value: number;
}

export interface VitalSeries {
  id: string;
  label: string;
  unit: string;
  color: string;
  current: number;
  delta: number;
  risk: RiskLevel;
  data: VitalPoint[];
}

export type TimelineEventType =
  | "blood-test"
  | "ct-scan"
  | "mri"
  | "vaccination"
  | "doctor-visit"
  | "hospitalization";

export interface TimelineEvent {
  id: string;
  date: string;
  type: TimelineEventType;
  title: string;
  facility: string;
  description: string;
}

export interface TpaProfile {
  name: string;
  healthCardId: string;
  policyNumber: string;
  helpline: string;
}

export interface PatientProfile {
  name: string;
  patientId: string;
  hospitalId: string;
  age: number;
  gender: string;
  height: string;
  weight: string;
  bloodGroup: string;
  allergies: string[];
  insurance: string;
  emergencyContact: string;
  abhaNumber: string;
  aadhaarLinked: boolean;
  ayushmanBharat: "eligible" | "enrolled" | "not-eligible";
  avatarInitials: string;
  tpa: TpaProfile;
}

export interface NotificationItem {
  id: string;
  kind: "lab" | "medicine" | "message" | "appointment";
  title: string;
  detail: string;
  time: string;
  risk?: RiskLevel;
}

export type UserMode = "patient" | "doctor";

export type NavId =
  | "overview"
  | "appointments"
  | "history"
  | "reports"
  | "labs"
  | "prescriptions"
  | "insurance"
  | "emergency";

export type PatientNavId = "home" | "appointments" | "medicines" | "reports" | "insurance" | "emergency";

export type AppointmentStatus = "upcoming" | "completed" | "cancelled";
export type AppointmentMode = "in-person" | "video";

export interface Appointment {
  id: string;
  doctor: string;
  specialty: string;
  facility: string;
  date: string;
  time: string;
  mode: AppointmentMode;
  status: AppointmentStatus;
}

export type ReportKind = "lab" | "radiology" | "discharge" | "prescription";

export type LabReportCategory =
  | "routine-blood-panel"
  | "lipid-panel"
  | "thyroid-panel"
  | "diabetes-profile"
  | "liver-function-test"
  | "kidney-function-test"
  | "cardiac-risk-markers"
  | "vitamin-panel"
  | "hormone-panel"
  | "iron-studies"
  | "urinalysis"
  | "biopsy-pathology"
  | "microbiology-culture"
  | "infectious-disease-serology"
  | "molecular-pcr"
  | "toxicology-drug-screen"
  | "coagulation-panel"
  | "immunology-autoimmune";

export interface ReportDoc {
  id: string;
  title: string;
  kind: ReportKind;
  facility: string;
  date: string;
  sizeKb: number;
  verified: boolean;
  labCategory?: LabReportCategory;
  patientRef?: string;
}

export interface LabResult {
  id: string;
  test: string;
  panel: string;
  value: number;
  unit: string;
  refLow: number;
  refHigh: number;
  risk: RiskLevel;
  date: string;
}

export type PrescriptionStatus = "active" | "completed" | "refill-due";

export interface Prescription {
  id: string;
  drug: string;
  dose: string;
  frequency: string;
  prescribedBy: string;
  qualification: string;
  registrationId: string;
  facility: string;
  startDate: string;
  status: PrescriptionStatus;
  adherence: number;
}

export type ClaimStatus = "approved" | "processing" | "submitted" | "rejected";

export interface InsuranceClaim {
  id: string;
  claimNo: string;
  reason: string;
  amount: number;
  status: ClaimStatus;
  date: string;
}

export interface EmergencyContact {
  id: string;
  name: string;
  relation: string;
  phone: string;
  priority: number;
}

export type BedCategory = "emergency" | "icu" | "general";

export interface HospitalBedAvailability {
  id: string;
  name: string;
  city: string;
  distanceKm: number;
  avgWaitMinutes: number;
  emergencyBeds: number;
  icuBeds: number;
  generalBeds: number;
  emergencyCapacity: number;
  icuCapacity: number;
  generalCapacity: number;
}

export type ShiftId = "morning" | "evening" | "night";

export type StaffRole = "nurse" | "technician" | "ward-boy" | "receptionist" | "pharmacist" | "housekeeping";

export interface HospitalDoctorEntry {
  id: string;
  name: string;
  specialty: string;
  qualification: string;
  registrationId: string;
  shift: ShiftId;
  onDuty: boolean;
  phone: string;
  department: string;
  yearsExperience: number;
  consultationFee: number;
}

export interface HospitalStaffMember {
  id: string;
  name: string;
  role: StaffRole;
  ward: string;
  shift: ShiftId;
  onDuty: boolean;
  phone: string;
  employeeId: string;
  department: string;
}

export type AdmissionStatus = "admitted" | "critical" | "discharged";

export interface VitalReading {
  bp: string;
  heartRate: number;
  temperatureF: number;
  spo2: number;
  recordedAt: string;
}

export interface ClinicalNote {
  id: string;
  authorName: string;
  authorRole: "doctor" | "nurse";
  timestamp: string;
  text: string;
}

export interface HospitalAdmission {
  id: string;
  patientName: string;
  age: number;
  gender: string;
  ward: BedCategory;
  bedLabel: string;
  doctorId: string;
  doctorName: string;
  diagnosis: string;
  diagnosisCode: string;
  admittedAt: string;
  status: AdmissionStatus;
  dischargedAt?: string;
  vitals: VitalReading;
  notes: ClinicalNote[];
  insuranceProvider: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
}

export interface BedBooking {
  id: string;
  hospitalId: string;
  hospitalName: string;
  category: BedCategory;
  patientName: string;
  confirmationCode: string;
  bookedAt: string;
}

export type AuthRole = "patient" | "doctor" | "lab" | "hospital" | "admin" | "staff";

export type VerificationRole = "doctor" | "lab" | "hospital";

export type VerificationStatus = "pending" | "verified" | "rejected";

export interface AuthUser {
  id: string;
  role: AuthRole;
  name: string;
  email: string;
  phone?: string;
  avatarInitials: string;
  specialty?: string;
  registrationId?: string;
  facility?: string;
  city?: string;
  verificationStatus?: VerificationStatus;
}

export interface PatientOnboardingInput {
  age: number;
  gender: string;
  height: string;
  weight: string;
  bloodGroup: string;
  allergies: string[];
  emergencyContactName: string;
  emergencyContactPhone: string;
  insuranceProvider?: string;
}

export interface VerificationApplication {
  id: string;
  role: VerificationRole;
  name: string;
  email: string;
  specialty?: string;
  registrationId: string;
  facility: string;
  proofFileName: string;
  submittedAt: string;
  status: VerificationStatus;
}

export interface AdminStaffAccount {
  id: string;
  name: string;
  email: string;
  password: string;
  createdAt: string;
}
